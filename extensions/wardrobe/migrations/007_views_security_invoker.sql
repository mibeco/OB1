-- 007_views_security_invoker.sql
--
-- WHY. Found 2026-09-20 while verifying the OAuth migration plan: the six
-- wardrobe views were readable with the project's PUBLIC anon key.
--
--   GET /rest/v1/v_item_stats?limit=1   (apikey: anon)  ->  200, real rows
--   GET /rest/v1/items?limit=1          (apikey: anon)  ->  42501, refused
--
-- The tables were locked down on 2026-08-04 (RLS, no policies) and again on
-- 2026-09-20 (anon/authenticated grants revoked). The views were not. A view
-- without `security_invoker` runs with its OWNER's privileges — here
-- `postgres` — so it reads the underlying tables regardless of the caller's
-- grants or RLS, and `anon` / `authenticated` still held SELECT on the views
-- themselves. Table lockdown does not reach through a view; this does.
--
-- WHAT THIS DOES.
--   1. Revokes every privilege on the views from anon and authenticated.
--   2. Sets security_invoker on each view, so a caller's own table grants and
--      RLS policies apply. wardrobe_mcp (006) has both; service_role bypasses
--      RLS; anyone else gets nothing even if a grant reappears by mistake.
--
-- Safe to re-run.

do $$
declare
  v text;
begin
  foreach v in array array[
    'v_dormant_items',
    'v_item_audience_recency',
    'v_item_reco_stats',
    'v_item_stats',
    'v_item_wear_stats',
    'v_overworn_items'
  ] loop
    execute format('revoke all on public.%I from anon, authenticated', v);
    execute format('alter view public.%I set (security_invoker = true)', v);
  end loop;
end $$;

-- Views created later by `postgres` in `public` must not hand themselves to
-- the public roles either. (Default privileges cover views under "tables".)
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
