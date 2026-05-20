-- =============================================================
-- Migration: 008_workbook_tab_tables.sql
-- Target:    Supabase project lawwsutjxopiekjzupef
-- Branch:    feat/workbook-tab-schema-2026-05
-- Purpose:   Phase 1 of the Client Workbook "Onboarding" tab.
--            Adds the schema additions the workbook needs to
--            read onboarding data and (in later phases) write
--            reminder, edit, and form-open audit rows against
--            this same Supabase project.
--
-- Notes for reviewer
-- ------------------
-- All additive. No existing columns are renamed, dropped, or
-- reshaped. The new `workbook_id` column on clients is nullable
-- with a UNIQUE constraint; existing 12+ client rows stay NULL
-- until a separate manual backfill maps them to their Basecamp
-- project ids (Postgres treats multiple NULLs as distinct, so
-- UNIQUE does not block the pre-backfill state).
--
-- The three new tables are append-only audit-style tables. RLS
-- mirrors the existing onboarding_audit_events pattern: SELECT
-- and INSERT policies only, both gated via EXISTS against the
-- parent session's agency_id = auth.uid(). Service-role writes
-- bypass RLS as today.
--
-- No `…_user_id UUID FK` columns: the workbook has no users
-- table yet, so attribution columns are nullable TEXT labels
-- ('sent_by_label', 'edited_by_label'). See discovery-notes.md
-- §5 Q4 in the dashboard-combination workspace.
--
-- Form-open event emission is a separate, dependent PR in this
-- repo that adds the INSERT on /api/public/onboarding/session.
-- That PR cannot land before this migration applies (the table
-- must exist first). Until that PR ships, onboarding_open_events
-- stays empty and the workbook's Open History modal (later
-- phase) shows zero rows.
--
-- Numbering: 008, contiguous with 007. Migration 004 remains
-- claimed by the parked wip/site-intelligence-cleanup-recovered
-- branch (see comment block in 005_p1_p2_admin_session_fields.sql).
--
-- Wrapped in begin;/commit; for atomic apply. Rollback SQL is
-- in this PR's description (not a second migration file).
-- =============================================================

begin;


-- -------------------------------------------------------------
-- clients.workbook_id — join column to the workbook app
-- -------------------------------------------------------------
-- workbook_id: integer Basecamp project id from
--   client-workbook-dashboard's app/data/projects.json. BIGINT,
--   not INT4, to be safe against larger ids Basecamp may issue.
--   Nullable so existing 12+ rows are not broken on add and so
--   future onboarding-side inserts that don't yet know a
--   Basecamp project can keep working. UNIQUE so one onboarding
--   client maps to at most one workbook project. Backfill is a
--   manual operator-reviewed step run separately against
--   Supabase using Resources/workbook-id-backfill.csv as the
--   mapping document.

alter table public.clients
  add column workbook_id bigint;

alter table public.clients
  add constraint clients_workbook_id_unique unique (workbook_id);


-- -------------------------------------------------------------
-- onboarding_open_events — log of public form-token loads
-- -------------------------------------------------------------
-- One row per resolution of /api/public/onboarding/session
-- (i.e., per page load of the client-facing onboarding form,
-- once the emitting PR lands). Used by the workbook's "Opened
-- {n}x" stepper badge and the Open History modal. Append-only;
-- never updated, never deleted. ip_hash is sha256(ip || HMAC
-- secret) — never raw IP.

create table public.onboarding_open_events (
  id          uuid primary key default uuid_generate_v4(),
  session_id  uuid not null references public.onboarding_sessions(id) on delete cascade,
  opened_at   timestamptz not null default now(),
  user_agent  text,
  ip_hash     text,
  created_at  timestamptz not null default now()
);

create index idx_open_events_session_id
  on public.onboarding_open_events (session_id, opened_at desc);

alter table public.onboarding_open_events enable row level security;

create policy "Agency users can view own open events"
  on public.onboarding_open_events for select
  using (
    exists (
      select 1 from public.onboarding_sessions
      where public.onboarding_sessions.id = public.onboarding_open_events.session_id
        and public.onboarding_sessions.agency_id = auth.uid()
    )
  );

create policy "Agency users can insert own open events"
  on public.onboarding_open_events for insert
  with check (
    exists (
      select 1 from public.onboarding_sessions
      where public.onboarding_sessions.id = public.onboarding_open_events.session_id
        and public.onboarding_sessions.agency_id = auth.uid()
    )
  );


-- -------------------------------------------------------------
-- onboarding_reminders — log of reminder & access-request sends
-- -------------------------------------------------------------
-- One row per email the workbook sends to a client about an
-- onboarding session. `kind` separates the two flows (form
-- nudge vs missing-access request). `sent_by_label` is the
-- attribution string (e.g. "AM" or an admin email) — there's
-- no UUID FK because the workbook has no users table in v1
-- (see discovery-notes.md §5 Q4). Append-only.
--
-- The email_body snapshot is stored verbatim so the History
-- modal can show exactly what was sent at the time, even if
-- the template changes later.

create table public.onboarding_reminders (
  id              uuid primary key default uuid_generate_v4(),
  session_id      uuid not null references public.onboarding_sessions(id) on delete cascade,
  kind            text not null check (kind in ('form_reminder', 'access_request')),
  sent_by_label   text,
  sent_at         timestamptz not null default now(),
  email_subject   text not null,
  email_body      text not null,
  created_at      timestamptz not null default now()
);

create index idx_reminders_session_id
  on public.onboarding_reminders (session_id, sent_at desc);

alter table public.onboarding_reminders enable row level security;

create policy "Agency users can view own reminders"
  on public.onboarding_reminders for select
  using (
    exists (
      select 1 from public.onboarding_sessions
      where public.onboarding_sessions.id = public.onboarding_reminders.session_id
        and public.onboarding_sessions.agency_id = auth.uid()
    )
  );

create policy "Agency users can insert own reminders"
  on public.onboarding_reminders for insert
  with check (
    exists (
      select 1 from public.onboarding_sessions
      where public.onboarding_sessions.id = public.onboarding_reminders.session_id
        and public.onboarding_sessions.agency_id = auth.uid()
    )
  );


-- -------------------------------------------------------------
-- onboarding_field_edits — audit log of workbook field edits
-- -------------------------------------------------------------
-- One row per in-place edit made from the workbook's
-- Onboarding tab (Phase 7 of the spec). step_key matches
-- onboarding_answers.step_key; field_key is the inner JSON
-- field within that step's payload. old_value/new_value are
-- JSONB so multi-select arrays and other non-scalar field
-- types round-trip without lossy stringification.
-- edited_by_label is the attribution string — no UUID FK in
-- v1 for the same reason as onboarding_reminders. Append-only.

create table public.onboarding_field_edits (
  id               uuid primary key default uuid_generate_v4(),
  session_id       uuid not null references public.onboarding_sessions(id) on delete cascade,
  step_key         text not null,
  field_key        text not null,
  old_value        jsonb,
  new_value        jsonb,
  edited_by_label  text,
  edited_at        timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index idx_field_edits_session_id
  on public.onboarding_field_edits (session_id, edited_at desc);

alter table public.onboarding_field_edits enable row level security;

create policy "Agency users can view own field edits"
  on public.onboarding_field_edits for select
  using (
    exists (
      select 1 from public.onboarding_sessions
      where public.onboarding_sessions.id = public.onboarding_field_edits.session_id
        and public.onboarding_sessions.agency_id = auth.uid()
    )
  );

create policy "Agency users can insert own field edits"
  on public.onboarding_field_edits for insert
  with check (
    exists (
      select 1 from public.onboarding_sessions
      where public.onboarding_sessions.id = public.onboarding_field_edits.session_id
        and public.onboarding_sessions.agency_id = auth.uid()
    )
  );


-- -------------------------------------------------------------
-- (No backfill needed — existing clients rows get workbook_id
-- = NULL until the manual backfill runs. The three new tables
-- start empty.)
-- -------------------------------------------------------------


commit;


-- =============================================================
-- POST-APPLY SANITY CHECKS (run manually after apply)
-- =============================================================
-- 1. Confirm workbook_id column exists with UNIQUE constraint:
--      select column_name, data_type, is_nullable
--        from information_schema.columns
--       where table_schema = 'public'
--         and table_name = 'clients'
--         and column_name = 'workbook_id';
--
--      select conname, pg_get_constraintdef(oid)
--        from pg_constraint
--       where conrelid = 'public.clients'::regclass
--         and conname = 'clients_workbook_id_unique';
--
-- 2. Confirm all three new tables exist:
--      select to_regclass('public.onboarding_open_events'),
--             to_regclass('public.onboarding_reminders'),
--             to_regclass('public.onboarding_field_edits');
--      -- all three should be non-NULL.
--
-- 3. Confirm RLS is enabled on the new tables:
--      select relname, relrowsecurity
--        from pg_class
--       where relname in (
--         'onboarding_open_events',
--         'onboarding_reminders',
--         'onboarding_field_edits'
--       );
--      -- relrowsecurity should be t for all three.
--
-- 4. Confirm indexes exist:
--      select indexname, tablename
--        from pg_indexes
--       where schemaname = 'public'
--         and indexname in (
--           'idx_open_events_session_id',
--           'idx_reminders_session_id',
--           'idx_field_edits_session_id',
--           'clients_workbook_id_unique'
--         );
--
-- 5. Confirm all existing clients rows have NULL workbook_id
--    immediately post-apply (the manual backfill runs after):
--      select count(*) as unmapped
--        from public.clients
--       where workbook_id is null;
-- =============================================================
