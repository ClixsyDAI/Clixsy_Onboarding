-- =============================================================
-- Rollback for: 012_client_brief_versions.sql
-- Target:       Supabase project gmvdmgcueveuedhkucsh
--
-- Drops everything migration 012 added: the two capture triggers, all
-- helper / trigger / RPC functions, and the client_brief_versions table
-- (CASCADE removes its indexes and FKs). This destroys all captured
-- brief history - it cannot be recovered after this runs.
--
-- If the writer CODE that sends x-clixsy-brief-source / -actor headers
-- is already deployed, it keeps working after this rollback: a missing
-- table makes nothing fail here because the writers never reference the
-- table directly, and the headers are simply ignored once the triggers
-- that read them are gone. Still, prefer to revert the code first.
--
-- Idempotent: every drop is "if exists", so it is safe to run twice.
-- =============================================================

begin;

drop trigger if exists trg_capture_brief_version on public.onboarding_answers;
drop trigger if exists trg_capture_brief_session_event on public.onboarding_sessions;

drop function if exists public.capture_brief_version();
drop function if exists public.capture_brief_session_event();
drop function if exists public.get_brief(uuid, integer);
drop function if exists public.get_brief_diff(uuid, integer, integer);
drop function if exists public.brief_request_source();
drop function if exists public.brief_request_header(text);
drop function if exists public.brief_diff(jsonb, jsonb);
drop function if exists public.brief_flatten(jsonb);
drop function if exists public.brief_snapshot_for_session(uuid);

drop table if exists public.client_brief_versions cascade;

notify pgrst, 'reload schema';

commit;
