-- Migration 003: register + paradigm notes on every formulated outfit.
--
-- Standing practice from 2026-09-15: each time an outfit is formulated it is
-- tagged on two axes —
--   register  : the owner's personal composite (heritage/elevated workwear,
--               smart casual / elevated normcore, ...) which bundles lineage
--               with a formality band;
--   paradigm  : Simon Crompton's lineage-only taxonomy (British country,
--               American prep, Italian smooth, Workwear, Sportswear), per
--               "Five paradigms of casual clothing", Permanent Style, 2018.
--
-- Both are deliberately FREE TEXT, not enums. The interesting cases are the
-- mixed ones — a workwear-paradigm outfit with a formality-crossing shoe, an
-- Italian-smooth knit under a heritage jacket — and a category would force
-- those into a single bucket. A note can say "mostly Workwear; Italian
-- smooth at the knit; deliberate collision at the footwear".
--
-- The fields live wherever an outfit is formulated:
--   recommendation_options : each option proposed is its own formulation
--   outfits                : saved, reusable combinations
--   wear_events            : what was actually worn (may differ from the
--                            proposal, so tagged on its own)
--
-- Nullable so history stays valid; the tool descriptions make them required
-- in practice for new writes.

alter table recommendation_options
  add column if not exists register_note text,
  add column if not exists paradigm_note text;

alter table outfits
  add column if not exists register_note text,
  add column if not exists paradigm_note text;

alter table wear_events
  add column if not exists register_note text,
  add column if not exists paradigm_note text;

comment on column recommendation_options.register_note is
  'Free text: which register(s) this option sits in, incl. mixing/collision notes';
comment on column recommendation_options.paradigm_note is
  'Free text: which Crompton paradigm(s) this option draws on, incl. overlap/ambiguity notes';
comment on column outfits.register_note is
  'Free text: which register(s) this outfit sits in, incl. mixing/collision notes';
comment on column outfits.paradigm_note is
  'Free text: which Crompton paradigm(s) this outfit draws on, incl. overlap/ambiguity notes';
comment on column wear_events.register_note is
  'Free text: which register(s) the outfit as worn sits in, incl. mixing/collision notes';
comment on column wear_events.paradigm_note is
  'Free text: which Crompton paradigm(s) the outfit as worn draws on, incl. overlap/ambiguity notes';
