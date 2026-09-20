-- Migration 005: photographs of garments, and the captured product-page text
-- they came with.
--
-- Three uses, in priority order:
--   1. As-new baseline. A stock product image is t=0 for a garment — the only
--      record of original indigo depth, suede nap, or knit surface before
--      wear. Available only at acquisition; unrecoverable afterwards.
--   2. Identification. Item-ref name matching is the most common friction in
--      this system; a canonical image disambiguates three similar
--      stone-coloured bottoms faster than prose ever will.
--   3. Provenance and fit over time. A photo attached to a wear event settles
--      what was actually worn, and a run of full-length shots on the same
--      mirror records how garments sat as the owner's frame changed.
--
-- The governing hazard: a stock photo looks more authoritative than anything
-- else in the archive — studio light, clean background — and is simultaneously
-- the least reliable image in it for COLOUR, because retailers grade for
-- appeal. Highest apparent quality, lowest actual fidelity. `kind` and the
-- generated `color_authoritative` column make that non-bypassable rather than
-- leaving it to whoever remembers.
--
--   kind        subject                                valid for                              never
--   reference   owner's garment, colour chart in       colour measurement                     —
--               frame, controlled light
--   outfit      owner's garment as worn (mirror snap)  fit over time, provenance              colour values
--   stock       maker's garment, retailer photography  identification, as-new baseline,       colour values, fit,
--                                                      construction detail                    proportion
--
-- Naming: the brief for this migration wrote the primary key as `photo_id` and
-- the foreign keys as `items(item_id)` / `wear_events(event_id)`. Those columns
-- do not exist — every table in this schema names its own primary key `id` and
-- its foreign keys `<entity>_id`. The table below follows the house convention
-- (`photos.id`, `photos.item_id -> items(id)`, `photos.event_id ->
-- wear_events(id)`); the TOOL interface still says `photo_id`, exactly as
-- `wd_update_item` says `item_id` and `wd_update_wear` says `event_id` for
-- columns that are called `id`.
--
-- Apply:
--   supabase db query --linked -f extensions/wardrobe/migrations/005_photos.sql
-- Then redeploy the function:
--   supabase functions deploy wardrobe-mcp --no-verify-jwt

-- ---------------------------------------------------------------------------
-- PHOTOS
-- ---------------------------------------------------------------------------
create table if not exists photos (
  id                  uuid primary key default gen_random_uuid(),
  item_id             uuid references items(id) on delete cascade,
  event_id            uuid references wear_events(id) on delete cascade,

  kind                text not null
                        check (kind in ('stock','reference','outfit')),
  shot_type           text
                        check (shot_type in ('flatlay','on_model','detail','swatch','full_length','other')),

  storage_path        text not null,
  source_url          text,
  source_domain       text,
  caption             text,
  captured_on         date,

  content_hash        text,
  width_px            integer,
  height_px           integer,
  bytes               integer,
  mime_type           text,

  -- The colour-authority rule, enforced by the database rather than by
  -- convention. Generated precisely so no handler can set it directly; any
  -- future colour-measurement pipeline must filter on it.
  color_authoritative boolean generated always as (kind = 'reference') stored,

  created_at          timestamptz not null default now(),

  constraint photos_subject_present
    check (item_id is not null or event_id is not null)
);

create index if not exists photos_item_idx  on photos(item_id);
create index if not exists photos_event_idx on photos(event_id);

-- Same bytes, same garment, one row. The partial predicate is required because
-- `item_id` is nullable (event-subject photos) and NULLs do not collide.
create unique index if not exists photos_hash_item_uniq
  on photos(item_id, content_hash) where item_id is not null;

alter table photos enable row level security;  -- no policies; service role only

-- Supabase no longer auto-grants CRUD on new tables (see CONTRIBUTING.md).
grant select, insert, update, delete on table public.photos to service_role;

comment on table photos is
  'Photographs of garments. `kind` governs what each frame may be read for; `color_authoritative` is generated from it and is the only gate a colour pipeline may trust.';
comment on column photos.kind is
  'reference = owner''s garment under controlled light (colour-authoritative) | outfit = owner''s garment as worn, mirror snap (fit/provenance; never colour) | stock = retailer photography (identification and as-new baseline; never colour, fit or proportion)';
comment on column photos.color_authoritative is
  'Generated from kind. Never settable by a handler. Filter on this before reading any colour value off a frame.';
comment on column photos.storage_path is
  'Object key in the private `wardrobe-photos` bucket: {kind}/{item_id or event_id}/{photo id}.{ext}';

-- ---------------------------------------------------------------------------
-- STORAGE: private bucket. No public read; the edge function mints signed URLs
-- with the service role on request (default TTL 1 hour). No storage policies —
-- the service role bypasses RLS, and nothing else is meant to reach these
-- objects.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('wardrobe-photos', 'wardrobe-photos', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- ITEMS: captured product-page spec text.
--
-- `source_spec` is the product page as markdown — fabric composition, weight,
-- construction bullets, care, and the garment size chart. Free text, not
-- parsed: it is read by humans and by the advisor, never queried. It is
-- deliberately kept out of the shared ITEM_COLUMNS list in the edge function
-- so a full inventory read doesn't carry a few hundred KB of prose; only
-- wd_get_item returns it.
-- ---------------------------------------------------------------------------
alter table items
  add column if not exists source_url          text,
  add column if not exists source_spec         text,
  add column if not exists source_captured_on  date;

comment on column items.source_spec is
  'Captured product-page text as markdown (composition, weight, construction, care, size chart). Free text, not parsed, not queried.';
