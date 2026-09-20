-- Migration 006: give the wardrobe MCP server its own least-privilege database
-- role, instead of connecting as `service_role`.
--
-- WHY. Audited 2026-09-20: the `service_role` credential the edge function
-- holds can read 30 tables across 5 schemas — including `public.thoughts`
-- (155 rows: the Open Brain memory store this extension's own header says it
-- "never touches"), `vault.secrets`, `vault.decrypted_secrets`, and every
-- storage bucket, not just this one. It holds full CRUD, not just select, and
-- it carries the BYPASSRLS attribute, so row-level security does not apply to
-- it anywhere.
--
-- A leak of the wardrobe connector credential is therefore not "the wardrobe is
-- exposed". It is the wardrobe, the entire thoughts store, every bucket, and
-- the vault. That is a far larger blast radius than the thing being protected,
-- and it is invisible from the application code, which reads only wardrobe
-- tables and looks perfectly well-behaved.
--
-- WHAT THIS DOES. Creates `wardrobe_mcp`: no login, NO BYPASSRLS, granted only
-- the wardrobe tables, the wardrobe views, and the `wardrobe-photos` bucket.
-- Because it does not bypass RLS, it is governed by the policies below rather
-- than exempt from them — so a future mistake in a policy constrains this role
-- too, instead of silently not applying.
--
-- SAFE TO APPLY ON ITS OWN. Creating a role nothing authenticates as changes
-- no behaviour. The edge function keeps using `service_role` until it is
-- separately pointed at a token carrying `role: wardrobe_mcp`. Applying this
-- and stopping is a valid state.
--
-- Apply:
--   supabase db query --linked -f extensions/wardrobe/migrations/006_least_privilege_role.sql

-- ---------------------------------------------------------------------------
-- The role
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'wardrobe_mcp') then
    -- NOLOGIN: reached only by PostgREST switching into it from
    -- `authenticator`, never by a direct connection.
    -- NOBYPASSRLS is the point of the exercise and must not be added later.
    create role wardrobe_mcp nologin nobypassrls noinherit;
  end if;
end $$;

-- PostgREST authenticates as `authenticator` and switches into the role named
-- in the JWT's `role` claim. Without this grant that switch is refused.
grant wardrobe_mcp to authenticator;

grant usage on schema public  to wardrobe_mcp;
grant usage on schema storage to wardrobe_mcp;

-- ---------------------------------------------------------------------------
-- Table privileges: the ten wardrobe tables and nothing else.
-- `thoughts` is deliberately absent. So is everything in vault, realtime and
-- extensions. Absence is the mechanism — there is no revoke needed for objects
-- a new role was never granted.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on table
  public.items,
  public.wear_events,
  public.wear_event_items,
  public.outfits,
  public.outfit_items,
  public.photos,
  public.recommendations,
  public.recommendation_options,
  public.recommendation_option_items,
  public.system_state
to wardrobe_mcp;

-- Read-only on the analytics views.
grant select on table
  public.v_item_wear_stats,
  public.v_item_reco_stats,
  public.v_item_stats,
  public.v_dormant_items,
  public.v_overworn_items,
  public.v_item_audience_recency
to wardrobe_mcp;

-- ---------------------------------------------------------------------------
-- RLS policies.
--
-- These tables have RLS enabled with zero policies. `service_role` never
-- noticed, because BYPASSRLS exempted it. `wardrobe_mcp` is not exempt, so
-- without policies every query it makes would return nothing. Each policy is
-- scoped `to wardrobe_mcp` — it grants this role, and only this role, full
-- visibility of the wardrobe. anon and authenticated remain policy-less and
-- grant-less, which is the posture set on 2026-08-04 and kept.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'items','wear_events','wear_event_items','outfits','outfit_items','photos',
    'recommendations','recommendation_options','recommendation_option_items',
    'system_state'
  ] loop
    execute format('drop policy if exists wardrobe_mcp_all on public.%I', t);
    execute format(
      'create policy wardrobe_mcp_all on public.%I for all to wardrobe_mcp using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Storage: the `wardrobe-photos` bucket only.
--
-- The predicate is the whole point. `service_role` could read and delete
-- objects in any bucket in the project; this role is confined by a policy the
-- database enforces, not by the edge function remembering which bucket to name.
-- ---------------------------------------------------------------------------
grant select on table storage.buckets to wardrobe_mcp;
grant select, insert, update, delete on table storage.objects to wardrobe_mcp;

drop policy if exists wardrobe_mcp_photos_bucket on storage.objects;
create policy wardrobe_mcp_photos_bucket on storage.objects
  for all to wardrobe_mcp
  using      (bucket_id = 'wardrobe-photos')
  with check (bucket_id = 'wardrobe-photos');

drop policy if exists wardrobe_mcp_bucket_read on storage.buckets;
create policy wardrobe_mcp_bucket_read on storage.buckets
  for select to wardrobe_mcp
  using (id = 'wardrobe-photos');

comment on role wardrobe_mcp is
  'Least-privilege role for the wardrobe-mcp edge function. Wardrobe tables, wardrobe views and the wardrobe-photos bucket only. No BYPASSRLS - do not add it. No access to public.thoughts, vault, realtime or other buckets, by design.';
