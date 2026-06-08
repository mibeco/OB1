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
-- QUALITATIVE / WIKI LAYER: not a table here.
-- Style identity, registers, principles, person notes, and dialogue outcomes
-- live in the base OB1 `thoughts` store via capture_thought / search_thoughts.
-- Do not duplicate that here; this schema is the structured/quantitative layer only.
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
create trigger system_state_touch before update on system_state
  for each row execute function touch_updated_at();
