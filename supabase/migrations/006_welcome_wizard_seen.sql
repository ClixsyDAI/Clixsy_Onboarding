-- Stage 7 / P3+P4: persistent flag for the first-login Welcome Wizard.
-- Flips to true server-side when the user clicks "Start onboarding" on
-- the second-step wizard so the wizard only ever fires once per session,
-- even across browsers / cleared cookies. P4's returning-user greeting
-- gates on this flag (true → "Welcome back, <company>!", false → wizard
-- replaces the greeting entirely).
--
-- Default false. Existing 14 rows get the default by virtue of the
-- NOT NULL + DEFAULT — no separate backfill needed.

begin;

alter table public.onboarding_sessions
  add column if not exists welcome_wizard_seen boolean not null default false;

comment on column public.onboarding_sessions.welcome_wizard_seen is
  'P3 (Stage 7): true once the first-login welcome modal has been dismissed.
   Used to gate both the modal itself and the P4 returning-user greeting.';

commit;
