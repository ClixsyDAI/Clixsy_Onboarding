-- =============================================================
-- Migration: 010_pm_tracker_pushes.sql
-- Target:    Supabase project gmvdmgcueveuedhkucsh (shared by both apps)
-- Branch:    feat/approve-push-onboarding-seed-2026-07
-- Purpose:   Back the "approve-and-push" flow (onboarded client ->
--            Chris's Project Register + Basecamp + workbook).
--
-- Adds:
--   1. public.pm_tracker_pushes — one row per onboarded client, keyed on
--      workbook_id (the GHL opportunity id; the same idempotency key the
--      dashboard bridge reconciles on). Seeded at onboarding submit with
--      the onboarding-derived fields and status='pending' (NO j_number).
--      The dashboard fills the AM-entered internal fields and, on
--      "Approve & push", mints the J and records the push bookkeeping.
--   2. public.client_jnumber_seq — the SINGLE source of truth for the
--      next J-number, seeded to START 450 (Chris's Register max is J441;
--      442-449 is a deliberate safety gap). nextval() is atomic, so two
--      simultaneous pushes can never mint the same J.
--   3. public.mint_client_jnumber() — security-definer RPC that returns
--      nextval('client_jnumber_seq'), callable by the service role.
--
-- Decision context (R8): the J is minted at APPROVAL PUSH, not at submit.
-- pm_tracker_pushes.j_number is therefore NULLABLE (null until the first
-- successful push step assigns it). Abandoned/never-approved onboardings
-- consume no J-number -> no gaps.
--
-- This migration is additive only (new table + sequence + function). It
-- does not alter or read any existing table. Safe to apply live.
-- =============================================================

-- 1. The push/enrichment record ------------------------------------------------
create table if not exists public.pm_tracker_pushes (
  workbook_id           text primary key,                         -- GHL opportunity id (idempotency key)
  j_number              integer,                                  -- NULL until minted at push (R8)
  vertical              text not null default 'other',            -- law_firm | home_services | other

  -- onboarding-derived (seeded at submit; AM-editable in the dashboard):
  company_name          text,
  domain                text,
  website_url           text,
  contact_name          text,
  contact_title         text,
  contact_phone         text,
  contact_email         text,
  physical_address      text,

  -- AM-entered internal fields (the Register columns onboarding doesn't collect):
  client_manager        text,
  account_manager       text,
  project_manager       text,
  seo_manager           text,
  ops_manager           text,
  work_teams            text,
  locations             text,
  case_types            text,
  referral              text,
  service_flags         jsonb not null default '{}'::jsonb,       -- {seo,rep,ppc,smartAds,lsa,vid,amp,web,...}
  access_flags          jsonb not null default '{}'::jsonb,       -- {gsc,ga,gbp,gtm}

  -- push bookkeeping (step-checkpointed, idempotent, resumable):
  status                text not null default 'pending',          -- pending|pushing|error|pushed|rolled_back
  register_row          integer,                                  -- the Project Register row we wrote (>447)
  basecamp_project_id   bigint,
  basecamp_todoset_id   bigint,
  workbook_file_id      text,                                     -- copied client workbook (Drive file id)
  copy_deferred         boolean not null default false,           -- true if the Drive copy sub-step was deferred
  last_error            text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  pushed_at             timestamptz
);

comment on table public.pm_tracker_pushes is
  'Approve-and-push record per onboarded client, keyed on workbook_id. Seeded at onboarding submit (status=pending, j_number=null); the dashboard mints the J and pushes to Chris''s Project Register + Basecamp + workbook.';

-- Support the pending-clients list query (status filter).
create index if not exists pm_tracker_pushes_status_idx
  on public.pm_tracker_pushes (status);

-- keep updated_at fresh
create or replace function public.pm_tracker_pushes_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pm_tracker_pushes_touch on public.pm_tracker_pushes;
create trigger pm_tracker_pushes_touch
  before update on public.pm_tracker_pushes
  for each row execute function public.pm_tracker_pushes_touch_updated_at();

-- 2. The J-number sequence -----------------------------------------------------
-- START 450: continues above Chris's live max (J441) with a safety gap.
create sequence if not exists public.client_jnumber_seq
  as integer
  start with 450
  increment by 1
  no cycle;

comment on sequence public.client_jnumber_seq is
  'Single source of truth for the next client J-number. Started at 450 (Chris''s Register max was J441). nextval() is atomic -> no duplicate J under concurrent pushes.';

-- 3. The atomic minter ---------------------------------------------------------
create or replace function public.mint_client_jnumber()
returns integer
language sql
security definer
set search_path = public
as $$
  select nextval('public.client_jnumber_seq')::integer;
$$;

comment on function public.mint_client_jnumber() is
  'Atomically mint the next J-number (nextval on client_jnumber_seq). Called once, idempotently, as step 1 of the approve-and-push transaction.';

-- Service role executes it (RLS/grants): the service role bypasses RLS, but
-- make execute intent explicit.
grant execute on function public.mint_client_jnumber() to service_role;
