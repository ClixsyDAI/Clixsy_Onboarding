-- =============================================================
-- Migration: 012_client_brief_versions.sql
-- Target:    Supabase project gmvdmgcueveuedhkucsh (shared by both apps)
-- Branch:    feat/brief-versioning
-- Purpose:   Put "the brief" (a client's onboarding answers, all steps
--            together) under version control. Every time the answers
--            actually change, a new immutable version row is written
--            with the full snapshot, a field-level diff vs the previous
--            version, who/what caused it, and when. Stage 2 exposes
--            these rows read-only through the Wiki-by-Clixsy MCP.
--
-- THE RULES THIS ENCODES
-- ----------------------
--   * Versions are per client, numbered from 0, no gaps.
--   * v0 is created when the onboarding session is minted (an empty
--     brief). If create seeds answers (primary_contact), that lands as
--     v1 with source session_created.
--   * A new version is written ONLY when the full answer set changes.
--     A no-op save (same answers) writes nothing.
--   * Every writer counts: onboarding saves, submit, the create seed,
--     and the dashboard's workbook field-edits. Capture is in the
--     database (triggers), so no writer can skip it.
--   * The version current at submit is marked (is_submit), not
--     duplicated, so it is findable in one query.
--   * Existing clients get exactly ONE backfill version (v0) from their
--     current answers. The backfill runs inside this migration, BEFORE
--     the triggers are created.
--
-- FAIL-OPEN GUARANTEE
-- -------------------
-- The capture triggers must NEVER block or fail a save. Both trigger
-- bodies are wrapped so that ANY error raises a WARNING and the
-- underlying write still commits. Losing a version row is acceptable;
-- losing a client's answer save is not.
--
-- APPLY ORDER: THIS SQL FIRST, THE CODE SECOND
-- --------------------------------------------
-- Same reasoning as 011. This SQL is additive (a new table, new
-- functions, new triggers) and touches no existing column, so deploying
-- it before the writer-header changes is safe: until each writer sends
-- its x-clixsy-brief-source header, new versions are simply recorded
-- with source 'unknown' (the trigger defaults to it). The writers can
-- then deploy in any order. There is no PGRST204-style outage window
-- here because nothing existing references the new objects.
--
-- SOURCE / ACTOR
-- --------------
-- PostgREST exposes the request headers to SQL via the GUC
-- current_setting('request.headers', true). Each writer sets
-- supabase-js global headers:
--     x-clixsy-brief-source : one of the allowed source values
--     x-clixsy-brief-actor  : the acting user's email (workbook edits)
-- brief_request_source() validates the header against the allowed set
-- and falls back to 'unknown', so the source CHECK can never trip from
-- caller input. When no header is present (direct SQL, or a writer not
-- yet updated) the source is 'unknown'.
--
-- ROLLBACK
-- --------
-- See 012_client_brief_versions_rollback.sql in this folder (and the
-- copy at C:\clixsy-recon\onboarding-clickup\brief-versioning-rollback.sql).
-- It drops the two triggers, all functions, and the table (CASCADE).
-- Revert the writer CODE first if it is already deployed, though a
-- missing header only downgrades source to 'unknown' - it never errors.
--
-- Wrapped in begin;/commit; for atomic apply, matching 005-009 and 011.
-- =============================================================

begin;


-- =============================================================
-- TABLE
-- =============================================================

create table if not exists public.client_brief_versions (
    id          uuid primary key default uuid_generate_v4(),
    client_id   uuid not null references public.clients(id) on delete cascade,
    -- Kept nullable with ON DELETE SET NULL so a version survives its
    -- originating session being regenerated or deleted; the brief's
    -- history belongs to the client, not to one session.
    session_id  uuid references public.onboarding_sessions(id) on delete set null,
    version     integer not null,
    -- Full merged answer set at this version: { step_key: { field: value } }.
    snapshot    jsonb not null,
    -- Field-level changes vs the previous version's snapshot:
    -- [ { "path": "step_key.field", "before": <json>, "after": <json> }, ... ]
    diff        jsonb not null default '[]'::jsonb,
    source      text not null default 'unknown'
                  check (source in (
                    'session_created',
                    'onboarding_save',
                    'onboarding_submit',
                    'workbook_edit',
                    'backfill',
                    'unknown'
                  )),
    -- Acting user where known (e.g. the AM's email on a workbook edit).
    actor       text,
    -- True on the single version that was current when the session was
    -- submitted. Marked, never duplicated.
    is_submit   boolean not null default false,
    created_at  timestamptz not null default now(),
    unique (client_id, version)
);

create index if not exists idx_brief_versions_client_version
  on public.client_brief_versions (client_id, version desc);

comment on table public.client_brief_versions is
  'Version history of each client''s onboarding brief (all answer steps merged). One row per change; numbered per client from 0 with no gaps. Written only by the capture triggers on onboarding_answers and onboarding_sessions. Service-role only.';


-- =============================================================
-- ROW LEVEL SECURITY (service role only)
-- =============================================================
-- Matches the hardened posture of migration 025: RLS on, no permissive
-- policies, privileges revoked from anon/authenticated/public, granted
-- only to service_role. The capture triggers are SECURITY DEFINER
-- (owned by the migration runner) so they write regardless of RLS, and
-- service_role is BYPASSRLS in any case.

alter table public.client_brief_versions enable row level security;

revoke all on public.client_brief_versions from anon, authenticated, public;
grant all on public.client_brief_versions to service_role;


-- =============================================================
-- HELPER FUNCTIONS (pure / read-only; used by backfill and triggers)
-- =============================================================

-- Merge every answer step row for one session into a single snapshot:
--   { step_key: answers_jsonb, ... }. Empty / unknown session -> '{}'.
create or replace function public.brief_snapshot_for_session(p_session_id uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_object_agg(step_key, answers), '{}'::jsonb)
  from public.onboarding_answers
  where session_id = p_session_id;
$$;

-- Flatten a snapshot to one level of "step_key.field" -> value, so the
-- diff is field-level. A step whose value is not an object is kept whole
-- under its step_key. An empty step object contributes nothing.
create or replace function public.brief_flatten(p_snapshot jsonb)
returns jsonb
language sql
immutable
as $$
  -- distinct on (path) makes a pathological path collision (e.g. a field
  -- key that itself contains a dot) resolve deterministically instead of
  -- raising a duplicate-key error inside jsonb_object_agg, which would
  -- otherwise abort the whole backfill.
  select coalesce(jsonb_object_agg(path, val), '{}'::jsonb)
  from (
    select distinct on (path) path, val
    from (
      select
        case when jsonb_typeof(step.value) = 'object'
             then step.key || '.' || field.key
             else step.key
        end as path,
        case when jsonb_typeof(step.value) = 'object'
             then field.value
             else step.value
        end as val
      from jsonb_each(coalesce(p_snapshot, '{}'::jsonb)) as step(key, value)
      left join lateral jsonb_each(
        case when jsonb_typeof(step.value) = 'object'
             then step.value
             else '{}'::jsonb
        end
      ) as field(key, value) on true
      where jsonb_typeof(step.value) <> 'object'
         or field.key is not null
    ) flat
    order by path
  ) deduped;
$$;

-- Field-level diff between two snapshots. Returns a jsonb array of
-- { path, before, after } for every path whose value differs (added,
-- removed, or changed). An absent side is reported as JSON null.
create or replace function public.brief_diff(p_before jsonb, p_after jsonb)
returns jsonb
language sql
immutable
as $$
  with b as (select public.brief_flatten(p_before) as m),
       a as (select public.brief_flatten(p_after)  as m),
       paths as (
         select jsonb_object_keys((select m from b)) as path
         union
         select jsonb_object_keys((select m from a))
       )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'path',   p.path,
               'before', (select m from b) -> p.path,
               'after',  (select m from a) -> p.path
             )
             order by p.path
           ),
           '[]'::jsonb
         )
  from paths p
  where ((select m from b) -> p.path) is distinct from ((select m from a) -> p.path);
$$;

-- Read one request header forwarded by PostgREST, or NULL if there is
-- no request context (direct SQL) or the GUC is absent/malformed.
create or replace function public.brief_request_header(p_name text)
returns text
language plpgsql
stable
as $$
begin
  return nullif(current_setting('request.headers', true)::json ->> p_name, '');
exception when others then
  return null;
end;
$$;

-- The validated brief source: the x-clixsy-brief-source header if it is
-- one of the allowed values, else 'unknown'. Guarantees the source
-- CHECK is never tripped by caller input.
create or replace function public.brief_request_source()
returns text
language sql
stable
as $$
  select case
    when public.brief_request_header('x-clixsy-brief-source') in (
      'session_created','onboarding_save','onboarding_submit',
      'workbook_edit','backfill','unknown'
    )
    then public.brief_request_header('x-clixsy-brief-source')
    else 'unknown'
  end;
$$;


-- =============================================================
-- BACKFILL (runs BEFORE the triggers exist)
-- =============================================================
-- Exactly one v0 per existing client, from the current answers of its
-- most recent session. Session-less clients get an empty snapshot. The
-- table is empty here, so the unique (client_id, version) never clashes.
-- diff is computed against an empty snapshot, so v0 self-describes the
-- fields present at backfill time (or [] for an empty brief).

insert into public.client_brief_versions
  (client_id, session_id, version, snapshot, diff, source, actor)
select
  c.id,
  s.id,
  0,
  coalesce(public.brief_snapshot_for_session(s.id), '{}'::jsonb),
  public.brief_diff('{}'::jsonb, coalesce(public.brief_snapshot_for_session(s.id), '{}'::jsonb)),
  'backfill',
  null
from public.clients c
left join lateral (
  select id
  from public.onboarding_sessions
  where client_id = c.id
  order by created_at desc
  limit 1
) s on true;


-- =============================================================
-- CAPTURE TRIGGER: onboarding_answers (the main writer path)
-- =============================================================
-- AFTER INSERT OR UPDATE, FOR EACH ROW. Builds the full snapshot for the
-- row's session, and if it differs from the client's latest version,
-- writes a new version. The per-client advisory lock serialises version
-- allocation so concurrent saves get distinct, gapless numbers, and
-- collapses a multi-row statement into a single version. The whole body
-- is fail-open: any error becomes a WARNING and the save still commits.

create or replace function public.capture_brief_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id    uuid;
  v_client_id     uuid;
  v_new_snapshot  jsonb;
  v_prev_version  integer;
  v_prev_snapshot jsonb;
begin
  v_session_id := coalesce(NEW.session_id, OLD.session_id);
  if v_session_id is null then
    return NEW;
  end if;

  select client_id into v_client_id
  from public.onboarding_sessions
  where id = v_session_id;

  if v_client_id is null then
    return NEW;
  end if;

  -- Serialise version allocation for this client.
  perform pg_advisory_xact_lock(hashtextextended('client_brief:' || v_client_id::text, 0));

  v_new_snapshot := public.brief_snapshot_for_session(v_session_id);

  select version, snapshot
    into v_prev_version, v_prev_snapshot
  from public.client_brief_versions
  where client_id = v_client_id
  order by version desc
  limit 1;

  -- No-op: the answer set is unchanged from the latest version.
  if v_prev_snapshot is not null
     and v_prev_snapshot is not distinct from v_new_snapshot then
    return NEW;
  end if;

  insert into public.client_brief_versions
    (client_id, session_id, version, snapshot, diff, source, actor)
  values (
    v_client_id,
    v_session_id,
    coalesce(v_prev_version + 1, 0),
    v_new_snapshot,
    public.brief_diff(coalesce(v_prev_snapshot, '{}'::jsonb), v_new_snapshot),
    public.brief_request_source(),
    public.brief_request_header('x-clixsy-brief-actor')
  );

  return NEW;
exception when others then
  raise warning 'capture_brief_version failed for session %: % (%)',
    v_session_id, sqlerrm, sqlstate;
  return NEW;
end;
$$;

create trigger trg_capture_brief_version
  after insert or update on public.onboarding_answers
  for each row
  execute function public.capture_brief_version();


-- =============================================================
-- CAPTURE TRIGGER: onboarding_sessions (v0 + submit marker)
-- =============================================================
-- AFTER INSERT OR UPDATE, FOR EACH ROW.
--   INSERT: create the empty v0 (source session_created), but only if
--           the client has no version yet - so a regenerated session
--           for an already-backfilled or already-started client does
--           not add a spurious empty version.
--   UPDATE: when status first becomes 'submitted', mark the client's
--           latest version is_submit = true.
-- Also fail-open. This trigger fires on the frequent last_saved_at
-- touch too; the status guard makes that a cheap no-op.

create or replace function public.capture_brief_session_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing integer;
begin
  if TG_OP = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('client_brief:' || NEW.client_id::text, 0));

    select 1 into v_existing
    from public.client_brief_versions
    where client_id = NEW.client_id
    limit 1;

    if v_existing is null then
      insert into public.client_brief_versions
        (client_id, session_id, version, snapshot, diff, source, actor)
      values (NEW.client_id, NEW.id, 0, '{}'::jsonb, '[]'::jsonb, 'session_created', null);
    end if;

    return NEW;

  elsif TG_OP = 'UPDATE' then
    if NEW.status = 'submitted' and OLD.status is distinct from 'submitted' then
      perform pg_advisory_xact_lock(hashtextextended('client_brief:' || NEW.client_id::text, 0));

      update public.client_brief_versions
      set is_submit = true
      where client_id = NEW.client_id
        and version = (
          select max(version)
          from public.client_brief_versions
          where client_id = NEW.client_id
        );
    end if;

    return NEW;
  end if;

  return NEW;
exception when others then
  raise warning 'capture_brief_session_event failed for session %: % (%)',
    NEW.id, sqlerrm, sqlstate;
  return NEW;
end;
$$;

create trigger trg_capture_brief_session_event
  after insert or update on public.onboarding_sessions
  for each row
  execute function public.capture_brief_session_event();


-- =============================================================
-- READ RPCs (for Stage 2 / MCP; service-role only)
-- =============================================================
-- Field keys are kept stable and raw; the MCP layer adds human labels.

-- The brief at a given version, or the latest when p_version is NULL.
create or replace function public.get_brief(p_client_id uuid, p_version integer default null)
returns public.client_brief_versions
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.client_brief_versions
  where client_id = p_client_id
    and (p_version is null or version = p_version)
  order by version desc
  limit 1;
$$;

-- The field-level diff between any two versions of a client's brief.
create or replace function public.get_brief_diff(
  p_client_id uuid,
  p_from_version integer,
  p_to_version integer
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.brief_diff(
    coalesce((select snapshot from public.client_brief_versions
               where client_id = p_client_id and version = p_from_version), '{}'::jsonb),
    coalesce((select snapshot from public.client_brief_versions
               where client_id = p_client_id and version = p_to_version), '{}'::jsonb)
  );
$$;

-- These read the service-role-only table as SECURITY DEFINER, so they
-- must not be callable by anon/authenticated (that would bypass RLS).
revoke all on function public.get_brief(uuid, integer) from public;
revoke all on function public.get_brief_diff(uuid, integer, integer) from public;
grant execute on function public.get_brief(uuid, integer) to service_role;
grant execute on function public.get_brief_diff(uuid, integer, integer) to service_role;


-- =============================================================
-- Make the new table + RPCs visible to the API immediately.
-- =============================================================
notify pgrst, 'reload schema';


commit;


-- =============================================================
-- POST-APPLY SANITY CHECKS (run manually after apply)
-- =============================================================
-- 1. Table shape and RLS:
--      select relrowsecurity, relforcerowsecurity
--        from pg_class where oid = 'public.client_brief_versions'::regclass;
--      -- relrowsecurity = true expected.
--
-- 2. Backfill census: exactly one v0 per client, all source 'backfill'.
--      select count(*) as backfill_rows,
--             count(distinct client_id) as clients,
--             count(*) filter (where version = 0) as v0_rows,
--             count(*) filter (where source = 'backfill') as backfill_source
--        from public.client_brief_versions;
--      select count(*) as total_clients from public.clients;
--      -- backfill_rows = clients = v0_rows = backfill_source = total_clients.
--
-- 3. No client has more than one row yet (no gaps / dupes at baseline):
--      select client_id, count(*)
--        from public.client_brief_versions
--       group by client_id having count(*) <> 1;
--      -- expect zero rows.
--
-- 4. RPC lockdown: anon/authenticated must NOT have execute on get_brief.
--      select grantee, privilege_type
--        from information_schema.routine_privileges
--       where routine_name in ('get_brief','get_brief_diff')
--       order by routine_name, grantee;
--      -- expect only service_role (and the owner), never anon/authenticated/PUBLIC.
--
-- 5. Smoke a version read (replace the id with a real backfilled client):
--      select version, source, is_submit, jsonb_array_length(diff) as diff_len
--        from public.get_brief('00000000-0000-0000-0000-000000000000'::uuid);
-- =============================================================
