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
 * Conventions mirror extensions/professional-crm (tool registration, JSON
 * responses, error handling) and the base open-brain-mcp server (JSON-RPC
 * auth envelope, CORS, Accept-header patch). Tools use the `wd_` prefix.
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");

// --- Shared helpers ------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

function ok(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

const ITEM_COLUMNS =
  "id, name, category, subcategory, brand, color, color_family, fabric, weight, seasons, register, formality, size, fit_notes, condition, status, acquired_on, acquired_from, price_paid, retired_on, pairing_notes, notes, created_at, updated_at";

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

// --- MCP tools -----------------------------------------------------------

function buildServer(supabase: SupabaseClient): McpServer {
  const server = new McpServer({ name: "wardrobe", version: "1.0.0" });

  // ----- WRITES ----------------------------------------------------------

  server.tool(
    "wd_add_item",
    "Add a garment or accessory to the wardrobe inventory. Only `name` and `category` are required; supply whatever else you know. Use status 'incoming' for ordered-but-not-arrived pieces. Always confirm details with the owner before calling.",
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
    },
    async (args) => {
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) row[k] = v;
      }
      const { data, error } = await supabase
        .from("items")
        .insert(row)
        .select(ITEM_COLUMNS)
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
        .select(ITEM_COLUMNS)
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
    "Log an outfit-of-the-day: one wear event plus links to every item worn. Every ref in `item_refs` must resolve before anything is written — on any ambiguous or missing ref, nothing is logged and the problems are returned instead. Each ref is an item UUID or a case-insensitive name substring.",
    {
      item_refs: z.array(z.string()).min(1).describe('Items worn, e.g. ["tan chinos", "Buzz Rickson workshirt", "LMSM chore coat", "Aldens"]'),
      worn_on: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
      context: z.string().optional().describe("office, errands, dinner out, offsite, ..."),
      audience: z.array(z.string()).optional().describe('People/groups who would notice repeats, e.g. ["team", "Webb"]'),
      weather: z.string().optional(),
      rating: z.number().int().min(1).max(5).optional().describe("How the outfit felt, 1-5"),
      notes: z.string().optional(),
      outfit_id: z.string().optional().describe("Optional UUID of a saved outfit this wearing corresponds to"),
    },
    async ({ item_refs, worn_on, context, audience, weather, rating, notes, outfit_id }) => {
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
      if (worn_on) eventRow.worn_on = worn_on;
      if (context) eventRow.context = context;
      if (audience) eventRow.audience = audience;
      if (weather) eventRow.weather = weather;
      if (rating !== undefined) eventRow.rating = rating;
      if (notes) eventRow.notes = notes;
      if (outfit_id) eventRow.outfit_id = outfit_id;

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
    "wd_save_outfit",
    "Save a named, reusable outfit combination that is known to work. Every ref in `item_refs` must resolve before anything is written.",
    {
      name: z.string().describe('e.g. "bleu de travail + ecru workshirt + tan chinos + Aldens"'),
      item_refs: z.array(z.string()).min(1).describe("Items in the outfit (UUIDs or name substrings)"),
      register: z.string().optional().describe("heritage_workwear | smart_casual | tailored | crossover | athletic"),
      occasion: z.string().optional().describe("What it's for"),
      notes: z.string().optional().describe("Why it works, caveats"),
    },
    async ({ name, item_refs, register, occasion, notes }) => {
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
    "List wardrobe items with optional filters. Retired items are excluded unless you pass status='retired' (or status='all').",
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

      const { data, error } = await q;
      if (error) throw new Error(`Failed to list inventory: ${error.message}`);
      return ok({ success: true, count: data.length, items: data });
    },
  );

  server.tool(
    "wd_get_item",
    "Get the full record for one item plus its wear statistics (total wears, last worn, days since worn, wears in last 30/90 days). Reference by `item_id` or unambiguous `name_match`.",
    {
      item_id: z.string().optional().describe("Item UUID"),
      name_match: z.string().optional().describe("Case-insensitive substring of the item name; must be unambiguous"),
    },
    async ({ item_id, name_match }) => {
      const id = await resolveSingleId(supabase, item_id, name_match);
      if ("error" in id) return id.error;

      const [itemRes, statsRes] = await Promise.all([
        supabase.from("items").select(ITEM_COLUMNS).eq("id", id.value).single(),
        supabase.from("v_item_wear_stats").select("*").eq("id", id.value).maybeSingle(),
      ]);
      if (itemRes.error) throw new Error(`Failed to get item: ${itemRes.error.message}`);
      if (statsRes.error) throw new Error(`Failed to get wear stats: ${statsRes.error.message}`);

      return ok({ success: true, item: itemRes.data, wear_stats: statsRes.data });
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

// Lightweight health check (no auth, no body) for GET pings.
app.get("*", (c) => {
  const provided = c.req.query("key") ||
    c.req.header("x-access-key") || c.req.header("x-brain-key");
  if (!MCP_ACCESS_KEY || provided !== MCP_ACCESS_KEY) {
    // Still answer GET pings without leaking auth as a transport fault.
    return c.json({ status: "ok", service: "Wardrobe System", version: "1.0.0", authenticated: false }, 200, corsHeaders);
  }
  return c.json({ status: "ok", service: "Wardrobe System", version: "1.0.0", authenticated: true }, 200, corsHeaders);
});

app.all("*", async (c) => {
  const provided = c.req.query("key") ||
    c.req.header("x-access-key") || c.req.header("x-brain-key");
  if (!MCP_ACCESS_KEY || provided !== MCP_ACCESS_KEY) {
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
