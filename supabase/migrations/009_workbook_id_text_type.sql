-- =============================================================
-- Migration: 009_workbook_id_text_type.sql
-- Target:    Supabase project lawwsutjxopiekjzupef
-- Branch:    fix/workbook-id-string-type
-- Purpose:   Widen public.clients.workbook_id from bigint to text
--            so it can hold GHL opportunity ids (20-char
--            alphanumeric, e.g. "abcDEF0123456789xyzZ") in
--            addition to the legacy Basecamp numeric ids the
--            column was originally sized for.
--
-- Context
-- -------
-- Migration 008 declared workbook_id as bigint with the comment
--   "integer Basecamp project id ... BIGINT, not INT4, to be
--    safe against larger ids Basecamp may issue."
-- The GHL pivot changes this assumption: opportunity ids are
-- alphanumeric strings, not numerics. Without the type change,
-- the onboarding `/api/admin/onboarding/create` endpoint's INSERT
-- would fail with `invalid input syntax for type bigint` on any
-- new GHL-issued id.
--
-- Apply order vs the matching code change
-- ---------------------------------------
-- This migration is paired with widening the Zod schema in
-- src/app/api/admin/onboarding/create/route.ts from
-- z.number().int().positive() → a 1-32 char alphanumeric+_-
-- string regex. Both must land together; either alone is a no-op
-- (Zod-only would still hit bigint insert errors; SQL-only would
-- still be rejected by the Zod gate).
--
-- Existing-data correctness
-- -------------------------
-- The 63 client rows that have non-NULL workbook_id all hold
-- stringified Basecamp numeric ids (8-9 digits). The
-- `using workbook_id::text` cast converts them losslessly. Rows
-- with NULL workbook_id are unaffected.
--
-- Constraints preserved
-- ---------------------
-- The clients_workbook_id_unique constraint is replayed by
-- Postgres against the new column type automatically when
-- ALTER COLUMN TYPE runs; no explicit DROP/ADD is needed. Same
-- for the column's nullability (stays nullable).
--
-- Rollback
-- --------
-- Safe to reverse ONLY while all stored values are still
-- numeric-looking strings (i.e. no GHL-issued opportunity ids
-- have been INSERTed yet). After the first GHL write, rollback
-- to bigint would fail with `invalid input syntax for type bigint`
-- on those rows. The PR description carries the rollback SQL:
--   alter table public.clients
--     alter column workbook_id type bigint using workbook_id::bigint;
--
-- Wrapped in begin;/commit; for atomic apply.
-- =============================================================

begin;

alter table public.clients
  alter column workbook_id type text using workbook_id::text;

commit;
