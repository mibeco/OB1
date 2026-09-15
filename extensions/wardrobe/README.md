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

The function reads two secrets. `MCP_ACCESS_KEY` you already set for your core Open Brain — reuse it. `WD_ELIGIBILITY_SECRET` is new and dedicated: it signs `wd_eligibility` run tokens and must **not** be the service role key. Any random 32+ byte string works:

```bash
supabase secrets set WD_ELIGIBILITY_SECRET=$(openssl rand -hex 32)
```

Then deploy with `--no-verify-jwt`:

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
4. **`wd_log_wear`** — Log an outfit-of-the-day: one wear event + links to every item worn. Resolves **all** refs before writing; on any unresolved ref it logs nothing and returns the problems. `worn_on` defaults to today in America/Los_Angeles. Carries `register_note` and `paradigm_note` (see below).
5. **`wd_update_wear`** — Partial edit of a wear event by `event_id`: `worn_on`, `context`, `weather`, `audience`, `rating`, `notes`, `register_note`, `paradigm_note`. Optionally pass `item_refs` to **replace** the linked items (resolved all-or-nothing, same as `wd_log_wear`). `worn_on` is stored as a literal date.
6. **`wd_delete_wear`** — Delete a wear event and its item links by `event_id`. Returns the deleted id, `worn_on`, and the number of item links removed.
7. **`wd_log_recommendation`** — Log an outfit proposal at the moment it's made: one call per proposal event, with an `options` array (one entry per option offered, each with its own `item_refs`, optional `label` and `rationale`, and its own `register_note` and `paradigm_note`). All-or-nothing resolution across every option. `recommended_for` is stored literally; `proposed_on` defaults to today in America/Los_Angeles; `outcome` starts as `pending`. **Requires `eligibility_run_id`** from a `wd_eligibility` run for the same date, no older than 30 minutes; eligibility is recomputed at write time and any option containing a `blocked_worn` item is refused with nothing written (see below).
8. **`wd_update_recommendation`** — Close the loop by `recommendation_id`: set `outcome` (`worn_as_proposed` | `worn_with_deviation` | `declined` | `superseded` | `unknown`), `chosen_option_id` (validated against this recommendation's options), `wear_event_id`, and `deviation_notes` — the what-he-swapped-and-why signal. Options/items can't be edited; delete and re-log instead.
9. **`wd_delete_recommendation`** — Delete a recommendation with its options and item links by `recommendation_id`.
10. **`wd_save_outfit`** — Persist a named, reusable combination with register, notes, `register_note` and `paradigm_note`.
11. **`wd_mark_review_done`** — Sets `last_rotation_review` to today. Call at the end of a rotation review.

**Reads**

12. **`wd_get_inventory`** — List items with filters: `category`, `register`, `status`, `color_family`, `season`, `weight`. Excludes retired unless asked.
13. **`wd_get_item`** — Full record for one item plus its wear stats (total/last/30d/90d).
14. **`wd_wear_history`** — Wear events filtered by date range, item, context, or audience tag. Answers "when did I last wear X around Y."
15. **`wd_recommendation_history`** — Recommendations (newest first by `recommended_for`) with their options, items, `outcome`, `deviation_notes`, and `chosen_option_id`; filter by date range, item, outcome, audience, or context. Each item carries `days_since_recommended` — the exclusion step before proposing anything new.
16. **`wd_eligibility`** — Deterministic 7-day rotation eligibility for a date (see the note below). Returns every governed item in exactly one bucket — `blocked_worn`, `boundary`, `config_flag`, `eligible` — plus `exempt` for requested non-governed categories, `never_worn` / `never_recommended` name lists, and a signed `run_id`.
17. **`wd_rotation_report`** — Dormant (unworn ≥ N days, default 60), over-worn (≥ M wears in 30 days, default 6), and `under_review` items, plus `last_rotation_review` and `days_since_review`. N and M overridable.
18. **`wd_get_outfits`** — Saved outfits, optionally filtered by register or by containing item.

> **Register and paradigm tags.** Every formulated outfit — each recommendation option, each saved outfit, each wear event — carries two free-text fields: `register_note` (your own register system, which bundles lineage with a formality band) and `paradigm_note` (Simon Crompton's lineage-only taxonomy from *Five paradigms of casual clothing*, Permanent Style, 2018: British country, American prep, Italian smooth, Workwear, Sportswear). They are prose rather than enums on purpose: the interesting outfits are mixed, and a note can say "Workwear throughout; Italian smooth at the knit; deliberate collision at the footwear" where a category could not. The agent should fill both every time. Added in `migrations/003_register_paradigm_notes.sql`.

> **Rotation eligibility.** The 7-day recency rule — *never recommend the same shirt, sock, or tee within a rolling 7 days; recommended-but-unworn suppresses re-proposing the same configuration, not the item, and never applies to an under-rotation item* — is computed in one place in the edge function and never by the agent. `wd_eligibility(for_date)` evaluates every active item in `shirt`, `tee`, `socks`, and `knitwear` (knitwear is governed only where the subcategory is a tee / t-shirt / tank — loopwheel tees are catalogued there; sweaters, hoodies, henleys and vests come back `exempt`). Buckets, first match wins: `blocked_worn` (worn 0–6 days before `for_date`), `boundary` (exactly 7 — eligible, flagged), `config_flag` (an unworn recommendation 0–6 days before — the item is eligible, that configuration is not; the other items from that option are attached), `eligible`, `exempt`. `under_rotation` (no logged wear, or unworn ≥ `dormancy_days`, default 30) never lands in `config_flag`. `never_worn` and `never_recommended` are surfaced as name lists so a null is never something the reader has to notice. The response's `run_id` is a stateless HMAC token (`WD_ELIGIBILITY_SECRET`) over `{for_date, computed_at}`; `wd_log_recommendation` requires it, checks signature, date and age (30 minutes), then recomputes eligibility at write time and refuses the whole call (`blocked_items`) if any option contains a blocked item. `boundary` and `config_flag` items are written but returned in `warnings`. The token is stored on the row as a receipt (`migrations/004_eligibility_run_id.sql`).

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

**`wd_log_recommendation` returns `error: eligibility_run_invalid` / `eligibility_run_date_mismatch` / `eligibility_run_stale`**
- Call `wd_eligibility` for the same `recommended_for` and pass its `run_id`. Runs expire after 30 minutes; a run for a different date is refused. If the error mentions `WD_ELIGIBILITY_SECRET`, the secret was never set — see step 2.

**`wd_log_recommendation` returns `error: blocked_items`**
- By design: a governed item in one of the options was worn inside the 7-day window for that date. Nothing was written. Swap the named item and retry with the same run (or a fresh one).

**"Ambiguous name match" on an update or lookup**
- Two or more items share that substring. Pass `item_id` (from the returned candidates) instead of `name_match`.

**Dormant report lists a seasonal item**
- Expected. The report surfaces; you interpret. A linen shirt dormant in February is not a problem — the seasonality judgment is deliberately left to conversation, not SQL.

**Wear stats look empty for a new item**
- `v_item_wear_stats` left-joins wear events, so a never-worn item shows `total_wears: 0` and `last_worn: null`. That's correct, and it's exactly what makes it show up as dormant.

## Contributing It Back

This extension follows the OB1 contribution layout (schema, edge-function server, `metadata.json`, README) so it can be proposed upstream. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for the metadata format and review process. Note that the `extensions/` path is a curated learning path — open a proposal issue before submitting.
