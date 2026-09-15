-- Migration 002: per-item recommendation stats, and a combined stats view.
--
-- Why: `wd_get_inventory` is the call an advisor composes recommendations
-- from, and it returned no wear data. Wear counts got sourced instead from
-- fields that only look like wear data (`condition`, `acquired_on`,
-- `fit_notes`, prose in `notes`), producing false "never worn" / "first wear"
-- claims. The fix is to put the real numbers on every inventory row.
--
-- The second half of the same gap: the standing 7-day rule for shirts, tees
-- and socks counts recommended-but-unworn against recency, so an item that was
-- proposed and declined still needs to be visible as recently used.
--
-- `v_item_wear_stats` is deliberately left untouched — `wd_rotation_report`,
-- `v_dormant_items` and `v_overworn_items` all read it, and it stays the one
-- place wear counts are computed. `v_item_stats` composes it rather than
-- restating it, so the two tools cannot drift apart.
--
-- Apply:
--   supabase db query --linked -f extensions/wardrobe/migrations/002_item_stats_view.sql

-- ---------------------------------------------------------------------------
-- Per-item recommendation stats.
--
-- `total_recommendations` counts distinct recommendation *events*, not options:
-- an item appearing in two of three options offered on the same turn was
-- recommended once, not twice.
--
-- `last_recommended_for` is the date the outfit was FOR (`recommended_for`),
-- not the date it was proposed, and it does not care about `outcome` — a
-- declined recommendation still counts against the 7-day recency rule.
-- ---------------------------------------------------------------------------
create or replace view v_item_reco_stats as
select
  i.id,
  count(distinct r.id)   as total_recommendations,
  max(r.recommended_for) as last_recommended_for
from items i
  left join recommendation_option_items roi on roi.item_id = i.id
  left join recommendation_options ro       on ro.id = roi.recommendation_option_id
  left join recommendations r               on r.id = ro.recommendation_id
group by i.id;

-- ---------------------------------------------------------------------------
-- The combined per-item stats row: wear + recommendation, one row per item.
-- Both `wd_get_inventory` and `wd_get_item` read this, so their numbers agree
-- by construction.
--
-- Counts are coalesced to 0 here, never left null. A null reads as "unknown"
-- and invites inference from surrounding fields, which is the exact failure
-- this migration exists to close. An explicit 0 is a claim the database is
-- making. Dates and their derived day-counts stay nullable — "never worn" has
-- no last-worn date, and 0 would be a lie there.
-- ---------------------------------------------------------------------------
create or replace view v_item_stats as
select
  w.id,
  w.name,
  w.category,
  w.register,
  w.status,
  coalesce(w.total_wears, 0)             as total_wears,
  w.last_worn,
  w.days_since_worn,
  coalesce(w.wears_30d, 0)               as wears_30d,
  coalesce(w.wears_90d, 0)               as wears_90d,
  coalesce(rs.total_recommendations, 0)  as total_recommendations,
  rs.last_recommended_for,
  current_date - rs.last_recommended_for as days_since_recommended
from v_item_wear_stats w
  left join v_item_reco_stats rs on rs.id = w.id;

-- Supabase no longer auto-grants on new objects (see CONTRIBUTING.md).
-- Service role only: the edge function is the sole client. Do NOT grant to
-- `authenticated` or `anon` — see the security posture note in schema.sql.
grant select on table public.v_item_reco_stats to service_role;
grant select on table public.v_item_stats      to service_role;
