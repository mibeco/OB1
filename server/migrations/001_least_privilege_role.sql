-- Migration 001 (base server): give open-brain-mcp its own least-privilege
-- database role instead of connecting as `service_role`.
--
-- WHY. This is the same change already made for the wardrobe extension
-- (extensions/wardrobe/migrations/006), applied to the server that guards the
-- more sensitive store. Audited 2026-09-20: the `service_role` credential this
-- function holds can read 30 tables across 5 schemas with full CRUD, and
-- carries BYPASSRLS, so row-level security does not apply to it anywhere. It
-- reaches `vault.secrets`, `vault.decrypted_secrets`, every storage bucket in
-- the project, and every wardrobe table — none of which this server has any
-- business touching. It reads exactly one table.
--
-- The exposure is asymmetric in the usual way: the thing being protected is
-- 155 rows of personal memory — style identity, principles, notes about
-- people — and the credential protecting it also unlocks everything else in
-- the project. The application code has always been well-behaved; the
-- credential simply could reach further than the code ever did.
--
-- WHAT THIS SERVER ACTUALLY NEEDS, from reading index.ts:
--   * public.thoughts                     — the only table, 5 references
--   * public.match_thoughts(...)          — vector similarity search
--   * public.upsert_thought(...)          — fingerprinted insert/update
--   * the `vector` type, which lives in the `extensions` schema
-- No storage. No other schema. Both functions are SECURITY INVOKER, so they
-- run as the caller and the caller needs the table privileges directly.
--
-- SAFE TO APPLY ON ITS OWN. Creating a role nothing authenticates as changes
-- no behaviour. The function keeps using `service_role` until it is separately
-- pointed at a token carrying `role: open_brain_mcp`.
--
-- Apply:
--   supabase db query --linked -f server/migrations/001_least_privilege_role.sql

-- ---------------------------------------------------------------------------
-- The role
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'open_brain_mcp') then
    -- NOLOGIN: reached only by PostgREST switching into it from
    -- `authenticator`. NOBYPASSRLS is the point - do not add it later.
    create role open_brain_mcp nologin nobypassrls noinherit;
  end if;
end $$;

grant open_brain_mcp to authenticator;

grant usage on schema public to open_brain_mcp;
-- pgvector lives here; `match_thoughts` takes a `vector` argument and the
-- calling role cannot name the type without usage on its schema.
grant usage on schema extensions to open_brain_mcp;

-- ---------------------------------------------------------------------------
-- Privileges: one table, two functions. Nothing else is granted, and nothing
-- else needs revoking - a new role starts with no access to anything.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on table public.thoughts to open_brain_mcp;

grant execute on function public.match_thoughts(vector, double precision, integer, jsonb)
  to open_brain_mcp;
grant execute on function public.upsert_thought(text, jsonb)
  to open_brain_mcp;

-- ---------------------------------------------------------------------------
-- RLS.
--
-- `thoughts` has RLS enabled with a single policy, "Service role full access",
-- written `to public` with `using (auth.role() = 'service_role')`. A token
-- whose role claim is `open_brain_mcp` does not satisfy that predicate, and
-- unlike service_role this role has no BYPASSRLS to fall back on - so without
-- a policy of its own every query it makes would return nothing. The existing
-- policy is left untouched so the service-role fallback keeps working.
-- ---------------------------------------------------------------------------
drop policy if exists open_brain_mcp_all on public.thoughts;
create policy open_brain_mcp_all on public.thoughts
  for all to open_brain_mcp
  using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Defence in depth, matching what was done to the wardrobe tables.
--
-- `authenticated` currently holds full CRUD on `thoughts` - Supabase's default
-- privileges hand it out on every new table. Only RLS stops it being used, and
-- public signups were disabled on 2026-09-20 so no authenticated user can
-- currently exist (auth.users is empty). Revoking means that if RLS is ever
-- switched off on this table, access does not fall through to a grant nobody
-- remembered was there.
-- ---------------------------------------------------------------------------
revoke all on table public.thoughts from anon, authenticated;

comment on role open_brain_mcp is
  'Least-privilege role for the open-brain-mcp edge function. public.thoughts plus match_thoughts/upsert_thought only. No BYPASSRLS - do not add it. No access to vault, storage, wardrobe tables or any other schema, by design.';
