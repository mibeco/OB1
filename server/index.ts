import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const OB_ACCESS_KEY = Deno.env.get("OB_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
/**
 * The database credential this function runs under.
 *
 * `OB_DB_TOKEN` is a JWT whose `role` claim is `open_brain_mcp` — a role
 * granted exactly what this server uses and nothing else: `public.thoughts`,
 * `match_thoughts`, `upsert_thought`, and usage on the `extensions` schema for
 * the `vector` type. It has NOBYPASSRLS, so row-level security actually
 * applies to it (see server/migrations/001_least_privilege_role.sql).
 *
 * What that replaces: `service_role`, which carries BYPASSRLS and, audited
 * 2026-09-20, could read 30 tables across 5 schemas with full CRUD —
 * `vault.secrets`, `vault.decrypted_secrets`, every storage bucket, and every
 * wardrobe table. This server reads one table. The code was always
 * well-behaved; the credential simply reached far past it, and the thing it
 * guards — 155 rows of personal memory — deserved better than a key that also
 * opened everything else in the project.
 *
 * The `apikey` header must still be a real project API key: the Supabase
 * gateway checks it before PostgREST is reached and rejects anything else with
 * "Invalid API key". It is the Authorization bearer that selects the database
 * role. The anon key serves as gateway admission and grants nothing on its own.
 *
 * FALLBACK, deliberate. With `OB_DB_TOKEN` unset this reverts to the service
 * role, so a bad deploy is undone by `supabase secrets unset OB_DB_TOKEN` with
 * no code change. That is also the mitigation for the standing risk that
 * Supabase retires the legacy HS256 verification this token relies on — its
 * signing secret is the dashboard's "Legacy JWT secret", because the project
 * now signs with ES256 keys that cannot sign claims of our choosing.
 *
 * Presence of OB_DB_TOKEN decides the mode on its own. There is deliberately
 * no path where the scoped role is requested and service-role access is what
 * actually runs — a silent downgrade would look like a clean deploy while the
 * privilege reduction quietly had not happened.
 */
const OB_DB_TOKEN = Deno.env.get("OB_DB_TOKEN");

const supabase = OB_DB_TOKEN
  ? createClient(
    SUPABASE_URL,
    Deno.env.get("SUPABASE_ANON_KEY") ?? SUPABASE_SERVICE_ROLE_KEY,
    { global: { headers: { Authorization: `Bearer ${OB_DB_TOKEN}` } } },
  )
  : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type ThoughtMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
};

type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

const CITATION_BASE_URL =
  Deno.env.get("OPEN_BRAIN_CITATION_BASE_URL") || "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${id}`;
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
// research look for exact read-only `search` and `fetch` tool shapes.
server.registerTool(
  "search",
  {
    title: "Search Open Brain",
    description:
      "Search Open Brain memories by meaning. Use this read-only compatibility tool when ChatGPT needs search/fetch-style access to stored thoughts.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("The search query to run against Open Brain thoughts"),
    },
  },
  async ({ query }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: 0.5,
        match_count: 10,
        filter: {},
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      const results = ((data || []) as ThoughtMatch[]).map((t) => ({
        id: t.id,
        title: thoughtTitle(t.content, t.created_at),
        url: thoughtUrl(t.id),
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "fetch",
  {
    title: "Fetch Open Brain Thought",
    description:
      "Fetch one Open Brain thought by ID after using search. Use this read-only compatibility tool to retrieve the full text and metadata for citation.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      id: z.string().describe("The Open Brain thought ID returned by the search tool"),
    },
  },
  async ({ id }) => {
    try {
      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .eq("id", id)
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Fetch error: ${error.message}` }],
          isError: true,
        };
      }

      const thought = data as ThoughtRecord;
      const document = {
        id: thought.id,
        title: thoughtTitle(thought.content, thought.created_at),
        text: thought.content,
        url: thoughtUrl(thought.id),
        metadata: {
          ...thought.metadata,
          created_at: thought.created_at,
          updated_at: thought.updated_at,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(document) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 1: Semantic Search
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
        };
      }

      const results = data.map(
        (
          t: ThoughtMatch,
          i: number
        ) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: List Recent
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const results = data.map(
        (
          t: { content: string; metadata: Record<string, unknown>; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase
        .from("thoughts")
        .select("*", { count: "exact", head: true });

      const { data } = await supabase
        .from("thoughts")
        .select("metadata, created_at")
        .order("created_at", { ascending: false });

      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " → " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems.",
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
        p_content: content,
        p_payload: { metadata: { ...metadata, source: "mcp" } },
      });

      if (upsertError) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture: ${upsertError.message}` }],
          isError: true,
        };
      }

      const thoughtId = upsertResult?.id;
      const { error: embError } = await supabase
        .from("thoughts")
        .update({ embedding })
        .eq("id", thoughtId);

      if (embError) {
        return {
          content: [{ type: "text" as const, text: `Failed to save embedding: ${embError.message}` }],
          isError: true,
        };
      }

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-access-key, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// JSON-RPC error code for unauthorized requests.
// Per the JSON-RPC 2.0 spec, the range -32099 to -32000 is reserved for
// implementation-defined server errors. -32001 is the conventional
// "Unauthorized" code used by MCP clients/servers in the wild.
//
// Why a JSON-RPC envelope (HTTP 200) instead of a bare HTTP 401?
// Strict MCP hosts (Codex CLI, Claude Code) treat bare HTTP 4xx responses
// as transport-level failures and tear the connection down rather than
// surfacing the failure to the application layer. Wrapping the auth
// rejection in a JSON-RPC error keeps the connection alive and lets
// clients recover (e.g. prompt the user for a new key, refetch a stale
// cache) instead of dying.
const JSON_RPC_UNAUTHORIZED_CODE = -32001;
const UNAUTHORIZED_MESSAGE = "Unauthorized: missing or invalid authentication.";

/**
 * Read the request body as text without consuming the original request's
 * body stream for downstream handlers. Returns null on bodyless methods
 * or read failure.
 */
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

/**
 * Best-effort extraction of the JSON-RPC `id` from a raw request body.
 * Returns null when the body is missing, not JSON, or not a JSON-RPC
 * shape with an id. Per the JSON-RPC 2.0 spec, id may be a string,
 * number, or null — we preserve any of those; anything else becomes null.
 */
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
    // fall through — malformed body
  }
  return null;
}

/**
 * Build a JSON-RPC 2.0 error envelope response for auth failures.
 * Returns HTTP 200 — the JSON-RPC layer expresses the error so that
 * strict MCP clients keep the connection alive instead of treating
 * the failure as a transport-level fault.
 */
function unauthorizedResponse(id: string | number | null): Response {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: JSON_RPC_UNAUTHORIZED_CODE,
      message: UNAUTHORIZED_MESSAGE,
    },
    id,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

// --- OAuth 2.1 resource server (dormant until configured) ----------------

/**
 * OAuth, as a resource server in front of Supabase Auth's OAuth 2.1 server.
 *
 * DORMANT BY DEFAULT. Nothing here runs unless all three secrets are set:
 *
 *   OB_PUBLIC_URL          this server's URL EXACTLY as typed into the
 *                          connector. It is published as `resource`, and
 *                          Claude requires the two to match to the byte.
 *   OB_OAUTH_CLIENT_IDS    comma-separated OAuth client ids allowed to call.
 *   OB_OAUTH_ALLOWED_SUBS  comma-separated user UUIDs allowed to call.
 *
 * Until then the server behaves exactly as before: shared key, 200-wrapped
 * refusals. Unset any one of them to switch it back off.
 *
 * WHY THE LAST TWO ARE NOT OPTIONAL. Supabase sets `aud` to the fixed string
 * "authenticated" on every token the project issues; it validates the RFC 8707
 * `resource` parameter but never binds it into the token. So signature +
 * issuer + audience — the textbook check — accepts ANY token this project has
 * ever minted for anyone. What actually ties a token to this server is
 * `client_id` (present only on tokens issued through the OAuth server, to that
 * registered client) and `sub` (an explicit allowlist of owners). Use a client
 * id of this server's own: a token issued to another function's client must
 * not open the memory store.
 */
function envList(name: string): Set<string> {
  return new Set(
    (Deno.env.get(name) ?? "").split(",").map((v) => v.trim()).filter(Boolean),
  );
}

const OB_PUBLIC_URL = Deno.env.get("OB_PUBLIC_URL")?.trim();
const OB_OAUTH_CLIENT_IDS = envList("OB_OAUTH_CLIENT_IDS");
const OB_OAUTH_ALLOWED_SUBS = envList("OB_OAUTH_ALLOWED_SUBS");
const OAUTH_ENABLED = Boolean(
  OB_PUBLIC_URL && OB_OAUTH_CLIENT_IDS.size && OB_OAUTH_ALLOWED_SUBS.size,
);

const OAUTH_ISSUER = `${SUPABASE_URL}/auth/v1`;
const OAUTH_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const OAUTH_RESOURCE_METADATA_URL = `${OB_PUBLIC_URL}${OAUTH_RESOURCE_METADATA_PATH}`;

// Fetched lazily and cached by jose; rotated keys are picked up on a kid miss.
const oauthJwks = createRemoteJWKSet(
  new URL(`${OAUTH_ISSUER}/.well-known/jwks.json`),
);

/** Strictly `Bearer <one token>`; anything else is not a bearer credential. */
function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

/**
 * Verify an OAuth access token. Returns the caller, or null for ANY failure —
 * the reason is logged, never sent to the client.
 *
 * Asymmetric algorithms only: the project's legacy HS256 secret also signs
 * valid-looking tokens (the database role token is one), and none of those may
 * ever authenticate a caller here.
 */
async function verifyOAuthToken(
  token: string,
): Promise<{ sub: string; clientId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, oauthJwks, {
      issuer: OAUTH_ISSUER,
      audience: "authenticated",
      algorithms: ["ES256", "RS256"],
    });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    const clientId = typeof payload.client_id === "string" ? payload.client_id : "";
    if (!clientId || !OB_OAUTH_CLIENT_IDS.has(clientId)) {
      console.warn(`oauth: rejected, client_id not allowed (${clientId || "none"})`);
      return null;
    }
    if (!sub || !OB_OAUTH_ALLOWED_SUBS.has(sub)) {
      console.warn(`oauth: rejected, sub not allowed (${sub || "none"})`);
      return null;
    }
    return { sub, clientId };
  } catch (e) {
    console.warn(`oauth: rejected, ${(e as Error).message}`);
    return null;
  }
}

/**
 * The OAuth refusal: a real HTTP 401 carrying `WWW-Authenticate`. Claude only
 * starts (or refreshes) an OAuth flow on a transport-level 401 — it ignores
 * the header on a 200 — and `resource_metadata` is how it finds the metadata
 * on a host that cannot serve `/.well-known/*` at its root.
 */
function oauthChallengeResponse(
  id: string | number | null,
  tokenWasPresented: boolean,
): Response {
  const challenge = `Bearer resource_metadata="${OAUTH_RESOURCE_METADATA_URL}"` +
    (tokenWasPresented ? `, error="invalid_token"` : "");
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: JSON_RPC_UNAUTHORIZED_CODE, message: UNAUTHORIZED_MESSAGE },
      id,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": challenge,
        ...corsHeaders,
        "Access-Control-Expose-Headers": "WWW-Authenticate",
      },
    },
  );
}

const app = new Hono();

// CORS preflight — required for browser/Electron-based clients (Claude Desktop, claude.ai)
app.options("*", (c) => {
  return c.text("ok", 200, corsHeaders);
});

// Protected-resource metadata. Served from a subpath because the Supabase
// gateway owns `/.well-known/*` at the origin; the 401 challenge points here.
app.get("*", async (c, next) => {
  if (OAUTH_ENABLED && new URL(c.req.url).pathname.endsWith(OAUTH_RESOURCE_METADATA_PATH)) {
    return c.json(
      {
        resource: OB_PUBLIC_URL,
        authorization_servers: [OAUTH_ISSUER],
        bearer_methods_supported: ["header"],
        resource_name: "Open Brain",
      },
      200,
      { ...corsHeaders, "Cache-Control": "no-store" },
    );
  }
  await next();
});

app.all("*", async (c) => {
  // Accept the access key via either header name, or the URL query parameter.
  // `x-access-key` is the name the other Open Brain functions use; accepting it
  // here too means every connector in this project is configured identically,
  // which is what stops a key ending up back in a URL for want of a matching
  // header name. Prefer a header: query strings leak into history and logs.
  const provided = c.req.header("x-access-key") || c.req.header("x-brain-key") ||
    new URL(c.req.url).searchParams.get("key");
  let authenticated = Boolean(OB_ACCESS_KEY) && Boolean(provided) &&
    provided === OB_ACCESS_KEY;

  // OAuth is an ADDITIONAL way in: the static key keeps working until it is
  // deliberately removed (unset OB_ACCESS_KEY).
  const bearer = bearerToken(c.req.header("authorization"));
  const presentedJwt = OAUTH_ENABLED && !authenticated &&
    Boolean(bearer) && bearer!.split(".").length === 3;
  if (presentedJwt) {
    const caller = await verifyOAuthToken(bearer!);
    if (caller) {
      authenticated = true;
      console.log(`oauth: accepted sub=${caller.sub} client=${caller.clientId}`);
    }
  }

  if (!authenticated && OAUTH_ENABLED) {
    const bodyText = await readBodyText(c.req.raw);
    return oauthChallengeResponse(extractJsonRpcId(bodyText), presentedJwt);
  }

  if (!authenticated) {
    // Return a JSON-RPC 2.0 error envelope (HTTP 200) instead of a bare
    // HTTP 401 so strict MCP hosts treat this as an application-level
    // error rather than a transport fault and keep the connection alive.
    // Best-effort echo of the inbound request id keeps the response
    // correlated; malformed/missing bodies fall back to id: null.
    const bodyText = await readBodyText(c.req.raw);
    const id = extractJsonRpcId(bodyText);
    return unauthorizedResponse(id);
  }

  // Fix: Claude Desktop connectors don't send the Accept header that
  // StreamableHTTPTransport requires. Build a patched request if missing.
  // See: https://github.com/NateBJones-Projects/OB1/issues/33
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

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
