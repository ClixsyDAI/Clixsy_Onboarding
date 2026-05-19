-- Stage 8 / S12.4: rebuilt thank-you screen adds an optional 1-5 star
-- rating after submit. Persisted directly on the session row (no
-- separate feedback table — the relationship is 1:1 with onboarding,
-- and the volume is bounded by total session count).
--
-- feedback_rating         : nullable. If client clicks Finish without
--                           rating, stays NULL. Otherwise 1-5.
-- feedback_submitted_at   : nullable. Set server-side when the
--                           submit-feedback endpoint persists.
--
-- Both columns nullable, no backfill needed; existing 14 rows stay
-- NULL.

begin;

alter table public.onboarding_sessions
  add column feedback_rating int check (feedback_rating between 1 and 5),
  add column feedback_submitted_at timestamptz;

comment on column public.onboarding_sessions.feedback_rating is
  'S12.4 (Stage 8): optional 1-5 star rating collected on the rebuilt
   thank-you screen. NULL means the client clicked Finish onboarding
   without rating.';
comment on column public.onboarding_sessions.feedback_submitted_at is
  'Timestamp the feedback_rating was POSTed to /api/public/onboarding/
   submit-feedback. NULL when rating is NULL.';

commit;
