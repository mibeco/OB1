-- Migration 004: a logged recommendation carries proof of its eligibility run.
--
-- Why: the 7-day rotation rule for shirts, tees and socks used to be applied
-- by the assistant reading the inventory and holding the exclusion set in
-- working memory. On 2026-09-05 that produced a false claim about the
-- database ("all three Pendletons are inside the window" — there were four,
-- one never worn, one recommended-but-unworn, one on the boundary). The rule
-- now lives in code (`computeEligibility` in the edge function), exposed as
-- `wd_eligibility`, and `wd_log_recommendation` refuses to write without a
-- fresh, signed run for the same date whose items are not blocked.
--
-- This column is the receipt: the `run_id` token the write was authorised
-- with. It is informational — enforcement is in the function, which
-- recomputes eligibility at write time regardless — so it is nullable and
-- history stays valid. The token is stateless (HMAC over
-- {for_date, computed_at, v}); nothing here references another table.
--
-- Apply:
--   supabase db query --linked -f extensions/wardrobe/migrations/004_eligibility_run_id.sql
-- Also set the signing secret (dedicated — not the service role key) and
-- redeploy the function:
--   supabase secrets set WD_ELIGIBILITY_SECRET=<random 32+ bytes>
--   supabase functions deploy wardrobe-mcp --no-verify-jwt

alter table recommendations
  add column if not exists eligibility_run_id text;

comment on column recommendations.eligibility_run_id is
  'The signed wd_eligibility run_id this recommendation was written under (receipt; enforcement is in the edge function)';
