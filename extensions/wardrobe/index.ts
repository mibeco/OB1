/**
 * Wardrobe System MCP Server (Remote Edge Function)
 *
 * The structured / quantitative layer of a personal sartorial system:
 * - Inventory of garments and accessories (items)
 * - A daily wear ledger with audience tags (wear_events + wear_event_items)
 * - Saved, known-good outfit combinations (outfits + outfit_items)
 * - Rotation analytics: dormant items, over-worn items, review cadence
 *
 * The qualitative / wiki layer (style identity, registers, principles, person
 * notes) deliberately lives in the base Open Brain `thoughts` store via
 * capture_thought / search_thoughts — NOT here. This server never touches the
 * thoughts table.
 *
 * Every formulated outfit (a recommendation option, a saved outfit, a wear
 * event) carries two free-text tags: `register_note` (the owner's personal
 * composite, which bundles lineage with a formality band) and `paradigm_note`
 * (Simon Crompton's lineage-only taxonomy — British country, American prep,
 * Italian smooth, Workwear, Sportswear). They are prose, not enums, so mixing,
 * ambiguity and deliberate collisions can be described rather than forced into
 * one bucket. The definitions live in the thoughts store; see migration 003.
 *
 * Conventions mirror extensions/professional-crm (tool registration, JSON
 * responses, error handling) and the base open-brain-mcp server (JSON-RPC
 * auth envelope, CORS, Accept-header patch). Tools use the `wd_` prefix.
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const WD_ACCESS_KEY = Deno.env.get("WD_ACCESS_KEY");

// --- Shared helpers ------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

/**
 * Today's date as YYYY-MM-DD in America/Los_Angeles. Used for wear-log
 * defaults so a wearing logged late in the evening doesn't roll into
 * "tomorrow" under UTC. en-CA formats as an ISO-style YYYY-MM-DD.
 */
function todayLA(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date());
}

function ok(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

const ITEM_COLUMNS =
  "id, name, category, subcategory, brand, color, color_family, fabric, weight, seasons, register, formality, size, fit_notes, condition, status, acquired_on, acquired_from, price_paid, retired_on, pairing_notes, notes, source_url, source_captured_on, created_at, updated_at";

/**
 * The same list plus `source_spec` — the captured product-page markdown
 * (composition, weight, construction, care, size chart). It is deliberately
 * absent from ITEM_COLUMNS: a few hundred items each carrying a page of prose
 * would make every wd_get_inventory read enormous, for text nobody filters on.
 * Single-item reads and writes return it; list reads do not.
 */
const ITEM_COLUMNS_FULL = `${ITEM_COLUMNS}, source_spec`;

const STATS_COLUMNS =
  "id, total_wears, last_worn, days_since_worn, wears_30d, wears_90d, total_recommendations, last_recommended_for, days_since_recommended";

/**
 * Per-item wear and recommendation stats, as served by the `v_item_stats`
 * view. Counts are always numbers — never null. Dates and the day-counts
 * derived from them stay nullable, because "never worn" genuinely has no date
 * and 0 would be a lie there.
 */
type ItemStats = {
  total_wears: number;
  last_worn: string | null;
  days_since_worn: number | null;
  wears_30d: number;
  wears_90d: number;
  total_recommendations: number;
  last_recommended_for: string | null;
  days_since_recommended: number | null;
};

/**
 * Coerce a `v_item_stats` row into `ItemStats`, zero-filling the counts.
 *
 * The view already coalesces, so this is the second belt: a null count that
 * reached a caller would read as "unknown" and invite inference from
 * `condition` or `acquired_on` — the exact failure these fields exist to
 * close. An explicit 0 is a claim the database is making.
 */
function normalizeStats(row: Partial<ItemStats> | null | undefined): ItemStats {
  return {
    total_wears: row?.total_wears ?? 0,
    last_worn: row?.last_worn ?? null,
    days_since_worn: row?.days_since_worn ?? null,
    wears_30d: row?.wears_30d ?? 0,
    wears_90d: row?.wears_90d ?? 0,
    total_recommendations: row?.total_recommendations ?? 0,
    last_recommended_for: row?.last_recommended_for ?? null,
    days_since_recommended: row?.days_since_recommended ?? null,
  };
}

/**
 * Load stats for the whole catalogue in one grouped query, keyed by item id.
 * Never call this per item inside a loop — that is what it exists to avoid.
 *
 * It reads the view unfiltered rather than restricting to the page of items
 * being returned. Two reasons: some `wd_get_inventory` filters (season,
 * color_family, weight) don't exist on the stats view, so restating them here
 * would put the same filter logic in two places and let it drift; and a
 * 250-uuid `in(...)` list pushes the PostgREST request line toward the proxy's
 * header limit. The catalogue is one person's wardrobe — a few hundred narrow
 * rows — so reading all of it is cheaper than either alternative.
 */
async function fetchStatsMap(
  supabase: SupabaseClient,
): Promise<Map<string, ItemStats>> {
  const { data, error } = await supabase
    .from("v_item_stats")
    .select(STATS_COLUMNS)
    .range(0, 9999);
  if (error) throw new Error(`Failed to load item stats: ${error.message}`);

  const map = new Map<string, ItemStats>();
  for (const row of data || []) map.set(row.id, normalizeStats(row));
  return map;
}

type ItemRow = { id: string; name: string; category: string; status: string };

type ResolveResult =
  | { ref: string; status: "ok"; item: ItemRow }
  | { ref: string; status: "ambiguous"; candidates: ItemRow[] }
  | { ref: string; status: "none" };

/**
 * Resolve a single item reference — either a UUID (`item_id`) or a
 * case-insensitive substring (`name_match`) — to exactly one item.
 * On an ambiguous name match we return the candidates instead of guessing.
 */
async function resolveItemRef(
  supabase: SupabaseClient,
  ref: string,
): Promise<ResolveResult> {
  const trimmed = ref.trim();

  if (isUuid(trimmed)) {
    const { data, error } = await supabase
      .from("items")
      .select("id, name, category, status")
      .eq("id", trimmed)
      .maybeSingle();
    if (error) throw new Error(`Lookup failed for "${ref}": ${error.message}`);
    return data
      ? { ref, status: "ok", item: data as ItemRow }
      : { ref, status: "none" };
  }

  const { data, error } = await supabase
    .from("items")
    .select("id, name, category, status")
    .ilike("name", `%${trimmed}%`)
    .order("name", { ascending: true });
  if (error) throw new Error(`Lookup failed for "${ref}": ${error.message}`);

  const rows = (data || []) as ItemRow[];
  if (rows.length === 0) return { ref, status: "none" };
  if (rows.length === 1) return { ref, status: "ok", item: rows[0] };

  // A single exact (case-insensitive) name match disambiguates a substring
  // collision (e.g. "tan chinos" vs "tan chinos, cropped").
  const exact = rows.filter(
    (r) => r.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (exact.length === 1) return { ref, status: "ok", item: exact[0] };

  return { ref, status: "ambiguous", candidates: rows };
}

/**
 * Resolve a batch of refs. Returns the resolved items in input order plus a
 * list of problems (ambiguous / not found). Callers MUST check `problems`
 * before writing anything so we never partially log.
 */
async function resolveItemRefs(supabase: SupabaseClient, refs: string[]) {
  const results = await Promise.all(
    refs.map((r) => resolveItemRef(supabase, r)),
  );
  const resolved = results.filter(
    (r): r is Extract<ResolveResult, { status: "ok" }> => r.status === "ok",
  );
  const problems = results.filter((r) => r.status !== "ok");
  return { results, resolved, problems };
}

function problemsPayload(
  problems: Exclude<ResolveResult, { status: "ok" }>[],
) {
  return problems.map((p) =>
    p.status === "ambiguous"
      ? {
        ref: p.ref,
        problem: "ambiguous_name_match",
        candidates: p.candidates.map((c) => ({
          id: c.id,
          name: c.name,
          category: c.category,
          status: c.status,
        })),
      }
      : { ref: p.ref, problem: "no_match" }
  );
}

// --- Photos --------------------------------------------------------------

/**
 * Images live in a private Supabase Storage bucket; nothing is publicly
 * readable. Every URL handed back to a caller is minted here, with the service
 * role, and expires.
 */
const PHOTO_BUCKET = "wardrobe-photos";
const SIGNED_URL_TTL_SECONDS = 3600;

const PHOTO_COLUMNS =
  "id, item_id, event_id, kind, shot_type, storage_path, source_url, source_domain, caption, captured_on, content_hash, width_px, height_px, bytes, mime_type, color_authoritative, created_at";

/** The only formats accepted, and the extension each is stored under. */
const PHOTO_MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const PHOTO_FETCH_TIMEOUT_MS = 10_000;

/**
 * A plain desktop browser UA. Retailer CDNs routinely 403 a bare fetch agent,
 * and the alternative is that the as-new baseline simply never gets captured.
 */
const PHOTO_FETCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sniff the container from magic bytes. Used when the response carries no
 * Content-Type, or a useless one (`application/octet-stream` is common on
 * misconfigured CDNs) — the header is a claim, the bytes are the fact.
 */
function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  // ISOBMFF: ....ftyp<brand>
  if (
    b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  ) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

type Dimensions = { width: number; height: number };

const be32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le24 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

function pngDimensions(b: Uint8Array): Dimensions | null {
  // IHDR is mandated to be the first chunk: width/height at fixed offsets.
  if (b.length < 24) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function jpegDimensions(b: Uint8Array): Dimensions | null {
  // Walk the marker segments to the first Start-Of-Frame, which is the only
  // place the dimensions are stated. Progressive JPEGs use SOF2, and a file
  // with EXIF thumbnails has other segments in front, so this can't be a
  // fixed offset.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]; }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const isSof = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: be16(b, i + 5), width: be16(b, i + 7) };
    const len = be16(b, i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpDimensions(b: Uint8Array): Dimensions | null {
  if (b.length < 30) return null;
  const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
  const d = 20; // start of the first chunk's payload
  if (tag === "VP8 ") {
    // Lossy: 3-byte frame tag, then the 0x9D012A sync code, then 14-bit dims.
    if (!(b[d + 3] === 0x9d && b[d + 4] === 0x01 && b[d + 5] === 0x2a)) return null;
    return { width: le16(b, d + 6) & 0x3fff, height: le16(b, d + 8) & 0x3fff };
  }
  if (tag === "VP8L") {
    if (b[d] !== 0x2f) return null;
    const bits = b[d + 1] | (b[d + 2] << 8) | (b[d + 3] << 16) | (b[d + 4] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (tag === "VP8X") {
    // Extended (animation / alpha): canvas size, minus one, 24-bit LE.
    return { width: le24(b, d + 4) + 1, height: le24(b, d + 7) + 1 };
  }
  return null;
}

function avifDimensions(b: Uint8Array): Dimensions | null {
  // ISOBMFF proper would mean walking meta -> iprp -> ipco. Scanning for the
  // `ispe` boxes and taking the largest gets the primary image without a box
  // parser, and skips the embedded thumbnail, which is the only thing the
  // shortcut could otherwise pick up.
  let best: Dimensions | null = null;
  for (let i = 0; i + 16 <= b.length; i++) {
    // 'ispe', then a 4-byte version/flags word, then width and height.
    if (b[i] !== 0x69 || b[i + 1] !== 0x73 || b[i + 2] !== 0x70 || b[i + 3] !== 0x65) {
      continue;
    }
    const width = be32(b, i + 8);
    const height = be32(b, i + 12);
    if (!width || !height || width > 65535 || height > 65535) continue;
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

/**
 * Intrinsic pixel dimensions, read from the container headers. Returns null
 * rather than guessing on an encoding it can't parse — a null reads as
 * "not measured", where a wrong number would be taken as measured.
 */
function readImageDimensions(bytes: Uint8Array, mime: string): Dimensions | null {
  try {
    switch (mime) {
      case "image/png":  return pngDimensions(bytes);
      case "image/jpeg": return jpegDimensions(bytes);
      case "image/webp": return webpDimensions(bytes);
      case "image/avif": return avifDimensions(bytes);
    }
  } catch {
    // A truncated or malformed header is a null, not a throw.
  }
  return null;
}

/**
 * Shopify serves every image off one original through query parameters, and
 * product-page markup points at a thumbnail (`?width=320&height=400&crop=center`).
 * Storing that would defeat the whole point of an as-new baseline: 320px of a
 * garment records nothing about weave or nap. Strip the crop and the height —
 * height plus crop forces a fixed aspect and would letterbox the result — and
 * ask for 2048 on the long edge.
 *
 * Returns null for anything that isn't Shopify: other CDNs have their own
 * parameter grammars, and a wrong guess silently returns the wrong crop.
 */
function upgradeShopifyUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const isShopify = host === "cdn.shopify.com" ||
    host.endsWith(".shopifycdn.com") ||
    host.endsWith(".myshopify.com") ||
    u.pathname.includes("/cdn/shop/");
  if (!isShopify) return null;

  const upgraded = new URL(u.toString());
  upgraded.searchParams.delete("height");
  upgraded.searchParams.delete("crop");
  upgraded.searchParams.set("width", "2048");
  return upgraded.toString() === u.toString() ? null : upgraded.toString();
}

type FetchedImage = {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  url: string;
  width_upgraded: boolean;
};

type FetchFailure = { failed: true; message: string; url: string; status?: number };

/** One attempt. No retry lives here — the caller owns the fallback policy. */
async function fetchImageOnce(
  url: string,
): Promise<{ bytes: Uint8Array; mime: string } | FetchFailure> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": PHOTO_FETCH_UA, Accept: "image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { failed: true, url, message: `Fetch failed: ${reason}` };
  }

  if (!res.ok) {
    await res.body?.cancel();
    return {
      failed: true,
      url,
      status: res.status,
      message: `Fetch returned HTTP ${res.status} ${res.statusText}`.trim(),
    };
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PHOTO_MAX_BYTES) {
    await res.body?.cancel();
    return {
      failed: true,
      url,
      status: res.status,
      message: `Image is ${declared} bytes; the limit is ${PHOTO_MAX_BYTES}.`,
    };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > PHOTO_MAX_BYTES) {
    return {
      failed: true,
      url,
      status: res.status,
      message: `Image is ${bytes.byteLength} bytes; the limit is ${PHOTO_MAX_BYTES}.`,
    };
  }
  if (bytes.byteLength === 0) {
    return { failed: true, url, status: res.status, message: "Response body was empty." };
  }

  // The header is a claim; prefer it, but fall back to the bytes when it is
  // missing or generic, and let the caller reject on the result either way.
  const header = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const mime = PHOTO_MIME_EXT[header] ? header : (sniffImageMime(bytes) || header || "");
  return { bytes, mime };
}

/**
 * Fetch an image server-side. Bytes never cross the MCP protocol: the caller
 * supplies a URL and the function downloads it, because the MCP client has no
 * network egress to retailer CDNs and passing binary through the protocol is
 * wasteful.
 *
 * Shopify URLs are retried once at full width, then once unmodified. Nothing
 * else is retried.
 */
async function fetchImageForStorage(
  rawUrl: string,
): Promise<FetchedImage | FetchFailure> {
  const upgraded = upgradeShopifyUrl(rawUrl);
  const attempts: { url: string; upgraded: boolean }[] = upgraded
    ? [{ url: upgraded, upgraded: true }, { url: rawUrl, upgraded: false }]
    : [{ url: rawUrl, upgraded: false }];

  let lastFailure: FetchFailure | null = null;
  for (const attempt of attempts) {
    const res = await fetchImageOnce(attempt.url);
    if ("failed" in res) {
      lastFailure = res;
      continue;
    }
    const ext = PHOTO_MIME_EXT[res.mime];
    if (!ext) {
      return {
        failed: true,
        url: attempt.url,
        message: `Unsupported content type "${res.mime || "unknown"}". Accepted: ${
          Object.keys(PHOTO_MIME_EXT).join(", ")
        }.`,
      };
    }
    return {
      bytes: res.bytes,
      mime: res.mime,
      ext,
      url: attempt.url,
      width_upgraded: attempt.upgraded,
    };
  }
  return lastFailure!;
}

function sourceDomainOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

type PhotoSubject =
  | { kind: "item"; id: string; name: string }
  | { kind: "event"; id: string; worn_on: string };

/**
 * Resolve the one subject a photo hangs off — an item or a wear event, never
 * both. `item_ref` accepts a UUID or a case-insensitive name substring and is
 * resolved exactly the way wd_log_wear resolves its refs: on an ambiguous or
 * missing ref the candidates come back and NOTHING is written.
 */
async function resolvePhotoSubject(
  supabase: SupabaseClient,
  itemRef?: string,
  eventId?: string,
): Promise<{ subject: PhotoSubject } | { error: ReturnType<typeof ok> }> {
  if (itemRef && eventId) {
    return {
      error: ok({
        success: false,
        message: "Provide exactly one subject: item_ref or event_id, not both.",
      }),
    };
  }
  if (!itemRef && !eventId) {
    return {
      error: ok({
        success: false,
        message: "Provide a subject: item_ref (UUID or name substring) or event_id.",
      }),
    };
  }

  if (itemRef) {
    const res = await resolveItemRef(supabase, itemRef);
    if (res.status === "ok") {
      return { subject: { kind: "item", id: res.item.id, name: res.item.name } };
    }
    return {
      error: ok({
        success: false,
        message: res.status === "ambiguous"
          ? `Ambiguous item reference "${itemRef}" — nothing was written. Specify the UUID.`
          : `No item matched "${itemRef}" — nothing was written.`,
        unresolved: problemsPayload([res]),
      }),
    };
  }

  if (!isUuid(eventId!)) {
    return {
      error: ok({ success: false, message: `event_id must be a UUID; got "${eventId}".` }),
    };
  }
  const { data, error } = await supabase
    .from("wear_events")
    .select("id, worn_on")
    .eq("id", eventId!)
    .maybeSingle();
  if (error) throw new Error(`Lookup failed for event ${eventId}: ${error.message}`);
  if (!data) {
    return {
      error: ok({ success: false, message: `No wear event with id ${eventId}.` }),
    };
  }
  return { subject: { kind: "event", id: data.id, worn_on: data.worn_on } };
}

/** Mint short-lived signed URLs for a batch of object keys, keyed by path. */
async function signPhotoPaths(
  supabase: SupabaseClient,
  paths: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (paths.length === 0) return out;
  const { data, error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
  if (error) throw new Error(`Failed to sign photo URLs: ${error.message}`);
  for (const row of data || []) out.set(row.path ?? "", row.signedUrl ?? null);
  return out;
}

// --- Rotation eligibility ------------------------------------------------
//
// The 7-day recency rule for shirts, tees and socks, computed in ONE place.
// `computeEligibility` is the single implementation: `wd_eligibility` returns
// its result verbatim, and `wd_log_recommendation` re-runs it at write time
// and refuses to write any option that contains a blocked item. The assistant
// reads buckets from this result; it never derives them.
//
// The rule, in its own words. From the style profile:
//   "7-day recency (shirts, socks, tees only): never recommend the same shirt,
//    sock, or tee within a rolling 7 days — check both the wear log and any
//    locked/planned capsule. Pants, outerwear, and shoes are exempt."
// From the standing corrections:
//   "Recommended-but-unworn suppresses re-proposing the same configuration,
//    not the item; never applies to items carrying an under-rotation flag."
//   "`total_wears: 0` means no logged wear since cataloguing, not never worn."
// Nothing beyond those clauses is encoded here.

const ELIGIBILITY_WINDOW_DAYS = 7;
const ELIGIBILITY_DEFAULT_DORMANCY_DAYS = 30;
const ELIGIBILITY_RUN_VERSION = 1;

/**
 * Minutes a `wd_eligibility` run stays fresh enough to authorise a write.
 * Overridable via env only so the staleness path can be exercised in a test;
 * production leaves it at the default.
 */
const ELIGIBILITY_RUN_TTL_MINUTES = Number(
  Deno.env.get("WD_ELIGIBILITY_TTL_MINUTES") ?? 30,
);

/**
 * HMAC key for run tokens. A dedicated function secret, deliberately NOT the
 * service role key: the token only needs to prove "this server computed
 * eligibility for this date at this time", and reusing a credential that can
 * do everything for a signature that needs to do one thing is how keys leak.
 */
const WD_ELIGIBILITY_SECRET = Deno.env.get("WD_ELIGIBILITY_SECRET");

/** Categories governed outright (when `status = 'active'`). */
const GOVERNED_CATEGORIES = ["shirt", "tee", "socks"];

/**
 * Loopwheel / slub tees and tanks are catalogued under `knitwear` in this
 * database, so knitwear is governed by subcategory: `subcategory ILIKE ANY
 * ('%tee%', '%t-shirt%', '%tank%')`. Sweaters, hoodies, henleys and vests
 * stay exempt.
 */
const GOVERNED_KNITWEAR_SUBCATEGORY_TERMS = ["tee", "t-shirt", "tank"];

/** What `wd_eligibility` evaluates when `categories` is omitted. */
const DEFAULT_ELIGIBILITY_CATEGORIES = [...GOVERNED_CATEGORIES, "knitwear"];

/**
 * A recommendation with one of these outcomes became a wear, and `last_worn`
 * already covers it. Only the others count toward the configuration flag.
 */
const WORN_OUTCOMES = new Set(["worn_as_proposed", "worn_with_deviation"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLiteralDate(s: string): boolean {
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * Whole days from `b` to `a`. Both are literal YYYY-MM-DD, so Date.parse
 * places them at UTC midnight and the difference is exact — same trick as
 * `wd_recommendation_history`.
 */
function daysBetween(a: string, b: string): number {
  return Math.floor((Date.parse(a) - Date.parse(b)) / 86400000);
}

type EligibilityItemRow = {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  status: string;
};

/**
 * The governed-set rule, exactly as stated: active, and either a shirt / tee /
 * sock by category, or knitwear whose subcategory reads as a tee or tank.
 */
function isGoverned(item: EligibilityItemRow): boolean {
  if (item.status !== "active") return false;
  if (GOVERNED_CATEGORIES.includes(item.category)) return true;
  if (item.category === "knitwear" && item.subcategory) {
    const sub = item.subcategory.toLowerCase();
    return GOVERNED_KNITWEAR_SUBCATEGORY_TERMS.some((t) => sub.includes(t));
  }
  return false;
}

type EligibilityBucket =
  | "blocked_worn"
  | "boundary"
  | "config_flag"
  | "eligible"
  | "exempt";

/** One (recommendation, option) an item appeared in and was not worn from. */
type UnwornConfiguration = {
  recommendation_id: string;
  option_index: number;
  label: string | null;
  recommended_for: string;
  days_since_recommended: number;
  outcome: string;
  other_items: string[];
};

type EligibilityItem = {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  governed: boolean;
  bucket: EligibilityBucket;
  reason: string;
  total_wears: number;
  last_worn: string | null;
  days_since_worn: number | null;
  last_recommended_for: string | null;
  days_since_recommended: number | null;
  last_recommendation_id: string | null;
  under_rotation: boolean;
  never_worn: boolean;
  never_recommended: boolean;
  unworn_configurations: UnwornConfiguration[];
};

type EligibilityResult = {
  run_id: string;
  computed_at: string;
  for_date: string;
  window_days: number;
  dormancy_days: number;
  governed_categories: string[];
  governed_knitwear_subcategory_terms: string[];
  requested_categories: string[];
  counts: Record<EligibilityBucket, number>;
  blocked_worn: EligibilityItem[];
  boundary: EligibilityItem[];
  config_flag: EligibilityItem[];
  eligible: EligibilityItem[];
  exempt: EligibilityItem[];
  never_worn: string[];
  never_recommended: string[];
};

/** Shape of the nested PostgREST read in `computeEligibility`. */
type RecommendationTreeRow = {
  id: string;
  recommended_for: string;
  outcome: string;
  created_at: string;
  recommendation_options: {
    id: string;
    option_index: number;
    label: string | null;
    recommendation_option_items: {
      item_id: string;
      items: { id: string; name: string } | null;
    }[];
  }[];
};

type RecEntry = Omit<UnwornConfiguration, "days_since_recommended"> & {
  created_at: string;
};

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name);

/**
 * Compute rotation eligibility for every active item in `categories`, as of
 * `forDate` (the date the outfit is FOR — literal, no timezone conversion).
 *
 * Reads: the items, the same `v_item_stats` map the inventory tools use (so
 * `total_wears` / `last_worn` agree with `wd_get_inventory` by construction),
 * and the full recommendation tree (recommendations → options → items) so a
 * flagged configuration can name the other items in that option. Three round
 * trips regardless of wardrobe size.
 *
 * Bucketing is evaluated in order, first match wins:
 *   1. blocked_worn — governed, worn 0..6 days before forDate
 *   2. boundary     — governed, worn exactly 7 days before forDate
 *   3. config_flag  — governed, an unworn recommendation 0..6 days before
 *                     forDate, and NOT under rotation
 *   4. eligible     — everything else governed
 *   5. exempt       — not governed
 * `under_rotation` (no logged wear, or unworn >= dormancyDays) is independent
 * of bucket, and an under-rotation item never lands in config_flag: its
 * recommendation history is attached as information instead.
 */
async function computeEligibility(
  supabase: SupabaseClient,
  forDate: string,
  categories: string[] = DEFAULT_ELIGIBILITY_CATEGORIES,
  dormancyDays: number = ELIGIBILITY_DEFAULT_DORMANCY_DAYS,
): Promise<EligibilityResult> {
  const computedAt = new Date().toISOString();

  const [itemsRes, statsMap, recsRes] = await Promise.all([
    supabase
      .from("items")
      .select("id, name, category, subcategory, status")
      .eq("status", "active")
      .in("category", categories)
      .range(0, 9999),
    fetchStatsMap(supabase),
    supabase
      .from("recommendations")
      .select(
        // `!recommendation_id` disambiguates: recommendations ↔ options are linked
        // twice (option.recommendation_id and recommendations.chosen_option_id).
        "id, recommended_for, outcome, created_at, recommendation_options!recommendation_id(id, option_index, label, recommendation_option_items(item_id, items(id, name)))",
      )
      .range(0, 9999),
  ]);
  if (itemsRes.error) {
    throw new Error(`Failed to load items for eligibility: ${itemsRes.error.message}`);
  }
  if (recsRes.error) {
    throw new Error(`Failed to load recommendations for eligibility: ${recsRes.error.message}`);
  }

  // Index every (recommendation, option) each item appeared in, carrying the
  // other item names from that option.
  const recsByItem = new Map<string, RecEntry[]>();
  for (const rec of (recsRes.data || []) as unknown as RecommendationTreeRow[]) {
    for (const opt of rec.recommendation_options || []) {
      const members = (opt.recommendation_option_items || []).map((l) => ({
        id: l.item_id,
        name: l.items?.name ?? l.item_id,
      }));
      for (const m of members) {
        const arr = recsByItem.get(m.id) || [];
        arr.push({
          recommendation_id: rec.id,
          option_index: opt.option_index,
          label: opt.label ?? null,
          recommended_for: rec.recommended_for,
          outcome: rec.outcome,
          created_at: rec.created_at,
          other_items: members
            .filter((x) => x.id !== m.id)
            .map((x) => x.name)
            .sort((a, b) => a.localeCompare(b)),
        });
        recsByItem.set(m.id, arr);
      }
    }
  }
  const newestFirst = (a: RecEntry, b: RecEntry) =>
    b.recommended_for.localeCompare(a.recommended_for) ||
    b.created_at.localeCompare(a.created_at) ||
    a.option_index - b.option_index;

  const items: EligibilityItem[] = [];
  for (const row of (itemsRes.data || []) as EligibilityItemRow[]) {
    const stats = normalizeStats(statsMap.get(row.id));
    const governed = isGoverned(row);
    const entries = (recsByItem.get(row.id) || []).sort(newestFirst);
    const latest = entries[0] ?? null;

    const dWorn = stats.last_worn ? daysBetween(forDate, stats.last_worn) : null;
    const dRec = latest ? daysBetween(forDate, latest.recommended_for) : null;
    const neverWorn = stats.total_wears === 0;
    const neverRecommended = entries.length === 0;
    const underRotation = neverWorn || (dWorn !== null && dWorn >= dormancyDays);

    // Unworn recommendations inside the window, newest first.
    const unworn: UnwornConfiguration[] = entries
      .filter((e) => !WORN_OUTCOMES.has(e.outcome))
      .map(({ created_at: _c, ...e }) => ({
        ...e,
        days_since_recommended: daysBetween(forDate, e.recommended_for),
      }))
      .filter((e) =>
        e.days_since_recommended >= 0 &&
        e.days_since_recommended < ELIGIBILITY_WINDOW_DAYS
      );

    const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
    const configText = (c: UnwornConfiguration) =>
      `recommended ${c.recommended_for} for rec ${c.recommendation_id} option ${c.option_index} (unworn)` +
      (c.other_items.length > 0 ? ` [with: ${c.other_items.join(", ")}]` : "");

    let bucket: EligibilityBucket;
    let reason: string;
    if (!governed) {
      bucket = "exempt";
      reason = `not governed: ${row.category}${row.subcategory ? ` / ${row.subcategory}` : ""}`;
    } else if (dWorn !== null && dWorn >= 0 && dWorn < ELIGIBILITY_WINDOW_DAYS) {
      bucket = "blocked_worn";
      reason = `worn ${stats.last_worn} (${days(dWorn)})`;
    } else if (dWorn === ELIGIBILITY_WINDOW_DAYS) {
      bucket = "boundary";
      reason = `worn ${stats.last_worn} (7 days, boundary)`;
    } else if (unworn.length > 0 && !underRotation) {
      bucket = "config_flag";
      reason = `${configText(unworn[0])} — do not re-propose that configuration; item is eligible`;
    } else {
      bucket = "eligible";
      const parts: string[] = [];
      if (neverWorn) {
        parts.push("no logged wear (total_wears 0)");
      } else if (dWorn !== null && dWorn < 0) {
        parts.push(`worn ${stats.last_worn} (${days(-dWorn)} after for_date)`);
      } else {
        parts.push(`worn ${stats.last_worn} (${days(dWorn as number)})`);
      }
      if (underRotation) parts.push(`under rotation (threshold ${days(dormancyDays)})`);
      if (unworn.length > 0) {
        parts.push(`${configText(unworn[0])} — under rotation, so this is information, not a flag`);
      }
      reason = parts.join("; ");
    }

    items.push({
      id: row.id,
      name: row.name,
      category: row.category,
      subcategory: row.subcategory,
      governed,
      bucket,
      reason,
      total_wears: stats.total_wears,
      last_worn: stats.last_worn,
      days_since_worn: dWorn,
      last_recommended_for: latest?.recommended_for ?? null,
      days_since_recommended: dRec,
      last_recommendation_id: latest?.recommendation_id ?? null,
      under_rotation: underRotation,
      never_worn: neverWorn,
      never_recommended: neverRecommended,
      unworn_configurations: unworn,
    });
  }
  items.sort(byName);

  const pick = (b: EligibilityBucket) => items.filter((i) => i.bucket === b);
  const buckets = {
    blocked_worn: pick("blocked_worn"),
    boundary: pick("boundary"),
    config_flag: pick("config_flag"),
    eligible: pick("eligible"),
    exempt: pick("exempt"),
  };
  const governedItems = items.filter((i) => i.governed);

  const run_id = await signEligibilityRun({
    for_date: forDate,
    computed_at: computedAt,
    v: ELIGIBILITY_RUN_VERSION,
  });

  return {
    run_id,
    computed_at: computedAt,
    for_date: forDate,
    window_days: ELIGIBILITY_WINDOW_DAYS,
    dormancy_days: dormancyDays,
    governed_categories: GOVERNED_CATEGORIES,
    governed_knitwear_subcategory_terms: GOVERNED_KNITWEAR_SUBCATEGORY_TERMS,
    requested_categories: categories,
    counts: {
      blocked_worn: buckets.blocked_worn.length,
      boundary: buckets.boundary.length,
      config_flag: buckets.config_flag.length,
      eligible: buckets.eligible.length,
      exempt: buckets.exempt.length,
    },
    ...buckets,
    never_worn: governedItems.filter((i) => i.never_worn).map((i) => i.name),
    never_recommended: governedItems.filter((i) => i.never_recommended).map((i) => i.name),
  };
}

// --- Eligibility run tokens ------------------------------------------------
//
// Stateless proof that this server computed eligibility for a date at a time:
// `base64url(payload) + "." + base64url(HMAC-SHA256(payload, secret))` with
// payload `{ for_date, computed_at, v }`. No table, nothing to clean up. The
// validator in `wd_log_recommendation` checks the signature, the date, and
// the age — then recomputes eligibility anyway, so the token authorises the
// write without being trusted for its contents.

type EligibilityRunPayload = { for_date: string; computed_at: string; v: number };

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function eligibilityHmacKey(): Promise<CryptoKey> {
  if (!WD_ELIGIBILITY_SECRET) {
    throw new Error(
      "WD_ELIGIBILITY_SECRET is not set. Set it with `supabase secrets set WD_ELIGIBILITY_SECRET=<random>` and redeploy wardrobe-mcp.",
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WD_ELIGIBILITY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signEligibilityRun(payload: EligibilityRunPayload): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await eligibilityHmacKey(), body);
  return `${base64url(body)}.${base64url(new Uint8Array(sig))}`;
}

/** Returns the payload when the signature holds and the shape is right; null otherwise. */
async function verifyEligibilityRun(token: string): Promise<EligibilityRunPayload | null> {
  const parts = token.trim().split(".");
  if (parts.length !== 2) return null;
  let body: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    body = base64urlDecode(parts[0]);
    sig = base64urlDecode(parts[1]);
  } catch {
    return null;
  }
  // subtle.verify is constant-time; never compare signatures with ===.
  const valid = await crypto.subtle.verify("HMAC", await eligibilityHmacKey(), sig, body);
  if (!valid) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(body));
    if (
      !p || typeof p !== "object" || p.v !== ELIGIBILITY_RUN_VERSION ||
      typeof p.for_date !== "string" || typeof p.computed_at !== "string"
    ) return null;
    return p as EligibilityRunPayload;
  } catch {
    return null;
  }
}

// --- MCP tools -----------------------------------------------------------

function buildServer(supabase: SupabaseClient): McpServer {
  const server = new McpServer({ name: "wardrobe", version: "1.0.0" });

  // ----- WRITES ----------------------------------------------------------

  server.tool(
    "wd_add_item",
    "Add a garment or accessory to the wardrobe inventory. Only `name` and `category` are required; supply whatever else you know. Use status 'incoming' for ordered-but-not-arrived pieces. Always confirm details with the owner before calling. If the piece came from a product page, pass `source_url`, `source_spec` (the page's own composition / weight / construction / care / size-chart text, as markdown) and `source_captured_on` in the same call — product pages go dead, and the spec is unrecoverable once they do. Use `wd_add_photo` for the stock image.",
    {
      name: z.string().describe('Display name, e.g. "LMSM bleu de travail chore coat"'),
      category: z.string().describe("outerwear | shirt | knitwear | trousers | footwear | accessory | socks | other"),
      subcategory: z.string().optional().describe("chore coat, penny loafer, OCBD, ..."),
      brand: z.string().optional(),
      color: z.string().optional().describe('e.g. "snuff", "faded blue-grey"'),
      color_family: z.string().optional().describe("warm_earth | cool | neutral | statement"),
      fabric: z.string().optional().describe("moleskin, linen, 11-wale corduroy, ..."),
      weight: z.string().optional().describe("light | mid | heavy"),
      seasons: z.array(z.string()).optional().describe("subset of {spring, summer, fall, winter}"),
      register: z.string().optional().describe("heritage_workwear | smart_casual | tailored | crossover | athletic"),
      formality: z.number().int().optional().describe("1 (gym) .. 10 (black tie)"),
      size: z.string().optional(),
      fit_notes: z.string().optional().describe("shoulder seam behavior, ease, weight-loss caveats"),
      condition: z.string().optional().describe("new | good | worn | needs_repair (default good)"),
      status: z.string().optional().describe("incoming | active | under_review | retired (default active)"),
      acquired_on: z.string().optional().describe("YYYY-MM-DD"),
      acquired_from: z.string().optional(),
      price_paid: z.number().optional(),
      pairing_notes: z.string().optional().describe("known-good pairings, register cautions"),
      notes: z.string().optional(),
      source_url: z.string().optional().describe("Product page the piece was bought from"),
      source_spec: z.string().optional().describe("The product page's own spec text, captured as markdown: fabric composition, weight, construction bullets, care, and the garment size chart. Free text — it is read, not parsed or queried. Capture it at acquisition; product pages go dead."),
      source_captured_on: z.string().optional().describe("YYYY-MM-DD, when the product page was captured"),
    },
    async (args) => {
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) row[k] = v;
      }
      const { data, error } = await supabase
        .from("items")
        .insert(row)
        .select(ITEM_COLUMNS_FULL)
        .single();
      if (error) throw new Error(`Failed to add item: ${error.message}`);
      return ok({ success: true, message: `Added item: ${data.name}`, item: data });
    },
  );

  server.tool(
    "wd_update_item",
    "Update an existing item by `item_id` or unambiguous `name_match`. Only the fields you supply change. Use for fit notes, condition, status changes (e.g. active -> under_review), pairing notes.",
    {
      item_id: z.string().optional().describe("Item UUID (preferred)"),
      name_match: z.string().optional().describe("Case-insensitive substring of the item name; must be unambiguous"),
      name: z.string().optional(),
      category: z.string().optional(),
      subcategory: z.string().optional(),
      brand: z.string().optional(),
      color: z.string().optional(),
      color_family: z.string().optional(),
      fabric: z.string().optional(),
      weight: z.string().optional(),
      seasons: z.array(z.string()).optional(),
      register: z.string().optional(),
      formality: z.number().int().optional(),
      size: z.string().optional(),
      fit_notes: z.string().optional(),
      condition: z.string().optional(),
      status: z.string().optional().describe("incoming | active | under_review | retired"),
      acquired_on: z.string().optional(),
      acquired_from: z.string().optional(),
      price_paid: z.number().optional(),
      retired_on: z.string().optional(),
      pairing_notes: z.string().optional(),
      notes: z.string().optional(),
      source_url: z.string().optional(),
      source_spec: z.string().optional().describe("Captured product-page text as markdown"),
      source_captured_on: z.string().optional().describe("YYYY-MM-DD"),
    },
    async ({ item_id, name_match, ...fields }) => {
      const id = await resolveSingleId(supabase, item_id, name_match);
      if ("error" in id) return id.error;

      const updates: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) updates[k] = v;
      }
      if (Object.keys(updates).length === 0) {
        throw new Error("No fields provided to update.");
      }

      const { data, error } = await supabase
        .from("items")
        .update(updates)
        .eq("id", id.value)
        .select(ITEM_COLUMNS_FULL)
        .single();
      if (error) throw new Error(`Failed to update item: ${error.message}`);
      return ok({ success: true, message: `Updated item: ${data.name}`, item: data });
    },
  );

  server.tool(
    "wd_retire_item",
    "Retire an item: sets status to 'retired', records retired_on (default today), and appends a reason to its notes. Reference by `item_id` or unambiguous `name_match`.",
    {
      item_id: z.string().optional().describe("Item UUID"),
      name_match: z.string().optional().describe("Case-insensitive substring of the item name; must be unambiguous"),
      reason: z.string().optional().describe("Why it's being retired (worn out, sold, donated, no longer fits, ...)"),
      retired_on: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
    },
    async ({ item_id, name_match, reason, retired_on }) => {
      const id = await resolveSingleId(supabase, item_id, name_match);
      if ("error" in id) return id.error;

      const { data: existing, error: readErr } = await supabase
        .from("items")
        .select("name, notes")
        .eq("id", id.value)
        .single();
      if (readErr) throw new Error(`Failed to read item: ${readErr.message}`);

      const stamp = retired_on || new Date().toISOString().split("T")[0];
      const note = reason ? `[Retired ${stamp}]: ${reason}` : `[Retired ${stamp}]`;
      const notes = existing.notes ? `${existing.notes}\n${note}` : note;

      const { data, error } = await supabase
        .from("items")
        .update({ status: "retired", retired_on: stamp, notes })
        .eq("id", id.value)
        .select(ITEM_COLUMNS)
        .single();
      if (error) throw new Error(`Failed to retire item: ${error.message}`);
      return ok({ success: true, message: `Retired item: ${data.name}`, item: data });
    },
  );

  server.tool(
    "wd_log_wear",
    "Log an outfit-of-the-day: one wear event plus links to every item worn. Every ref in `item_refs` must resolve before anything is written — on any ambiguous or missing ref, nothing is logged and the problems are returned instead. Each ref is an item UUID or a case-insensitive name substring. Always supply `register_note` and `paradigm_note`: the outfit as worn is tagged on both axes, in prose, even when it matches a proposal.",
    {
      item_refs: z.array(z.string()).min(1).describe('Items worn, e.g. ["tan chinos", "Buzz Rickson workshirt", "LMSM chore coat", "Aldens"]'),
      worn_on: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
      context: z.string().optional().describe("office, errands, dinner out, offsite, ..."),
      audience: z.array(z.string()).optional().describe('People/groups who would notice repeats, e.g. ["team", "Webb"]'),
      weather: z.string().optional(),
      rating: z.number().int().min(1).max(5).optional().describe("How the outfit felt, 1-5"),
      notes: z.string().optional(),
      outfit_id: z.string().optional().describe("Optional UUID of a saved outfit this wearing corresponds to"),
      register_note: z.string().optional().describe('Free text: which register(s) the outfit sits in, with any mixing or collision noted, e.g. "heritage workwear; formality crossing at the black bluchers"'),
      paradigm_note: z.string().optional().describe('Free text: which Crompton paradigm(s) it draws on, with overlap or ambiguity noted, e.g. "Workwear throughout; Italian smooth at the knit"'),
    },
    async ({ item_refs, worn_on, context, audience, weather, rating, notes, outfit_id, register_note, paradigm_note }) => {
      const { resolved, problems } = await resolveItemRefs(supabase, item_refs);
      if (problems.length > 0) {
        return ok({
          success: false,
          message: "Some item references could not be resolved — nothing was logged. Resolve these and retry.",
          unresolved: problemsPayload(problems),
          resolved: resolved.map((r) => ({ ref: r.ref, id: r.item.id, name: r.item.name })),
        });
      }

      const eventRow: Record<string, unknown> = {};
      // Default to today in America/Los_Angeles rather than letting the column
      // default (current_date) resolve in the database's UTC timezone.
      eventRow.worn_on = worn_on || todayLA();
      if (context) eventRow.context = context;
      if (audience) eventRow.audience = audience;
      if (weather) eventRow.weather = weather;
      if (rating !== undefined) eventRow.rating = rating;
      if (notes) eventRow.notes = notes;
      if (outfit_id) eventRow.outfit_id = outfit_id;
      if (register_note) eventRow.register_note = register_note;
      if (paradigm_note) eventRow.paradigm_note = paradigm_note;

      const { data: event, error: eventErr } = await supabase
        .from("wear_events")
        .insert(eventRow)
        .select("*")
        .single();
      if (eventErr) throw new Error(`Failed to create wear event: ${eventErr.message}`);

      const links = resolved.map((r) => ({
        wear_event_id: event.id,
        item_id: r.item.id,
      }));
      const { error: linkErr } = await supabase
        .from("wear_event_items")
        .insert(links);
      if (linkErr) {
        // Roll back the orphaned event so we don't leave a wear with no items.
        await supabase.from("wear_events").delete().eq("id", event.id);
        throw new Error(`Failed to link items to wear event: ${linkErr.message}`);
      }

      return ok({
        success: true,
        message: `Logged wear on ${event.worn_on} (${resolved.length} item${resolved.length === 1 ? "" : "s"}).`,
        wear_event: event,
        items: resolved.map((r) => ({ id: r.item.id, name: r.item.name })),
      });
    },
  );

  server.tool(
    "wd_update_wear",
    "Edit an existing wear event identified by `event_id`. Partial update — only the fields you supply change. If `item_refs` is provided it REPLACES the set of items linked to the event; every ref must resolve first (same all-or-nothing rule as wd_log_wear) or nothing is changed. `worn_on` is stored as a literal date (no timezone conversion). Returns the updated event with its items.",
    {
      event_id: z.string().describe("UUID of the wear event to edit"),
      worn_on: z.string().optional().describe("YYYY-MM-DD, stored literally (no timezone conversion)"),
      context: z.string().optional().describe("office, errands, dinner out, offsite, ..."),
      weather: z.string().optional(),
      audience: z.array(z.string()).optional().describe('People/groups who would notice repeats, e.g. ["team", "Webb"]'),
      rating: z.number().int().min(1).max(5).optional().describe("How the outfit felt, 1-5"),
      notes: z.string().optional(),
      register_note: z.string().optional().describe("Free text: which register(s) the outfit sits in, with mixing or collision noted"),
      paradigm_note: z.string().optional().describe("Free text: which Crompton paradigm(s) it draws on, with overlap or ambiguity noted"),
      item_refs: z.array(z.string()).min(1).optional().describe("If provided, REPLACES the linked items. UUIDs or name substrings; every ref must resolve unambiguously."),
    },
    async ({ event_id, worn_on, context, weather, audience, rating, notes, register_note, paradigm_note, item_refs }) => {
      if (!isUuid(event_id)) {
        return ok({ success: false, message: `"${event_id}" is not a valid event_id (UUID expected).` });
      }

      // Confirm the event exists before touching anything.
      const { data: existing, error: readErr } = await supabase
        .from("wear_events")
        .select("*")
        .eq("id", event_id)
        .maybeSingle();
      if (readErr) throw new Error(`Failed to read wear event: ${readErr.message}`);
      if (!existing) {
        return ok({ success: false, message: `No wear event found with id "${event_id}".` });
      }

      // If replacing items, resolve every ref first — all-or-nothing, same as wd_log_wear.
      let resolvedItems:
        | Extract<ResolveResult, { status: "ok" }>[]
        | null = null;
      if (item_refs) {
        const { resolved, problems } = await resolveItemRefs(supabase, item_refs);
        if (problems.length > 0) {
          return ok({
            success: false,
            message: "Some item references could not be resolved — nothing was changed. Resolve these and retry.",
            unresolved: problemsPayload(problems),
            resolved: resolved.map((r) => ({ ref: r.ref, id: r.item.id, name: r.item.name })),
          });
        }
        resolvedItems = resolved;
      }

      // Build the partial scalar update.
      const updates: Record<string, unknown> = {};
      if (worn_on !== undefined) updates.worn_on = worn_on;
      if (context !== undefined) updates.context = context;
      if (weather !== undefined) updates.weather = weather;
      if (audience !== undefined) updates.audience = audience;
      if (rating !== undefined) updates.rating = rating;
      if (notes !== undefined) updates.notes = notes;
      if (register_note !== undefined) updates.register_note = register_note;
      if (paradigm_note !== undefined) updates.paradigm_note = paradigm_note;

      if (Object.keys(updates).length === 0 && resolvedItems === null) {
        throw new Error("No fields or item_refs provided to update.");
      }

      let event = existing;
      if (Object.keys(updates).length > 0) {
        const { data, error } = await supabase
          .from("wear_events")
          .update(updates)
          .eq("id", event_id)
          .select("*")
          .single();
        if (error) throw new Error(`Failed to update wear event: ${error.message}`);
        event = data;
      }

      // Replace linked items if item_refs was provided. Capture the prior link
      // set first so we can restore it if the re-insert fails — mirrors the
      // compensating-rollback approach in wd_log_wear.
      if (resolvedItems) {
        const { data: oldLinks, error: oldErr } = await supabase
          .from("wear_event_items")
          .select("item_id")
          .eq("wear_event_id", event_id);
        if (oldErr) throw new Error(`Failed to read existing item links: ${oldErr.message}`);

        const { error: delErr } = await supabase
          .from("wear_event_items")
          .delete()
          .eq("wear_event_id", event_id);
        if (delErr) throw new Error(`Failed to clear existing item links: ${delErr.message}`);

        const links = resolvedItems.map((r) => ({
          wear_event_id: event_id,
          item_id: r.item.id,
        }));
        const { error: insErr } = await supabase
          .from("wear_event_items")
          .insert(links);
        if (insErr) {
          // Restore the prior links so we never leave the event item-less.
          if (oldLinks && oldLinks.length > 0) {
            await supabase.from("wear_event_items").insert(
              oldLinks.map((l) => ({ wear_event_id: event_id, item_id: l.item_id })),
            );
          }
          throw new Error(`Failed to set new item links: ${insErr.message}`);
        }
      }

      // Return the event with its current items.
      const { data: links, error: linkErr } = await supabase
        .from("wear_event_items")
        .select("items(id, name, category)")
        .eq("wear_event_id", event_id);
      if (linkErr) throw new Error(`Failed to load worn items: ${linkErr.message}`);
      const items = (links || []).map((l) => l.items);

      return ok({
        success: true,
        message: `Updated wear event on ${event.worn_on} (${items.length} item${items.length === 1 ? "" : "s"}).`,
        wear_event: event,
        items,
      });
    },
  );

  server.tool(
    "wd_delete_wear",
    "Delete a wear event and all of its item links, identified by `event_id`. Returns the deleted event id, its worn_on date, and the number of item links removed.",
    {
      event_id: z.string().describe("UUID of the wear event to delete"),
    },
    async ({ event_id }) => {
      if (!isUuid(event_id)) {
        return ok({ success: false, message: `"${event_id}" is not a valid event_id (UUID expected).` });
      }

      const { data: existing, error: readErr } = await supabase
        .from("wear_events")
        .select("id, worn_on")
        .eq("id", event_id)
        .maybeSingle();
      if (readErr) throw new Error(`Failed to read wear event: ${readErr.message}`);
      if (!existing) {
        return ok({ success: false, message: `No wear event found with id "${event_id}".` });
      }

      // Count the item links before removing them, so we can report the count.
      const { count, error: countErr } = await supabase
        .from("wear_event_items")
        .select("*", { count: "exact", head: true })
        .eq("wear_event_id", event_id);
      if (countErr) throw new Error(`Failed to count item links: ${countErr.message}`);
      const removed = count ?? 0;

      // Delete the links first, then the event itself.
      const { error: delLinksErr } = await supabase
        .from("wear_event_items")
        .delete()
        .eq("wear_event_id", event_id);
      if (delLinksErr) throw new Error(`Failed to delete item links: ${delLinksErr.message}`);

      const { error: delEventErr } = await supabase
        .from("wear_events")
        .delete()
        .eq("id", event_id);
      if (delEventErr) throw new Error(`Failed to delete wear event: ${delEventErr.message}`);

      return ok({
        success: true,
        message: `Deleted wear event on ${existing.worn_on} and ${removed} item link${removed === 1 ? "" : "s"}.`,
        deleted_event_id: existing.id,
        worn_on: existing.worn_on,
        item_links_removed: removed,
      });
    },
  );

  server.tool(
    "wd_log_recommendation",
    "Log an outfit recommendation at the moment it is proposed — one call per proposal event, covering every option offered (a single-option proposal is an `options` array of length 1). Every item ref in every option must resolve before anything is written — on any ambiguous or missing ref, nothing is logged and the problems are returned instead. `recommended_for` is the date the outfit is FOR (stored literally, no timezone conversion); `proposed_on` is set to today in America/Los_Angeles. Outcome starts as 'pending' — close the loop later with wd_update_recommendation. Every option must carry `register_note` and `paradigm_note`: each formulated outfit is tagged on both axes, in prose, so mixing and deliberate collisions are recorded rather than flattened. Requires `eligibility_run_id` from a wd_eligibility run for the same `recommended_for`, no older than 30 minutes: eligibility is recomputed at write time and any option containing a `blocked_worn` item is refused outright (no partial write). `boundary` and `config_flag` items are written but reported back in `warnings`.",
    {
      recommended_for: z.string().describe("YYYY-MM-DD the outfit is for (not the date proposed); stored literally"),
      eligibility_run_id: z.string().describe("Required. The `run_id` returned by wd_eligibility for this same recommended_for, computed within the last 30 minutes. The write is refused without it."),
      options: z.array(z.object({
        label: z.string().optional().describe('Short handle, e.g. "warm-earth heritage-lean"'),
        rationale: z.string().optional().describe("The one-line reasoning given for this option"),
        item_refs: z.array(z.string()).min(1).describe("Items in this option (UUIDs or name substrings)"),
        register_note: z.string().optional().describe('Free text: which register(s) this option sits in, with any mixing or collision noted, e.g. "smart casual base; heritage at the jacket — single-axis collision"'),
        paradigm_note: z.string().optional().describe('Free text: which Crompton paradigm(s) it draws on, with overlap or ambiguity noted, e.g. "Italian smooth (knit, loafers) over Workwear (denim); Sportswear accent at the sneaker"'),
      })).min(1).describe("The options offered, in the order presented"),
      context: z.string().optional().describe("office, errands, dinner out, offsite, ..."),
      weather: z.string().optional(),
      audience: z.array(z.string()).optional().describe('People/groups who would see the outfit, e.g. ["team", "Webb"]'),
      notes: z.string().optional(),
    },
    async ({ recommended_for, eligibility_run_id, options, context, weather, audience, notes }) => {
      // Gate 1–3: the run token must verify, be for this date, and be fresh.
      // All three are checked before any read or write.
      const run = await verifyEligibilityRun(eligibility_run_id);
      if (!run) {
        return ok({
          success: false,
          error: "eligibility_run_invalid",
          message: "eligibility_run_id is not a valid wd_eligibility run token — nothing was logged. Call wd_eligibility for this recommended_for and pass its run_id.",
        });
      }
      if (run.for_date !== recommended_for) {
        return ok({
          success: false,
          error: "eligibility_run_date_mismatch",
          message: `The eligibility run was computed for ${run.for_date}, not ${recommended_for} — nothing was logged. Call wd_eligibility for ${recommended_for} and retry.`,
          run_for_date: run.for_date,
          recommended_for,
        });
      }
      const ageMinutes = (Date.now() - Date.parse(run.computed_at)) / 60000;
      if (!(ageMinutes <= ELIGIBILITY_RUN_TTL_MINUTES)) {
        return ok({
          success: false,
          error: "eligibility_run_stale",
          message: `The eligibility run is ${Number.isFinite(ageMinutes) ? (Math.round(ageMinutes * 10) / 10).toString() : "?"} minutes old (limit ${ELIGIBILITY_RUN_TTL_MINUTES}) — nothing was logged. Call wd_eligibility again and retry.`,
          computed_at: run.computed_at,
        });
      }

      // Resolve every ref in every option before writing anything —
      // all-or-nothing across the entire call, same rule as wd_log_wear.
      const perOption = await Promise.all(
        options.map((o) => resolveItemRefs(supabase, o.item_refs)),
      );
      const unresolved = perOption.flatMap((r, i) =>
        problemsPayload(r.problems).map((p) => ({ option_index: i + 1, ...p }))
      );
      if (unresolved.length > 0) {
        return ok({
          success: false,
          message: "Some item references could not be resolved — nothing was logged. Resolve these and retry.",
          unresolved,
        });
      }

      // Dedupe repeated refs within an option so the link-table PK holds.
      const itemsPerOption = perOption.map((r) => {
        const seen = new Set<string>();
        return r.resolved.filter((x) =>
          seen.has(x.item.id) ? false : (seen.add(x.item.id), true)
        );
      });

      // Gate 4–5: recompute eligibility for the date at write time — the same
      // implementation wd_eligibility exposes, not a second copy of the rule.
      // Any blocked item in any option refuses the whole call; boundary and
      // config_flag items go through and are surfaced as warnings.
      const eligibility = await computeEligibility(supabase, recommended_for);
      const eligibilityById = new Map(
        [
          ...eligibility.blocked_worn,
          ...eligibility.boundary,
          ...eligibility.config_flag,
          ...eligibility.eligible,
          ...eligibility.exempt,
        ].map((e) => [e.id, e] as const),
      );
      const blocked: { option_index: number; item_id: string; name: string; reason: string }[] = [];
      const warnings: { option_index: number; item_id: string; name: string; bucket: string; reason: string }[] = [];
      itemsPerOption.forEach((resolvedItems, i) => {
        for (const r of resolvedItems) {
          const e = eligibilityById.get(r.item.id);
          if (!e || !e.governed) continue; // non-governed items are never checked
          if (e.bucket === "blocked_worn") {
            blocked.push({ option_index: i + 1, item_id: e.id, name: e.name, reason: e.reason });
          } else if (e.bucket === "boundary" || e.bucket === "config_flag") {
            warnings.push({ option_index: i + 1, item_id: e.id, name: e.name, bucket: e.bucket, reason: e.reason });
          }
        }
      });
      if (blocked.length > 0) {
        return ok({
          success: false,
          error: "blocked_items",
          message: `${blocked.length} item${blocked.length === 1 ? " is" : "s are"} inside the 7-day window for ${recommended_for} — nothing was logged. Replace the blocked item${blocked.length === 1 ? "" : "s"} and retry.`,
          blocked_items: blocked,
          warnings,
        });
      }

      const recRow: Record<string, unknown> = {
        recommended_for,
        proposed_on: todayLA(),
        eligibility_run_id,
      };
      if (context) recRow.context = context;
      if (weather) recRow.weather = weather;
      if (audience) recRow.audience = audience;
      if (notes) recRow.notes = notes;

      const { data: rec, error: recErr } = await supabase
        .from("recommendations")
        .insert(recRow)
        .select("*")
        .single();
      if (recErr) throw new Error(`Failed to create recommendation: ${recErr.message}`);

      const optionRows = options.map((o, i) => {
        const row: Record<string, unknown> = {
          recommendation_id: rec.id,
          option_index: i + 1,
        };
        if (o.label) row.label = o.label;
        if (o.rationale) row.rationale = o.rationale;
        if (o.register_note) row.register_note = o.register_note;
        if (o.paradigm_note) row.paradigm_note = o.paradigm_note;
        return row;
      });
      const { data: createdOptions, error: optErr } = await supabase
        .from("recommendation_options")
        .insert(optionRows)
        .select("*");
      if (optErr) {
        // Roll back the orphaned recommendation (cascade removes any options).
        await supabase.from("recommendations").delete().eq("id", rec.id);
        throw new Error(`Failed to create recommendation options: ${optErr.message}`);
      }

      const sorted = [...(createdOptions || [])].sort(
        (a, b) => a.option_index - b.option_index,
      );
      const links = sorted.flatMap((row, i) =>
        itemsPerOption[i].map((r) => ({
          recommendation_option_id: row.id,
          item_id: r.item.id,
        }))
      );
      const { error: linkErr } = await supabase
        .from("recommendation_option_items")
        .insert(links);
      if (linkErr) {
        // Roll back everything; cascade removes options and any partial links.
        await supabase.from("recommendations").delete().eq("id", rec.id);
        throw new Error(`Failed to link items to recommendation options: ${linkErr.message}`);
      }

      return ok({
        success: true,
        message: `Logged recommendation for ${rec.recommended_for} (${sorted.length} option${sorted.length === 1 ? "" : "s"}).`,
        warnings,
        recommendation: rec,
        options: sorted.map((row, i) => ({
          ...row,
          items: itemsPerOption[i].map((r) => ({ id: r.item.id, name: r.item.name })),
        })),
      });
    },
  );

  server.tool(
    "wd_update_recommendation",
    "Close the loop on a recommendation identified by `recommendation_id` — usually after the owner reports what he actually wore. Partial update: only the fields you supply change. `chosen_option_id` must belong to this recommendation; `wear_event_id` must be an existing wear event. Options and their items cannot be edited here — if a proposal was logged wrong, wd_delete_recommendation and re-log. Returns the updated recommendation with its options and items.",
    {
      recommendation_id: z.string().describe("UUID of the recommendation to update"),
      outcome: z.enum(["pending", "worn_as_proposed", "worn_with_deviation", "declined", "superseded", "unknown"]).optional(),
      chosen_option_id: z.string().optional().describe("UUID of the option that was picked; must belong to this recommendation"),
      wear_event_id: z.string().optional().describe("UUID of the wear event the outfit became, once logged"),
      deviation_notes: z.string().optional().describe("What he swapped and why — the highest-value field here"),
      notes: z.string().optional(),
      context: z.string().optional(),
      weather: z.string().optional(),
      audience: z.array(z.string()).optional(),
      recommended_for: z.string().optional().describe("YYYY-MM-DD, stored literally (no timezone conversion)"),
    },
    async ({ recommendation_id, outcome, chosen_option_id, wear_event_id, deviation_notes, notes, context, weather, audience, recommended_for }) => {
      if (!isUuid(recommendation_id)) {
        return ok({ success: false, message: `"${recommendation_id}" is not a valid recommendation_id (UUID expected).` });
      }

      // Confirm the recommendation exists before touching anything.
      const { data: existing, error: readErr } = await supabase
        .from("recommendations")
        .select("*")
        .eq("id", recommendation_id)
        .maybeSingle();
      if (readErr) throw new Error(`Failed to read recommendation: ${readErr.message}`);
      if (!existing) {
        return ok({ success: false, message: `No recommendation found with id "${recommendation_id}".` });
      }

      // chosen_option_id must be one of THIS recommendation's options.
      if (chosen_option_id !== undefined) {
        if (!isUuid(chosen_option_id)) {
          return ok({ success: false, message: `"${chosen_option_id}" is not a valid chosen_option_id (UUID expected).` });
        }
        const { data: opt, error: optErr } = await supabase
          .from("recommendation_options")
          .select("id, option_index, label")
          .eq("id", chosen_option_id)
          .eq("recommendation_id", recommendation_id)
          .maybeSingle();
        if (optErr) throw new Error(`Failed to check chosen option: ${optErr.message}`);
        if (!opt) {
          const { data: valid, error: validErr } = await supabase
            .from("recommendation_options")
            .select("id, option_index, label")
            .eq("recommendation_id", recommendation_id)
            .order("option_index", { ascending: true });
          if (validErr) throw new Error(`Failed to list options: ${validErr.message}`);
          return ok({
            success: false,
            message: `Option "${chosen_option_id}" does not belong to recommendation "${recommendation_id}" — nothing was changed.`,
            valid_options: valid || [],
          });
        }
      }

      // wear_event_id must reference an existing wear event.
      if (wear_event_id !== undefined) {
        if (!isUuid(wear_event_id)) {
          return ok({ success: false, message: `"${wear_event_id}" is not a valid wear_event_id (UUID expected).` });
        }
        const { data: we, error: weErr } = await supabase
          .from("wear_events")
          .select("id")
          .eq("id", wear_event_id)
          .maybeSingle();
        if (weErr) throw new Error(`Failed to check wear event: ${weErr.message}`);
        if (!we) {
          return ok({ success: false, message: `No wear event found with id "${wear_event_id}" — nothing was changed.` });
        }
      }

      const updates: Record<string, unknown> = {};
      if (outcome !== undefined) updates.outcome = outcome;
      if (chosen_option_id !== undefined) updates.chosen_option_id = chosen_option_id;
      if (wear_event_id !== undefined) updates.wear_event_id = wear_event_id;
      if (deviation_notes !== undefined) updates.deviation_notes = deviation_notes;
      if (notes !== undefined) updates.notes = notes;
      if (context !== undefined) updates.context = context;
      if (weather !== undefined) updates.weather = weather;
      if (audience !== undefined) updates.audience = audience;
      if (recommended_for !== undefined) updates.recommended_for = recommended_for;

      if (Object.keys(updates).length === 0) {
        throw new Error("No fields provided to update.");
      }

      const { data: rec, error } = await supabase
        .from("recommendations")
        .update(updates)
        .eq("id", recommendation_id)
        .select("*")
        .single();
      if (error) throw new Error(`Failed to update recommendation: ${error.message}`);

      // Return the recommendation with its options and their items.
      const { data: opts, error: optsErr } = await supabase
        .from("recommendation_options")
        .select("*")
        .eq("recommendation_id", recommendation_id)
        .order("option_index", { ascending: true });
      if (optsErr) throw new Error(`Failed to load options: ${optsErr.message}`);
      const optIds = (opts || []).map((o) => o.id);
      const { data: links, error: linkErr } = optIds.length > 0
        ? await supabase
          .from("recommendation_option_items")
          .select("recommendation_option_id, items(id, name, category)")
          .in("recommendation_option_id", optIds)
        : { data: [], error: null };
      if (linkErr) throw new Error(`Failed to load option items: ${linkErr.message}`);

      const byOption = new Map<string, unknown[]>();
      for (const l of links || []) {
        const arr = byOption.get(l.recommendation_option_id) || [];
        arr.push(l.items);
        byOption.set(l.recommendation_option_id, arr);
      }

      return ok({
        success: true,
        message: `Updated recommendation for ${rec.recommended_for} (outcome: ${rec.outcome}).`,
        recommendation: rec,
        options: (opts || []).map((o) => ({ ...o, items: byOption.get(o.id) || [] })),
      });
    },
  );

  server.tool(
    "wd_delete_recommendation",
    "Delete a recommendation and all of its options and item links, identified by `recommendation_id`. Use when a proposal was logged wrong: delete and re-log (options/items cannot be edited in place). Returns the deleted id, its recommended_for date, and the number of options removed.",
    {
      recommendation_id: z.string().describe("UUID of the recommendation to delete"),
    },
    async ({ recommendation_id }) => {
      if (!isUuid(recommendation_id)) {
        return ok({ success: false, message: `"${recommendation_id}" is not a valid recommendation_id (UUID expected).` });
      }

      const { data: existing, error: readErr } = await supabase
        .from("recommendations")
        .select("id, recommended_for")
        .eq("id", recommendation_id)
        .maybeSingle();
      if (readErr) throw new Error(`Failed to read recommendation: ${readErr.message}`);
      if (!existing) {
        return ok({ success: false, message: `No recommendation found with id "${recommendation_id}".` });
      }

      const { count, error: countErr } = await supabase
        .from("recommendation_options")
        .select("*", { count: "exact", head: true })
        .eq("recommendation_id", recommendation_id);
      if (countErr) throw new Error(`Failed to count options: ${countErr.message}`);
      const removed = count ?? 0;

      // Cascade delete removes options and their item links.
      const { error: delErr } = await supabase
        .from("recommendations")
        .delete()
        .eq("id", recommendation_id);
      if (delErr) throw new Error(`Failed to delete recommendation: ${delErr.message}`);

      return ok({
        success: true,
        message: `Deleted recommendation for ${existing.recommended_for} and ${removed} option${removed === 1 ? "" : "s"}.`,
        deleted_recommendation_id: existing.id,
        recommended_for: existing.recommended_for,
        options_removed: removed,
      });
    },
  );

  server.tool(
    "wd_save_outfit",
    "Save a named, reusable outfit combination that is known to work. Every ref in `item_refs` must resolve before anything is written. Always supply `register_note` and `paradigm_note`: `register` is the one-word bucket for filtering; the notes are the prose tags on both axes, including mixing and collisions.",
    {
      name: z.string().describe('e.g. "bleu de travail + ecru workshirt + tan chinos + Aldens"'),
      item_refs: z.array(z.string()).min(1).describe("Items in the outfit (UUIDs or name substrings)"),
      register: z.string().optional().describe("heritage_workwear | smart_casual | tailored | crossover | athletic"),
      occasion: z.string().optional().describe("What it's for"),
      notes: z.string().optional().describe("Why it works, caveats"),
      register_note: z.string().optional().describe("Free text: which register(s) the outfit sits in, with any mixing or collision noted"),
      paradigm_note: z.string().optional().describe("Free text: which Crompton paradigm(s) it draws on, with overlap or ambiguity noted"),
    },
    async ({ name, item_refs, register, occasion, notes, register_note, paradigm_note }) => {
      const { resolved, problems } = await resolveItemRefs(supabase, item_refs);
      if (problems.length > 0) {
        return ok({
          success: false,
          message: "Some item references could not be resolved — the outfit was not saved.",
          unresolved: problemsPayload(problems),
          resolved: resolved.map((r) => ({ ref: r.ref, id: r.item.id, name: r.item.name })),
        });
      }

      const outfitRow: Record<string, unknown> = { name };
      if (register) outfitRow.register = register;
      if (occasion) outfitRow.occasion = occasion;
      if (notes) outfitRow.notes = notes;
      if (register_note) outfitRow.register_note = register_note;
      if (paradigm_note) outfitRow.paradigm_note = paradigm_note;

      const { data: outfit, error: outfitErr } = await supabase
        .from("outfits")
        .insert(outfitRow)
        .select("*")
        .single();
      if (outfitErr) throw new Error(`Failed to save outfit: ${outfitErr.message}`);

      const links = resolved.map((r) => ({
        outfit_id: outfit.id,
        item_id: r.item.id,
      }));
      const { error: linkErr } = await supabase.from("outfit_items").insert(links);
      if (linkErr) {
        await supabase.from("outfits").delete().eq("id", outfit.id);
        throw new Error(`Failed to link items to outfit: ${linkErr.message}`);
      }

      return ok({
        success: true,
        message: `Saved outfit: ${outfit.name}`,
        outfit,
        items: resolved.map((r) => ({ id: r.item.id, name: r.item.name })),
      });
    },
  );

  server.tool(
    "wd_add_photo",
    "Attach a photograph to one garment (`item_ref`) or one wear event (`event_id`) — exactly one subject, never both. You supply a URL; the function fetches, hashes, measures and stores the bytes itself. Do not attempt to pass image data. `kind` is the load-bearing field and constrains what the frame may ever be read for: 'reference' = the owner's own garment shot under controlled light with a colour chart in frame — the ONLY kind from which colour values may be taken; 'outfit' = the owner's garment as worn, a mirror snap — good for fit over time and for settling what was actually worn, NEVER for colour values; 'stock' = the maker's or retailer's own photography — good for identification, for the as-new baseline (original indigo depth, suede nap, knit surface before wear), and for construction detail, but NEVER for colour values, fit, or proportion, because retailers grade images for appeal and a stock photo is the most authoritative-looking and least colour-faithful image in the archive. `color_authoritative` is generated by the database from `kind` and cannot be set here. Re-adding the same bytes for the same item returns the existing photo instead of duplicating. If the item reference is ambiguous or unmatched, candidates are returned and nothing is written.",
    {
      item_ref: z.string().optional().describe("Subject garment: item UUID or a case-insensitive name substring (resolved as in wd_log_wear). Mutually exclusive with event_id."),
      event_id: z.string().optional().describe("Subject wear event UUID. Mutually exclusive with item_ref."),
      kind: z.enum(["stock", "reference", "outfit"]).describe("stock = retailer photography: identification, as-new baseline, construction detail; never colour, fit or proportion. reference = owner's garment, controlled light, colour chart in frame: the only colour-authoritative kind. outfit = owner's garment as worn, mirror snap: fit over time and provenance; never colour."),
      source_url: z.string().describe("URL of the image to fetch server-side. Required for every kind: fetching this URL is the only way bytes enter the bucket in this build (phone-photo ingest is deliberately out of scope), and for kind 'stock' it doubles as the provenance record — a baseline with no source is not a baseline. A Shopify thumbnail URL is fine; the width parameter is raised before fetching."),
      shot_type: z.enum(["flatlay", "on_model", "detail", "swatch", "full_length", "other"]).optional().describe("flatlay | on_model | detail | swatch | full_length | other"),
      caption: z.string().optional().describe("What the frame shows, in the owner's words"),
      captured_on: z.string().optional().describe("YYYY-MM-DD, when the photograph was taken (not when it was ingested). Stored as a literal date."),
    },
    async ({ item_ref, event_id, kind, source_url, shot_type, caption, captured_on }) => {
      const subjectRes = await resolvePhotoSubject(supabase, item_ref, event_id);
      if ("error" in subjectRes) return subjectRes.error;
      const subject = subjectRes.subject;

      const fetched = await fetchImageForStorage(source_url);
      if ("failed" in fetched) {
        return ok({
          success: false,
          message: `${fetched.message} Nothing was written.`,
          url: fetched.url,
          http_status: fetched.status ?? null,
        });
      }

      const content_hash = await sha256Hex(fetched.bytes);

      // Same bytes, same garment: return what is already there. The unique
      // index backstops this, but catching it here keeps the storage object
      // from being uploaded twice.
      if (subject.kind === "item") {
        const { data: dupe, error: dupeErr } = await supabase
          .from("photos")
          .select(PHOTO_COLUMNS)
          .eq("item_id", subject.id)
          .eq("content_hash", content_hash)
          .maybeSingle();
        if (dupeErr) throw new Error(`Duplicate check failed: ${dupeErr.message}`);
        if (dupe) {
          const signed = await signPhotoPaths(supabase, [dupe.storage_path]);
          return ok({
            success: true,
            already_stored: true,
            message: `These exact bytes are already stored for "${subject.name}" — no second row was created.`,
            photo: { ...dupe, photo_id: dupe.id, signed_url: signed.get(dupe.storage_path) ?? null },
          });
        }
      }

      const dims = readImageDimensions(fetched.bytes, fetched.mime);
      const photoId = crypto.randomUUID();
      const storage_path = `${kind}/${subject.id}/${photoId}.${fetched.ext}`;

      const { error: uploadErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(storage_path, fetched.bytes, {
          contentType: fetched.mime,
          upsert: false,
        });
      if (uploadErr) throw new Error(`Failed to upload photo: ${uploadErr.message}`);

      const row: Record<string, unknown> = {
        id: photoId,
        kind,
        storage_path,
        content_hash,
        mime_type: fetched.mime,
        bytes: fetched.bytes.byteLength,
        width_px: dims?.width ?? null,
        height_px: dims?.height ?? null,
        source_url: source_url,
        source_domain: sourceDomainOf(source_url),
      };
      if (subject.kind === "item") row.item_id = subject.id;
      else row.event_id = subject.id;
      if (shot_type) row.shot_type = shot_type;
      if (caption) row.caption = caption;
      if (captured_on) row.captured_on = captured_on;

      const { data, error } = await supabase
        .from("photos")
        .insert(row)
        .select(PHOTO_COLUMNS)
        .single();
      if (error) {
        // Roll the object back so a failed insert doesn't leave bytes in the
        // bucket that nothing references.
        await supabase.storage.from(PHOTO_BUCKET).remove([storage_path]);
        throw new Error(`Failed to record photo: ${error.message}`);
      }

      const signed = await signPhotoPaths(supabase, [storage_path]);
      const subjectLabel = subject.kind === "item"
        ? `"${subject.name}"`
        : `wear event ${subject.worn_on}`;

      return ok({
        success: true,
        already_stored: false,
        message: `Stored a ${kind} photo for ${subjectLabel}${
          dims ? ` at ${dims.width}x${dims.height}` : ""
        }.${fetched.width_upgraded ? " Shopify URL was raised to width=2048 before fetching." : ""}${
          data.color_authoritative
            ? " This frame IS colour-authoritative."
            : " This frame is NOT colour-authoritative — do not read colour values off it."
        }`,
        photo: { ...data, photo_id: data.id, signed_url: signed.get(storage_path) ?? null },
        fetched_url: fetched.url,
        width_upgraded: fetched.width_upgraded,
      });
    },
  );

  server.tool(
    "wd_delete_photo",
    "Delete one photograph by `photo_id`: removes both the database row and the stored object. The row goes first, so a storage failure leaves an unreferenced object rather than a row pointing at bytes that are gone — the result reports which happened. Returns the deleted id, its subject, and its storage path.",
    {
      photo_id: z.string().describe("Photo UUID"),
    },
    async ({ photo_id }) => {
      if (!isUuid(photo_id)) {
        return ok({ success: false, message: `photo_id must be a UUID; got "${photo_id}".` });
      }

      const { data: existing, error: readErr } = await supabase
        .from("photos")
        .select(PHOTO_COLUMNS)
        .eq("id", photo_id)
        .maybeSingle();
      if (readErr) throw new Error(`Failed to read photo: ${readErr.message}`);
      if (!existing) {
        return ok({ success: false, message: `No photo with id ${photo_id}.` });
      }

      const { error: delErr } = await supabase.from("photos").delete().eq("id", photo_id);
      if (delErr) throw new Error(`Failed to delete photo row: ${delErr.message}`);

      const { error: objErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .remove([existing.storage_path]);

      return ok({
        success: true,
        message: objErr
          ? `Deleted photo ${photo_id}, but the stored object could not be removed: ${objErr.message}`
          : `Deleted photo ${photo_id} and its stored object.`,
        photo_id,
        subject: existing.item_id
          ? { kind: "item", id: existing.item_id }
          : { kind: "event", id: existing.event_id },
        storage_path: existing.storage_path,
        storage_object_deleted: !objErr,
      });
    },
  );

  server.tool(
    "wd_mark_review_done",
    "Mark a rotation review as completed today. Sets system_state.last_rotation_review to today's date. Call this at the end of a rotation-review conversation.",
    {
      reviewed_on: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
    },
    async ({ reviewed_on }) => {
      const date = reviewed_on || new Date().toISOString().split("T")[0];
      const { data, error } = await supabase
        .from("system_state")
        .update({ value: { date } })
        .eq("key", "last_rotation_review")
        .select("*")
        .single();
      if (error) throw new Error(`Failed to mark review done: ${error.message}`);
      return ok({ success: true, message: `Rotation review marked done on ${date}.`, system_state: data });
    },
  );

  // ----- READS -----------------------------------------------------------

  server.tool(
    "wd_get_inventory",
    "List wardrobe items with optional filters. Retired items are excluded unless you pass status='retired' (or status='all'). Every row carries its own wear and recommendation recency, so composing a recommendation needs no second call. `total_wears` is the authoritative wear count for an item. Claims that an item has never been worn, or is on its first wear, must be sourced from this field. Do not infer wear history from `condition`, `acquired_on`, `fit_notes`, or prose in `notes` — those fields are frequently stale and are not wear data. A `total_wears` of 0 means never worn, and is stated as 0 rather than omitted. `last_recommended_for` is the other half of recency: an item that was recommended but not worn still counts against the 7-day rule for shirts, tees and socks.",
    {
      category: z.string().optional(),
      register: z.string().optional(),
      status: z.string().optional().describe("incoming | active | under_review | retired | all (default: all non-retired)"),
      color_family: z.string().optional(),
      season: z.string().optional().describe("spring | summer | fall | winter — items usable that season"),
      weight: z.string().optional().describe("light | mid | heavy"),
      limit: z.number().int().optional().describe("Max rows (default 200)"),
    },
    async ({ category, register, status, color_family, season, weight, limit }) => {
      let q = supabase.from("items").select(ITEM_COLUMNS);

      if (status === "all") {
        // no status filter
      } else if (status) {
        q = q.eq("status", status);
      } else {
        q = q.neq("status", "retired");
      }
      if (category) q = q.eq("category", category);
      if (register) q = q.eq("register", register);
      if (color_family) q = q.eq("color_family", color_family);
      if (weight) q = q.eq("weight", weight);
      if (season) q = q.contains("seasons", [season]);

      q = q.order("category", { ascending: true }).order("name", { ascending: true })
        .limit(limit || 200);

      // Items and stats in parallel: two round trips total, regardless of how
      // many rows come back.
      const [itemsRes, statsMap] = await Promise.all([q, fetchStatsMap(supabase)]);
      if (itemsRes.error) {
        throw new Error(`Failed to list inventory: ${itemsRes.error.message}`);
      }

      const items = (itemsRes.data || []).map((item) => ({
        ...item,
        ...normalizeStats(statsMap.get(item.id)),
      }));
      return ok({ success: true, count: items.length, items });
    },
  );

  server.tool(
    "wd_get_item",
    "Get the full record for one item plus its wear statistics (total wears, last worn, days since worn, wears in last 30/90 days) and its recommendation recency. Reference by `item_id` or unambiguous `name_match`. `total_wears` is the authoritative wear count for an item. Claims that an item has never been worn, or is on its first wear, must be sourced from this field. Do not infer wear history from `condition`, `acquired_on`, `fit_notes`, or prose in `notes` — those fields are frequently stale and are not wear data. These numbers come from the same view that backs `wd_get_inventory`, so the two tools always agree. Also returns `source_spec` — the captured product-page text, which the list read omits — and `photo_count`, broken out by kind. Call `wd_get_photos` for the frames themselves; only a `reference` frame may be read for colour.",
    {
      item_id: z.string().optional().describe("Item UUID"),
      name_match: z.string().optional().describe("Case-insensitive substring of the item name; must be unambiguous"),
    },
    async ({ item_id, name_match }) => {
      const id = await resolveSingleId(supabase, item_id, name_match);
      if ("error" in id) return id.error;

      const [itemRes, statsRes, photoRes] = await Promise.all([
        supabase.from("items").select(ITEM_COLUMNS_FULL).eq("id", id.value).single(),
        supabase.from("v_item_stats").select(STATS_COLUMNS).eq("id", id.value).maybeSingle(),
        supabase.from("photos").select("kind").eq("item_id", id.value),
      ]);
      if (itemRes.error) throw new Error(`Failed to get item: ${itemRes.error.message}`);
      if (statsRes.error) throw new Error(`Failed to get item stats: ${statsRes.error.message}`);
      if (photoRes.error) throw new Error(`Failed to count photos: ${photoRes.error.message}`);

      const stats = normalizeStats(statsRes.data);

      // Counts only. Signed URLs are minted on request by wd_get_photos —
      // putting them here would attach an expiring credential to every read.
      const photoRows = (photoRes.data || []) as { kind: string }[];
      const photo_count = {
        total: photoRows.length,
        stock: photoRows.filter((p) => p.kind === "stock").length,
        reference: photoRows.filter((p) => p.kind === "reference").length,
        outfit: photoRows.filter((p) => p.kind === "outfit").length,
      };
      return ok({
        success: true,
        item: itemRes.data,
        wear_stats: {
          id: itemRes.data.id,
          name: itemRes.data.name,
          category: itemRes.data.category,
          register: itemRes.data.register,
          status: itemRes.data.status,
          total_wears: stats.total_wears,
          last_worn: stats.last_worn,
          days_since_worn: stats.days_since_worn,
          wears_30d: stats.wears_30d,
          wears_90d: stats.wears_90d,
        },
        recommendation_stats: {
          total_recommendations: stats.total_recommendations,
          last_recommended_for: stats.last_recommended_for,
          days_since_recommended: stats.days_since_recommended,
        },
        photo_count,
      });
    },
  );

  server.tool(
    "wd_get_photos",
    "List the photographs attached to one garment (`item_ref`) or one wear event (`event_id`), each with a freshly signed URL valid for one hour. Ordered by `kind`, then oldest first. Every row carries `color_authoritative` explicitly: it is true only for `kind: 'reference'` (the owner's garment under controlled light with a colour chart in frame). Colour values may be read ONLY from a frame where it is true. A `stock` frame is retailer photography graded for appeal — it is the most authoritative-looking and least colour-faithful image here, and is for identification, as-new baseline and construction detail only, never colour, fit or proportion. An `outfit` frame is a mirror snap: fit and provenance, never colour.",
    {
      item_ref: z.string().optional().describe("Item UUID or case-insensitive name substring. Mutually exclusive with event_id."),
      event_id: z.string().optional().describe("Wear event UUID. Mutually exclusive with item_ref."),
      kind: z.enum(["stock", "reference", "outfit"]).optional().describe("Filter to one kind"),
      shot_type: z.enum(["flatlay", "on_model", "detail", "swatch", "full_length", "other"]).optional().describe("Filter to one shot type"),
    },
    async ({ item_ref, event_id, kind, shot_type }) => {
      const subjectRes = await resolvePhotoSubject(supabase, item_ref, event_id);
      if ("error" in subjectRes) return subjectRes.error;
      const subject = subjectRes.subject;

      let q = supabase.from("photos").select(PHOTO_COLUMNS);
      q = subject.kind === "item"
        ? q.eq("item_id", subject.id)
        : q.eq("event_id", subject.id);
      if (kind) q = q.eq("kind", kind);
      if (shot_type) q = q.eq("shot_type", shot_type);
      q = q.order("kind", { ascending: true }).order("created_at", { ascending: true });

      const { data, error } = await q;
      if (error) throw new Error(`Failed to list photos: ${error.message}`);

      const rows = data || [];
      const signed = await signPhotoPaths(supabase, rows.map((r) => r.storage_path));
      const photos = rows.map((r) => ({
        ...r,
        photo_id: r.id,
        signed_url: signed.get(r.storage_path) ?? null,
      }));

      return ok({
        success: true,
        subject: subject.kind === "item"
          ? { kind: "item", id: subject.id, name: subject.name }
          : { kind: "event", id: subject.id, worn_on: subject.worn_on },
        count: photos.length,
        color_authoritative_count: photos.filter((p) => p.color_authoritative).length,
        photos,
      });
    },
  );

  server.tool(
    "wd_wear_history",
    "List wear events, newest first, with the items worn in each. Filter by date range, a specific item, a context substring, and/or an audience tag. Answers 'when did I last wear X in front of Y'.",
    {
      item_id: z.string().optional().describe("Only events including this item UUID"),
      name_match: z.string().optional().describe("Only events including the item matching this name substring (must be unambiguous)"),
      audience: z.string().optional().describe("Only events tagged with this audience, e.g. 'team' or 'Webb'"),
      context: z.string().optional().describe("Case-insensitive substring match on context"),
      from: z.string().optional().describe("YYYY-MM-DD, inclusive lower bound on worn_on"),
      to: z.string().optional().describe("YYYY-MM-DD, inclusive upper bound on worn_on"),
      limit: z.number().int().optional().describe("Max events (default 50)"),
    },
    async ({ item_id, name_match, audience, context, from, to, limit }) => {
      let restrictItemId: string | null = null;
      if (item_id || name_match) {
        const id = await resolveSingleId(supabase, item_id, name_match);
        if ("error" in id) return id.error;
        restrictItemId = id.value;
      }

      let eventIds: string[] | null = null;
      if (restrictItemId) {
        const { data: links, error } = await supabase
          .from("wear_event_items")
          .select("wear_event_id")
          .eq("item_id", restrictItemId);
        if (error) throw new Error(`Failed to filter by item: ${error.message}`);
        eventIds = (links || []).map((l) => l.wear_event_id);
        if (eventIds.length === 0) {
          return ok({ success: true, count: 0, events: [], note: "No wear events for that item." });
        }
      }

      let q = supabase.from("wear_events").select("*");
      if (eventIds) q = q.in("id", eventIds);
      if (audience) q = q.contains("audience", [audience]);
      if (context) q = q.ilike("context", `%${context}%`);
      if (from) q = q.gte("worn_on", from);
      if (to) q = q.lte("worn_on", to);
      q = q.order("worn_on", { ascending: false }).limit(limit || 50);

      const { data: events, error } = await q;
      if (error) throw new Error(`Failed to get wear history: ${error.message}`);
      if (!events || events.length === 0) {
        return ok({ success: true, count: 0, events: [] });
      }

      // Attach the items worn in each event.
      const ids = events.map((e) => e.id);
      const { data: links, error: linkErr } = await supabase
        .from("wear_event_items")
        .select("wear_event_id, items(id, name, category)")
        .in("wear_event_id", ids);
      if (linkErr) throw new Error(`Failed to load worn items: ${linkErr.message}`);

      const byEvent = new Map<string, unknown[]>();
      for (const l of links || []) {
        const arr = byEvent.get(l.wear_event_id) || [];
        arr.push(l.items);
        byEvent.set(l.wear_event_id, arr);
      }

      const enriched = events.map((e) => ({ ...e, items: byEvent.get(e.id) || [] }));
      return ok({ success: true, count: enriched.length, events: enriched });
    },
  );

  server.tool(
    "wd_recommendation_history",
    "List recommendations, newest first by recommended_for, each with its options and their items (plus outcome, deviation_notes, and chosen_option_id). Filter by date range, a specific item (only proposals that included it in any option), outcome, audience tag, or context substring. This is the exclusion step before proposing: check what was recently recommended, not just recently worn. Each item carries days_since_recommended.",
    {
      item_id: z.string().optional().describe("Only recommendations that included this item UUID in any option"),
      name_match: z.string().optional().describe("Only recommendations including the item matching this name substring (must be unambiguous)"),
      outcome: z.string().optional().describe("pending | worn_as_proposed | worn_with_deviation | declined | superseded | unknown"),
      audience: z.string().optional().describe("Only recommendations tagged with this audience, e.g. 'team' or 'Webb'"),
      context: z.string().optional().describe("Case-insensitive substring match on context"),
      from: z.string().optional().describe("YYYY-MM-DD, inclusive lower bound on recommended_for"),
      to: z.string().optional().describe("YYYY-MM-DD, inclusive upper bound on recommended_for"),
      limit: z.number().int().optional().describe("Max recommendations (default 20)"),
    },
    async ({ item_id, name_match, outcome, audience, context, from, to, limit }) => {
      let restrictRecIds: string[] | null = null;
      if (item_id || name_match) {
        const id = await resolveSingleId(supabase, item_id, name_match);
        if ("error" in id) return id.error;
        const { data: itemLinks, error: ilErr } = await supabase
          .from("recommendation_option_items")
          .select("recommendation_option_id")
          .eq("item_id", id.value);
        if (ilErr) throw new Error(`Failed to filter by item: ${ilErr.message}`);
        const optIds = (itemLinks || []).map((l) => l.recommendation_option_id);
        if (optIds.length === 0) {
          return ok({ success: true, count: 0, recommendations: [], note: "No recommendations include that item." });
        }
        const { data: opts, error: optErr } = await supabase
          .from("recommendation_options")
          .select("recommendation_id")
          .in("id", optIds);
        if (optErr) throw new Error(`Failed to filter by item: ${optErr.message}`);
        restrictRecIds = [...new Set((opts || []).map((o) => o.recommendation_id))];
      }

      let q = supabase.from("recommendations").select("*");
      if (restrictRecIds) q = q.in("id", restrictRecIds);
      if (outcome) q = q.eq("outcome", outcome);
      if (audience) q = q.contains("audience", [audience]);
      if (context) q = q.ilike("context", `%${context}%`);
      if (from) q = q.gte("recommended_for", from);
      if (to) q = q.lte("recommended_for", to);
      q = q.order("recommended_for", { ascending: false }).limit(limit || 20);

      const { data: recs, error } = await q;
      if (error) throw new Error(`Failed to get recommendation history: ${error.message}`);
      if (!recs || recs.length === 0) {
        return ok({ success: true, count: 0, recommendations: [] });
      }

      // Attach options and their items.
      const recIds = recs.map((r) => r.id);
      const { data: opts, error: optsErr } = await supabase
        .from("recommendation_options")
        .select("*")
        .in("recommendation_id", recIds)
        .order("option_index", { ascending: true });
      if (optsErr) throw new Error(`Failed to load options: ${optsErr.message}`);

      const optIds = (opts || []).map((o) => o.id);
      const { data: links, error: linkErr } = optIds.length > 0
        ? await supabase
          .from("recommendation_option_items")
          .select("recommendation_option_id, items(id, name, category)")
          .in("recommendation_option_id", optIds)
        : { data: [], error: null };
      if (linkErr) throw new Error(`Failed to load option items: ${linkErr.message}`);

      const itemsByOption = new Map<string, unknown[]>();
      for (const l of links || []) {
        const arr = itemsByOption.get(l.recommendation_option_id) || [];
        arr.push(l.items);
        itemsByOption.set(l.recommendation_option_id, arr);
      }
      const optionsByRec = new Map<string, unknown[]>();
      // Both dates are literal YYYY-MM-DD, so Date.parse compares them at UTC
      // midnight and the difference is exact whole days.
      const today = todayLA();
      for (const o of opts || []) {
        const rec = recs.find((r) => r.id === o.recommendation_id);
        const daysSince = rec
          ? Math.floor((Date.parse(today) - Date.parse(rec.recommended_for)) / 86400000)
          : null;
        const arr = optionsByRec.get(o.recommendation_id) || [];
        arr.push({
          ...o,
          items: (itemsByOption.get(o.id) || []).map((it) => ({
            ...(it as Record<string, unknown>),
            days_since_recommended: daysSince,
          })),
        });
        optionsByRec.set(o.recommendation_id, arr);
      }

      const enriched = recs.map((r) => ({ ...r, options: optionsByRec.get(r.id) || [] }));
      return ok({ success: true, count: enriched.length, recommendations: enriched });
    },
  );

  server.tool(
    "wd_eligibility",
    "Deterministic 7-day rotation eligibility for a given date — the one source of truth for the shirt / tee / sock recency rule. Call this before composing a recommendation and quote its buckets; never derive eligibility from inventory or history yourself. Governed = active items in category shirt, tee or socks, plus knitwear whose subcategory is a tee / t-shirt / tank (loopwheel tees are catalogued under knitwear). Buckets, first match wins: `blocked_worn` (worn 0–6 days before for_date — never propose), `boundary` (worn exactly 7 days before — eligible, flagged), `config_flag` (an unworn recommendation inside the window — the item IS eligible, but do not re-propose that configuration; the other items from that option are attached), `eligible`, `exempt` (not governed — shown for information, never blocked). Items with `under_rotation` (no logged wear, or unworn >= dormancy_days) never land in config_flag. `never_worn` and `never_recommended` list governed items by name so a null never has to be noticed. Every list is complete and sorted by name; `days_since_*` count back from for_date, not from today. The returned `run_id` is required by wd_log_recommendation for the same date and stays valid for 30 minutes.",
    {
      for_date: z.string().describe("YYYY-MM-DD the outfit is FOR; compared literally, no timezone conversion"),
      categories: z.array(z.string()).optional().describe("Categories to evaluate (default: shirt, tee, socks, knitwear). Any other category is returned as exempt with its recency, never blocked."),
      dormancy_days: z.number().int().optional().describe("Threshold for the under_rotation flag (default 30)"),
    },
    async ({ for_date, categories, dormancy_days }) => {
      if (!isLiteralDate(for_date)) {
        return ok({ success: false, message: `"${for_date}" is not a valid for_date (YYYY-MM-DD expected).` });
      }
      const result = await computeEligibility(
        supabase,
        for_date,
        categories && categories.length > 0 ? categories : undefined,
        dormancy_days,
      );
      return ok({ success: true, ...result });
    },
  );

  server.tool(
    "wd_rotation_report",
    "The rotation-review report. Returns three lists — dormant (active items unworn for >= N days, default 60), over-worn (>= M wears in the last 30 days, default 6), and items currently under_review — plus the last rotation review date and days_since_review. Interpret dormancy seasonally; the report surfaces, you judge.",
    {
      dormant_days: z.number().int().optional().describe("N: days unworn to count as dormant (default 60)"),
      overworn_count: z.number().int().optional().describe("M: wears in last 30 days to count as over-worn (default 6)"),
    },
    async ({ dormant_days, overworn_count }) => {
      const n = dormant_days ?? 60;
      const m = overworn_count ?? 6;

      const [statsRes, reviewRes, underReviewRes] = await Promise.all([
        supabase.from("v_item_wear_stats").select("*").eq("status", "active"),
        supabase.from("system_state").select("value").eq("key", "last_rotation_review").maybeSingle(),
        supabase.from("items").select(ITEM_COLUMNS).eq("status", "under_review")
          .order("name", { ascending: true }),
      ]);
      if (statsRes.error) throw new Error(`Failed to load wear stats: ${statsRes.error.message}`);
      if (reviewRes.error) throw new Error(`Failed to load review state: ${reviewRes.error.message}`);
      if (underReviewRes.error) throw new Error(`Failed to load under_review items: ${underReviewRes.error.message}`);

      const stats = statsRes.data || [];
      const dormant = stats
        .filter((s) => s.last_worn === null || (s.days_since_worn ?? Infinity) >= n)
        .sort((a, b) => (b.days_since_worn ?? Infinity) - (a.days_since_worn ?? Infinity));
      const overworn = stats
        .filter((s) => (s.wears_30d ?? 0) >= m)
        .sort((a, b) => (b.wears_30d ?? 0) - (a.wears_30d ?? 0));

      const reviewDate: string | null =
        (reviewRes.data?.value as { date?: string | null } | undefined)?.date ?? null;
      const daysSinceReview = reviewDate
        ? Math.floor((Date.now() - new Date(reviewDate).getTime()) / 86400000)
        : null;

      return ok({
        success: true,
        thresholds: { dormant_days: n, overworn_count: m },
        last_rotation_review: reviewDate,
        days_since_review: daysSinceReview,
        review_overdue: daysSinceReview === null ? null : daysSinceReview > 30,
        dormant: { count: dormant.length, items: dormant },
        overworn: { count: overworn.length, items: overworn },
        under_review: { count: underReviewRes.data.length, items: underReviewRes.data },
      });
    },
  );

  server.tool(
    "wd_get_outfits",
    "List saved outfits with their items. Optionally filter by register or to only outfits that contain a given item (`item_id` or `name_match`).",
    {
      register: z.string().optional(),
      item_id: z.string().optional().describe("Only outfits containing this item UUID"),
      name_match: z.string().optional().describe("Only outfits containing the item matching this name substring (must be unambiguous)"),
    },
    async ({ register, item_id, name_match }) => {
      let restrictOutfitIds: string[] | null = null;
      if (item_id || name_match) {
        const id = await resolveSingleId(supabase, item_id, name_match);
        if ("error" in id) return id.error;
        const { data: links, error } = await supabase
          .from("outfit_items")
          .select("outfit_id")
          .eq("item_id", id.value);
        if (error) throw new Error(`Failed to filter outfits by item: ${error.message}`);
        restrictOutfitIds = (links || []).map((l) => l.outfit_id);
        if (restrictOutfitIds.length === 0) {
          return ok({ success: true, count: 0, outfits: [], note: "No saved outfits contain that item." });
        }
      }

      let q = supabase.from("outfits").select("*");
      if (register) q = q.eq("register", register);
      if (restrictOutfitIds) q = q.in("id", restrictOutfitIds);
      q = q.order("created_at", { ascending: false });

      const { data: outfits, error } = await q;
      if (error) throw new Error(`Failed to list outfits: ${error.message}`);
      if (!outfits || outfits.length === 0) {
        return ok({ success: true, count: 0, outfits: [] });
      }

      const ids = outfits.map((o) => o.id);
      const { data: links, error: linkErr } = await supabase
        .from("outfit_items")
        .select("outfit_id, items(id, name, category)")
        .in("outfit_id", ids);
      if (linkErr) throw new Error(`Failed to load outfit items: ${linkErr.message}`);

      const byOutfit = new Map<string, unknown[]>();
      for (const l of links || []) {
        const arr = byOutfit.get(l.outfit_id) || [];
        arr.push(l.items);
        byOutfit.set(l.outfit_id, arr);
      }

      const enriched = outfits.map((o) => ({ ...o, items: byOutfit.get(o.id) || [] }));
      return ok({ success: true, count: enriched.length, outfits: enriched });
    },
  );

  return server;
}

/**
 * Resolve a single item from an optional id + optional name_match. Returns
 * either { value } or { error } where error is a ready-to-return tool result
 * (candidates listed on ambiguity, message on no-match / bad input).
 */
async function resolveSingleId(
  supabase: SupabaseClient,
  itemId?: string,
  nameMatch?: string,
): Promise<{ value: string } | { error: ReturnType<typeof ok> }> {
  if (itemId) return { value: itemId };
  if (!nameMatch) {
    return {
      error: ok({
        success: false,
        message: "Provide either item_id or name_match.",
      }),
    };
  }
  const res = await resolveItemRef(supabase, nameMatch);
  if (res.status === "ok") return { value: res.item.id };
  if (res.status === "ambiguous") {
    return {
      error: ok({
        success: false,
        message: `Ambiguous name match for "${nameMatch}" — specify item_id.`,
        candidates: res.candidates,
      }),
    };
  }
  return {
    error: ok({ success: false, message: `No item matched "${nameMatch}".` }),
  };
}

// --- Hono app: auth + CORS + transport -----------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-access-key, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// JSON-RPC error envelope for auth failures (HTTP 200). Strict MCP hosts treat
// bare HTTP 4xx as transport faults and tear the connection down; wrapping the
// rejection in a JSON-RPC error keeps the connection alive. Mirrors the base
// open-brain-mcp server.
const JSON_RPC_UNAUTHORIZED_CODE = -32001;
const UNAUTHORIZED_MESSAGE = "Unauthorized: missing or invalid authentication.";

async function readBodyText(req: Request): Promise<string | null> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") {
    return null;
  }
  try {
    return await req.text();
  } catch {
    return null;
  }
}

function extractJsonRpcId(bodyText: string | null): string | number | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      const id = (parsed as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number" || id === null) {
        return id;
      }
    }
  } catch {
    // malformed body
  }
  return null;
}

function unauthorizedResponse(id: string | number | null): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: JSON_RPC_UNAUTHORIZED_CODE, message: UNAUTHORIZED_MESSAGE },
      id,
    }),
    { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
  );
}

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

/**
 * OAuth discovery probes must 404.
 *
 * This server does not use OAuth. It authenticates with a shared key, passed
 * as `?key=` or the `x-access-key` / `x-brain-key` header. But a connector
 * client doesn't know that until it asks: before falling back to an
 * unauthenticated connection it probes for OAuth metadata (RFC 8414 / RFC
 * 9728) and, if it finds any, for a dynamic client registration endpoint.
 *
 * The catch-all health GET below answers EVERY path with HTTP 200 and a
 * health document. To a probing client, 200 on
 * `/.well-known/oauth-authorization-server` reads as "yes, this resource is
 * OAuth-protected, and this is its metadata" — so it stops considering the
 * no-auth path, then fails to register a client against a document that has
 * no `registration_endpoint`, and surfaces "couldn't register with the
 * sign-in service". The server looked like it had a broken OAuth setup rather
 * than no OAuth at all.
 *
 * 404 is the correct and required signal here: there is no authorization
 * server, use the key. This must stay ahead of the catch-all.
 */
const OAUTH_PROBE_PATH_RE =
  /\/\.well-known\/(oauth-authorization-server|oauth-protected-resource|openid-configuration)|\/register$/;

app.use("*", async (c, next) => {
  if (OAUTH_PROBE_PATH_RE.test(new URL(c.req.url).pathname)) {
    return c.json(
      {
        error: "not_found",
        message:
          "This server does not use OAuth. Authenticate with the access key: append ?key=<WD_ACCESS_KEY> to the connector URL, or send it as the x-access-key header.",
      },
      404,
      corsHeaders,
    );
  }
  await next();
});

// Lightweight health check (no auth, no body) for GET pings.
app.get("*", (c) => {
  const provided = c.req.query("key") ||
    c.req.header("x-access-key") || c.req.header("x-brain-key");
  if (!WD_ACCESS_KEY || provided !== WD_ACCESS_KEY) {
    // Still answer GET pings without leaking auth as a transport fault.
    return c.json({ status: "ok", service: "Wardrobe System", version: "1.0.0", authenticated: false }, 200, corsHeaders);
  }
  return c.json({ status: "ok", service: "Wardrobe System", version: "1.0.0", authenticated: true }, 200, corsHeaders);
});

app.all("*", async (c) => {
  const provided = c.req.query("key") ||
    c.req.header("x-access-key") || c.req.header("x-brain-key");
  if (!WD_ACCESS_KEY || provided !== WD_ACCESS_KEY) {
    const bodyText = await readBodyText(c.req.raw);
    return unauthorizedResponse(extractJsonRpcId(bodyText));
  }

  // Claude Desktop connectors don't always send the Accept header that
  // StreamableHTTPTransport requires; patch it in if missing.
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const server = buildServer(supabase);
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
