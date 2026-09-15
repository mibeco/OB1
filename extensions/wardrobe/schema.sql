-- Wardrobe System schema (Supabase Postgres)
-- Apply after base project creation. Single-owner; no RLS required initially.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- ITEMS: the inventory. One row per garment/accessory.
-- ---------------------------------------------------------------------------
create table items (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,                 -- "LMSM bleu de travail chore coat"
  category        text not null,                 -- outerwear | shirt | knitwear | trousers | footwear | accessory | socks | other
  subcategory     text,                          -- chore coat, penny loafer, OCBD, ...
  brand           text,
  color           text,                          -- "snuff", "faded blue-grey"
  color_family    text,                          -- warm_earth | cool | neutral | statement
  fabric          text,                          -- moleskin, linen, 11-wale corduroy...
  weight          text,                          -- light | mid | heavy
  seasons         text[] default '{}',           -- {spring,summer,fall,winter}
  register        text,                          -- heritage_workwear | smart_casual | tailored | crossover | athletic
  formality       int,                           -- 1 (gym) .. 10 (black tie), optional
  size            text,
  fit_notes       text,                          -- shoulder seam behavior, ease, weight-loss caveats
  condition       text default 'good',           -- new | good | worn | needs_repair
  status          text not null default 'active',-- incoming | active | under_review | retired
  acquired_on     date,
  acquired_from   text,
  price_paid      numeric,
  retired_on      date,
  pairing_notes   text,                          -- known-good pairings, register cautions
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index items_status_idx   on items (status);
create index items_category_idx on items (category);
create index items_register_idx on items (register);

-- ---------------------------------------------------------------------------
-- WEAR EVENTS: one row per wearing occasion (usually per day).
-- ---------------------------------------------------------------------------
create table wear_events (
  id          uuid primary key default gen_random_uuid(),
  worn_on     date not null default current_date,
  context     text,                              -- office, errands, dinner out, offsite...
  audience    text[] default '{}',               -- {"team","Webb","in-laws"} — people/groups who'd notice repeats
  weather     text,
  outfit_id   uuid,                              -- optional link to a saved outfit
  rating      int check (rating between 1 and 5),-- how the outfit felt
  notes       text,
  register_note text,                           -- free text: register(s) as worn, incl. mixing/collision
  paradigm_note text,                           -- free text: Crompton paradigm(s) as worn, incl. overlap/ambiguity
  created_at  timestamptz default now()
);

create index wear_events_worn_on_idx on wear_events (worn_on desc);
create index wear_events_audience_idx on wear_events using gin (audience);

create table wear_event_items (
  wear_event_id uuid not null references wear_events(id) on delete cascade,
  item_id       uuid not null references items(id),
  primary key (wear_event_id, item_id)
);

create index wei_item_idx on wear_event_items (item_id);

-- ---------------------------------------------------------------------------
-- OUTFITS: named, reusable combinations that are known to work.
-- ---------------------------------------------------------------------------
create table outfits (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                     -- "bleu de travail + ecru workshirt + tan chinos + Aldens"
  register    text,
  occasion    text,                              -- what it's for
  notes       text,                              -- why it works, caveats
  register_note text,                            -- free text: register(s), incl. mixing/collision
  paradigm_note text,                            -- free text: Crompton paradigm(s), incl. overlap/ambiguity
  created_at  timestamptz default now()
);

create table outfit_items (
  outfit_id uuid not null references outfits(id) on delete cascade,
  item_id   uuid not null references items(id),
  primary key (outfit_id, item_id)
);

alter table wear_events
  add constraint wear_events_outfit_fk
  foreign key (outfit_id) references outfits(id);

-- ---------------------------------------------------------------------------
-- RECOMMENDATIONS: one row per proposal event (per turn an outfit was
-- proposed), not per option. `recommended_for` is the date the outfit was FOR;
-- `proposed_on` is the date it was proposed. Both are literal dates — the
-- server supplies America/Los_Angeles "today" for proposed_on; current_date
-- here is only a fallback.
-- ---------------------------------------------------------------------------
create table recommendations (
  id               uuid primary key default gen_random_uuid(),
  recommended_for  date not null,
  proposed_on      date not null default current_date,
  context          text,                              -- office, errands, brother's place...
  weather          text,
  audience         text[] default '{}',
  outcome          text not null default 'pending',   -- pending | worn_as_proposed | worn_with_deviation | declined | superseded | unknown
  chosen_option_id uuid,                              -- fk added below (table order)
  wear_event_id    uuid references wear_events(id),   -- set when the resulting outfit was logged
  deviation_notes  text,                              -- what he swapped and why
  notes            text,
  eligibility_run_id text,                            -- signed wd_eligibility run_id the write was authorised under (receipt; see migration 004)
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create table recommendation_options (
  id                uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references recommendations(id) on delete cascade,
  option_index      int not null,                     -- 1, 2, 3 — order as presented
  label             text,                             -- short handle, e.g. "warm-earth heritage-lean"
  rationale         text,                             -- the one-line reasoning given
  register_note     text,                             -- free text: register(s), incl. mixing/collision
  paradigm_note     text                              -- free text: Crompton paradigm(s), incl. overlap/ambiguity
);

create table recommendation_option_items (
  recommendation_option_id uuid not null references recommendation_options(id) on delete cascade,
  item_id                  uuid not null references items(id),
  primary key (recommendation_option_id, item_id)
);

alter table recommendations
  add constraint recommendations_chosen_option_fk
  foreign key (chosen_option_id) references recommendation_options(id);

create index recommendations_recommended_for_idx on recommendations (recommended_for desc);
create index recommendations_outcome_idx on recommendations (outcome);
create index reco_options_recommendation_idx on recommendation_options (recommendation_id);
create index roi_item_idx on recommendation_option_items (item_id);

-- Supabase no longer auto-grants CRUD on new tables (see CONTRIBUTING.md).
grant select, insert, update, delete on table public.recommendations to service_role;
grant select, insert, update, delete on table public.recommendation_options to service_role;
grant select, insert, update, delete on table public.recommendation_option_items to service_role;

-- ---------------------------------------------------------------------------
-- QUALITATIVE / WIKI LAYER: not a table here.
-- Style identity, registers, principles, person notes, and dialogue outcomes
-- live in the base OB1 `thoughts` store via capture_thought / search_thoughts.
-- Do not duplicate that here; this schema is the structured/quantitative layer only.
--
-- The one deliberate exception is the pair of free-text tags on every
-- formulated outfit (recommendation_options, outfits, wear_events):
-- `register_note` (the owner's personal composite, lineage + formality band)
-- and `paradigm_note` (Crompton's lineage-only taxonomy). They are prose, not
-- enums, so mixing and collisions can be described. See migrations/003.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- SYSTEM STATE: small key-value store for rhythms (e.g., review cadence).
-- ---------------------------------------------------------------------------
create table system_state (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz default now()
);

insert into system_state (key, value)
values ('last_rotation_review', '{"date": null}');

-- ---------------------------------------------------------------------------
-- VIEWS: the analytics layer.
-- ---------------------------------------------------------------------------

-- Per-item wear statistics.
create view v_item_wear_stats as
select
  i.id,
  i.name,
  i.category,
  i.register,
  i.status,
  count(we.id)                                   as total_wears,
  max(we.worn_on)                                as last_worn,
  current_date - max(we.worn_on)                 as days_since_worn,
  count(we.id) filter (where we.worn_on >= current_date - 30) as wears_30d,
  count(we.id) filter (where we.worn_on >= current_date - 90) as wears_90d
from items i
left join wear_event_items wei on wei.item_id = i.id
left join wear_events we       on we.id = wei.wear_event_id
group by i.id;

-- Per-item recommendation stats. `total_recommendations` counts distinct
-- recommendation *events*, not options: an item appearing in two of three
-- options offered on the same turn was recommended once, not twice.
-- `last_recommended_for` ignores `outcome` on purpose — a declined
-- recommendation still counts against the 7-day recency rule.
create view v_item_reco_stats as
select
  i.id,
  count(distinct r.id)   as total_recommendations,
  max(r.recommended_for) as last_recommended_for
from items i
  left join recommendation_option_items roi on roi.item_id = i.id
  left join recommendation_options ro       on ro.id = roi.recommendation_option_id
  left join recommendations r               on r.id = ro.recommendation_id
group by i.id;

-- The combined per-item stats row: wear + recommendation, one row per item.
-- Both wd_get_inventory and wd_get_item read this, so their numbers agree by
-- construction. Counts are coalesced to 0, never left null: a null reads as
-- "unknown" and invites inference from `condition` / `acquired_on` / prose in
-- `notes`, which is how false "never worn" claims get made. Dates and their
-- derived day-counts stay nullable — "never worn" has no date, and 0 would
-- be a lie there.
create view v_item_stats as
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

grant select on table public.v_item_reco_stats to service_role;
grant select on table public.v_item_stats      to service_role;

-- Dormant: active items never worn, or unworn for 60+ days.
-- (Seasonality caveat belongs in conversation, not SQL: a dormant linen shirt
--  in February is not a problem. The report surfaces; Claude interprets.)
create view v_dormant_items as
select * from v_item_wear_stats
where status = 'active'
  and (last_worn is null or last_worn < current_date - 60);

-- Over-worn: 6+ wears in the last 30 days.
create view v_overworn_items as
select * from v_item_wear_stats
where status = 'active'
  and wears_30d >= 6;

-- Audience recency: last wear of each item per audience tag.
-- Answers "when did <item> last appear in front of <audience>".
create view v_item_audience_recency as
select
  i.id          as item_id,
  i.name,
  aud           as audience,
  max(we.worn_on) as last_worn_for_audience,
  count(*)        as wears_for_audience
from items i
join wear_event_items wei on wei.item_id = i.id
join wear_events we       on we.id = wei.wear_event_id
cross join lateral unnest(we.audience) as aud
group by i.id, i.name, aud;

-- updated_at maintenance
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger items_touch before update on items
  for each row execute function touch_updated_at();
create trigger recommendations_touch before update on recommendations
  for each row execute function touch_updated_at();
create trigger system_state_touch before update on system_state
  for each row execute function touch_updated_at();
