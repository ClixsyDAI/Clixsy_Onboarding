-- =============================================================
-- Migration: 005_p1_p2_admin_session_fields.sql
-- Target:    Supabase project lawwsutjxopiekjzupef
-- Branch:    feat/ui-feedback-2026-05
-- Purpose:   Stage 1 of the onboarding-form-feedback overhaul.
--            P1 — Account Manager + Vertical on session creation.
--            P2 — 6-digit PIN gate columns (hash, attempts, lockouts).
--
-- Notes for reviewer
-- ------------------
-- All additive. No existing columns are renamed, dropped, or
-- reshaped. Existing 12 sessions get `vertical = 'law_firm'` by
-- default (the agency's primary vertical; admin can override per
-- session via session-detail UI if any are actually home-services).
--
-- pin_hash is NULL for existing sessions — those bypass the PIN
-- gate entirely (legacy backward-compat). The client-facing PIN
-- entry screen will treat NULL pin_hash as "no gate required."
-- All NEW sessions created after this migration have pin_hash set
-- by the admin create route.
--
-- Numbering: 005, not 004 — 004 is already claimed by a separate
-- in-flight site-intelligence-cleanup branch
-- (wip/site-intelligence-cleanup-recovered).
--
-- Wrapped in begin;/commit; for atomic apply.
-- =============================================================

begin;


-- -------------------------------------------------------------
-- P1 — Account Manager + Vertical
-- -------------------------------------------------------------
-- account_manager: free-text name of the Clixsy person owning
--   this client. Surfaced in the thank-you screen and (future)
--   admin filters. Nullable for backward-compat with existing
--   rows; the admin UI enforces required for new sessions.
-- vertical:        constrained taxonomy. Initial values are the
--   two agency lines (law_firm | home_services). Extend later
--   with ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT. Default
--   'law_firm' so the NOT NULL constraint backfills cleanly for
--   the existing 12 rows.

alter table public.onboarding_sessions
  add column account_manager text,
  add column vertical text not null default 'law_firm';

alter table public.onboarding_sessions
  add constraint onboarding_sessions_vertical_check
  check (vertical in ('law_firm', 'home_services'));


-- -------------------------------------------------------------
-- P2 — PIN gate state
-- -------------------------------------------------------------
-- pin_hash:           scrypt-hashed 6-digit PIN. Format is the
--                     module's own self-describing encoding
--                     (`scrypt$N$r$p$saltHex$derivedHex`), so
--                     params can rotate without a schema change.
--                     NULL = no PIN required (legacy sessions
--                     created before this migration).
-- pin_attempts:       cumulative count of failed verify attempts
--                     since session creation OR last successful
--                     verify (whichever is most recent). Resets
--                     to 0 on success or admin-triggered reset.
-- pin_lockout_until:  temporary lockout end-time. Set after every
--                     5 failed attempts to push the next allowed
--                     attempt 15 minutes into the future. Cleared
--                     on success. Distinct from pin_locked_at.
-- pin_locked_at:      permanent-lock timestamp. Set once
--                     pin_attempts reaches 10 cumulative.
--                     Only cleared by admin via "regenerate PIN"
--                     (which also rotates pin_hash) or by an
--                     explicit "unlock session" admin action
--                     that zeros all three pin_* state columns
--                     without rotating the hash.

alter table public.onboarding_sessions
  add column pin_hash          text,
  add column pin_attempts      int  not null default 0,
  add column pin_lockout_until timestamptz,
  add column pin_locked_at     timestamptz;


-- -------------------------------------------------------------
-- (No backfill needed — existing 12 sessions get account_manager
-- = NULL, vertical = 'law_firm' (the column default), pin_hash =
-- NULL, pin_attempts = 0, both lockout columns NULL. All values
-- are consistent with "legacy session, no PIN required.")
-- -------------------------------------------------------------


commit;


-- =============================================================
-- POST-APPLY SANITY CHECKS (run manually after apply)
-- =============================================================
-- 1. Confirm new columns exist:
--      select column_name, data_type, is_nullable, column_default
--        from information_schema.columns
--       where table_schema = 'public'
--         and table_name = 'onboarding_sessions'
--         and column_name in (
--           'account_manager', 'vertical',
--           'pin_hash', 'pin_attempts',
--           'pin_lockout_until', 'pin_locked_at'
--         )
--       order by column_name;
--
-- 2. Confirm vertical check constraint:
--      select conname, pg_get_constraintdef(oid)
--        from pg_constraint
--       where conrelid = 'public.onboarding_sessions'::regclass
--         and conname = 'onboarding_sessions_vertical_check';
--
-- 3. Confirm backfill of existing sessions to vertical=law_firm:
--      select vertical, count(*)
--        from public.onboarding_sessions
--       group by vertical;
--
-- 4. Confirm pin_hash is NULL for all existing sessions:
--      select count(*) as legacy_no_pin
--        from public.onboarding_sessions
--       where pin_hash is null;
-- =============================================================
