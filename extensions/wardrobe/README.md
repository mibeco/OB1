# Wardrobe System

## Why This Matters

You own more than you wear. The good chore coat sits dormant for three months while the same two hoodies carry every week. You wore the exact outfit to the last two dinners with the same people — and you can't remember, so you wear it again. You buy a fourth pair of tan trousers because you forgot you already had three. None of this is a taste problem; it's a memory problem. No one can hold a whole wardrobe, a wear history, and an audience calendar in their head at once.

This extension gives your agent the structured half of a personal sartorial system: a real inventory, a daily wear ledger with **audience tags**, a library of outfits that work, and a rotation report that surfaces what's gone dormant and what's over-worn. The qualitative half — your style identity, registers, fit profile, and principles — stays in your core Open Brain `thoughts` store, where any AI can read it. Together they let your agent recommend an outfit that fits the weather, the occasion, the people who'll see it, and *you*.

## What It Does

A wardrobe database and wear log exposed over MCP. It tracks:

- **Items** — every garment and accessory, with register, season, fabric, fit notes, condition, and lifecycle status (`incoming → active → under_review → retired`).
- **Wear events** — one row per wearing, linking the items worn, with context, weather, a 1–5 rating, and **audience tags** (the people or groups who would notice a repeat).
- **Outfits** — named, reusable combinations known to work.
- **Rotation analytics** — dormant items (active but long-unworn), over-worn items, and a review cadence so the monthly ritual actually happens.

This is the **structured/quantitative** layer. Durable *qualitative* notes — a style decision, a new principle, a person's reaction — are **not** wardrobe tools; they go to the base Open Brain via `capture_thought` so every connected AI can use them.

## What You'll Learn

- A single-owner structured extension with no RLS (contrast with the RLS-based extensions)
- Many-to-many link tables (`wear_event_items`, `outfit_items`) and PostgREST embedded joins
- Database **views** as an analytics layer (`v_item_wear_stats`, `v_dormant_items`, `v_overworn_items`, `v_item_audience_recency`)
- Robust **reference resolution**: tools accept either a UUID or a name substring and return candidates on ambiguity instead of guessing
- All-or-nothing writes: `wd_log_wear` resolves every item before writing so you never half-log an outfit
- A `system_state` key-value table for tracking a recurring cadence

## Prerequisites

- A working Open Brain setup (Supabase project + the core MCP server deployed). **Reuse it — do not create a new project or a new brain.**
- Supabase CLI installed and linked to your project
- Your existing **MCP Access Key** (the same key your other Open Brain connectors use)

## Credential Tracker

You already have all of these from your core Open Brain setup. Copy this block into a text editor and fill it in.

```text
WARDROBE SYSTEM -- CREDENTIAL TRACKER
-------------------------------------

SUPABASE (from your Open Brain setup)
  Project ref:           ____________
  Project URL:           ____________

MCP SERVER
  MCP Access Key:        ____________  (same key for all extensions)
  MCP Server URL:        https://<project-ref>.supabase.co/functions/v1/wardrobe-mcp
  MCP Connection URL:    https://<project-ref>.supabase.co/functions/v1/wardrobe-mcp?key=<access-key>

-------------------------------------
```

## Steps

### 1. Set Up the Database Schema

Run the SQL in `schema.sql` against your existing project — Supabase SQL Editor, or from your linked project folder:

```bash
supabase db query --linked -f extensions/wardrobe/schema.sql
```

This creates the tables (`items`, `wear_events`, `wear_event_items`, `outfits`, `outfit_items`, `system_state`), the analytics views, the `updated_at` triggers, and seeds the `last_rotation_review` state row. There is **no RLS** — this is a single-owner system. It does not touch your `thoughts` table.

### 2. Deploy the MCP Server

Follow the [Deploy an Edge Function](../../primitives/deploy-edge-function/) guide using these values:

| Setting | Value |
|---------|-------|
| Function name | `wardrobe-mcp` |
| Download path | `extensions/wardrobe` |

The function reads one secret, `MCP_ACCESS_KEY`, which you already set for your core Open Brain. Reuse it — no new secret needed. Deploy with `--no-verify-jwt`:

```bash
supabase functions deploy wardrobe-mcp --no-verify-jwt
```

### 3. Connect to Your AI

Follow the [Remote MCP Connection](../../primitives/remote-mcp/) guide. Add it as a **new connector alongside** your existing Open Brain — the `wd_` tools appear next to your core tools.

| Setting | Value |
|---------|-------|
| Connector name | `Wardrobe` |
| URL | Your **MCP Connection URL** (`…/functions/v1/wardrobe-mcp?key=…`) |

### 4. Seed Your Inventory

Tell your agent about what you own, in plain language, and let it draft `wd_add_item` calls — **confirming each before it writes**. Photos and email receipts work too: the agent extracts the attributes into a record; the image itself isn't stored.

## Available Tools

All tools use the `wd_` prefix and return JSON. Item references accept either `item_id` (UUID) or `name_match` (case-insensitive substring); on an ambiguous name, the tool returns the candidates instead of guessing.

**Writes**

1. **`wd_add_item`** — Add a garment/accessory. Required: `name`, `category`. Everything else optional. Use `status: "incoming"` for ordered-not-arrived.
2. **`wd_update_item`** — Partial update by id or unambiguous name. Fit notes, condition, pairing notes, status changes.
3. **`wd_retire_item`** — Convenience: sets `status: "retired"`, records `retired_on`, appends a reason to notes.
4. **`wd_log_wear`** — Log an outfit-of-the-day: one wear event + links to every item worn. Resolves **all** refs before writing; on any unresolved ref it logs nothing and returns the problems.
5. **`wd_save_outfit`** — Persist a named, reusable combination with register and notes.
6. **`wd_mark_review_done`** — Sets `last_rotation_review` to today. Call at the end of a rotation review.

**Reads**

7. **`wd_get_inventory`** — List items with filters: `category`, `register`, `status`, `color_family`, `season`, `weight`. Excludes retired unless asked.
8. **`wd_get_item`** — Full record for one item plus its wear stats (total/last/30d/90d).
9. **`wd_wear_history`** — Wear events filtered by date range, item, context, or audience tag. Answers "when did I last wear X around Y."
10. **`wd_rotation_report`** — Dormant (unworn ≥ N days, default 60), over-worn (≥ M wears in 30 days, default 6), and `under_review` items, plus `last_rotation_review` and `days_since_review`. N and M overridable.
11. **`wd_get_outfits`** — Saved outfits, optionally filtered by register or by containing item.

> **Note on qualitative notes.** There is intentionally no `wd_get_style_notes` tool and no `style_notes` table. Style identity, registers, principles, and person notes live in the base Open Brain `thoughts` store — capture them with `capture_thought` and retrieve them with `search_thoughts`. This keeps the structured wardrobe data and the qualitative wiki cleanly separated, and makes your style profile available to every connected AI, not just this extension.

## Conversational Workflows

These belong in your AI client's **project instructions**, not in code. The edge function exposes clean tools; your agent does the routing (the [schema-aware-routing](../../recipes/schema-aware-routing/) pattern — an LLM reads the input, decides which tables it touches, and calls the matching tools).

- **Intake.** Owner describes a purchase, pastes a photo, or points at a receipt. The agent drafts the `wd_add_item` record(s), **confirms**, then writes. Never write inventory without explicit confirmation.
- **OOTD logging.** "OOTD: tan chinos, Buzz Rickson workshirt, LMSM chore coat, Aldens — office, team offsite." The agent resolves items, calls `wd_log_wear` once, and replies with a one-line confirmation. Keep it a ten-second interaction; only open a conversation if an item fails to resolve.
- **Recommendation.** Before recommending, the agent silently gathers: weather, today's/tomorrow's calendar (to infer context and audience), `wd_get_inventory` (active), and `wd_wear_history` (last ~30 days, plus audience-filtered history for anyone on the calendar). It respects register, season/weather, recency (no repeats in front of the same audience), and the style profile in project knowledge. Confirm new audience tags rather than inventing them.
- **Monthly rotation review.** Run `wd_rotation_report`; talk through dormant items (work back in, move to `under_review`, or retire) and over-worn items, interpreting dormancy seasonally (an unworn linen shirt in February is not a finding). Write structured outcomes via `wd_update_item`; write durable qualitative conclusions via `capture_thought`. Close with `wd_mark_review_done`.

### Review cadence nudge

`system_state.last_rotation_review` is the source of truth. Add to your project instructions: whenever the agent touches the wardrobe database and `days_since_review > 30`, mention it **once** ("we're overdue for a rotation review — now or later?"). Don't nag within a conversation. `wd_rotation_report` returns `days_since_review` and a `review_overdue` flag to make this easy.

## Expected Outcome

After completing this extension, your agent can:

1. Maintain a structured inventory with register, season, fit, and lifecycle status
2. Log an outfit-of-the-day in one line, with audience tags
3. Answer "when did I last wear the chore coat in front of the team?"
4. Save and recall outfits that are known to work
5. Run a rotation report — what's gone dormant, what's over-worn, how overdue the review is
6. Recommend outfits grounded in inventory, wear history, weather, calendar, and your style profile

## Troubleshooting

For common issues (connection errors, 401s, deployment problems), see [Common Troubleshooting](../../primitives/troubleshooting/).

**Extension-specific issues:**

**`wd_log_wear` returns `success: false` with an `unresolved` list**
- This is by design — it resolves every item before writing so you never half-log an outfit. Fix the listed refs (use the returned candidate UUIDs for ambiguous names, or add the missing item first) and call again.

**"Ambiguous name match" on an update or lookup**
- Two or more items share that substring. Pass `item_id` (from the returned candidates) instead of `name_match`.

**Dormant report lists a seasonal item**
- Expected. The report surfaces; you interpret. A linen shirt dormant in February is not a problem — the seasonality judgment is deliberately left to conversation, not SQL.

**Wear stats look empty for a new item**
- `v_item_wear_stats` left-joins wear events, so a never-worn item shows `total_wears: 0` and `last_worn: null`. That's correct, and it's exactly what makes it show up as dormant.

## Contributing It Back

This extension follows the OB1 contribution layout (schema, edge-function server, `metadata.json`, README) so it can be proposed upstream. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for the metadata format and review process. Note that the `extensions/` path is a curated learning path — open a proposal issue before submitting.
