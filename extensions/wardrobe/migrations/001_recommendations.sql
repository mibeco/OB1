-- Migration 001: recommendation tracking.
-- One row per proposal event (recommendations), one row per option offered
-- (recommendation_options), and a join table linking options to items
-- (recommendation_option_items). Mirrors the wear_events / wear_event_items
-- structure: uuid ids, no RLS (single-owner), cascade deletes on link tables.
-- Apply against an existing wardrobe schema:
--   supabase db query --linked -f extensions/wardrobe/migrations/001_recommendations.sql
-- (Fresh installs get these tables from schema.sql; do not apply both.)

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
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create table recommendation_options (
  id                uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references recommendations(id) on delete cascade,
  option_index      int not null,                     -- 1, 2, 3 — order as presented
  label             text,                             -- short handle, e.g. "warm-earth heritage-lean"
  rationale         text                              -- the one-line reasoning given
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

create trigger recommendations_touch before update on recommendations
  for each row execute function touch_updated_at();

-- Supabase no longer auto-grants CRUD on new tables (see CONTRIBUTING.md).
grant select, insert, update, delete on table public.recommendations to service_role;
grant select, insert, update, delete on table public.recommendation_options to service_role;
grant select, insert, update, delete on table public.recommendation_option_items to service_role;
