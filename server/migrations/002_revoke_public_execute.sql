-- 002_revoke_public_execute.sql
--
-- WHY. Audited 2026-09-20: `anon`, `authenticated` and PUBLIC all held EXECUTE
-- on `match_thoughts` and `upsert_thought`, so both were callable through
-- /rest/v1/rpc with the project's public anon key. Neither is SECURITY DEFINER,
-- so the call died on the `thoughts` table grant — but that is one accident
-- (a definer rewrite, a stray grant) away from handing the memory store to the
-- internet. The roles that need these functions hold explicit grants already.
--
-- The two trigger functions are included for tidiness; triggers fire without
-- an EXECUTE check on the calling role, so nothing depends on these grants.
--
-- Safe to re-run.

revoke execute on function public.match_thoughts(vector, double precision, integer, jsonb)
  from public, anon, authenticated;
revoke execute on function public.upsert_thought(text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.touch_updated_at()  from public, anon, authenticated;
revoke execute on function public.update_updated_at() from public, anon, authenticated;

grant execute on function public.match_thoughts(vector, double precision, integer, jsonb)
  to service_role, open_brain_mcp;
grant execute on function public.upsert_thought(text, jsonb)
  to service_role, open_brain_mcp;

-- Functions created later by `postgres` in `public` start closed.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
