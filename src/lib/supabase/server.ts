import { createClient } from '@supabase/supabase-js';

// Server-side Supabase client with service role for bypassing RLS
// ONLY use this on the server side for public token-based access

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export function createServiceRoleClient() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Types for database operations
export interface OnboardingSession {
  id: string;
  agency_id: string;
  client_id: string;
  token: string;
  status: 'draft' | 'in_progress' | 'submitted';
  flow_version: 'v1' | 'v2';
  current_step: number;
  last_saved_at: string | null;
  submitted_at: string | null;
  logo_path: string | null;
  logo_url: string | null;
  created_at: string;
  // Stage 1 (migration 005) — PIN gate state.
  pin_hash: string | null;
  pin_attempts: number;
  pin_lockout_until: string | null;
  pin_locked_at: string | null;
  // Stage 7 (migration 006) — first-login welcome modal flag.
  welcome_wizard_seen: boolean;
  // Site-intelligence link — points to onboarding_site_intelligence.id
  // when the AM (admin flow) or the client (public wizard step 1 flow)
  // has run a site analysis for this session. Null when no analysis
  // has been linked yet (default state for cron-created sessions).
  site_intelligence_id: string | null;
}

export interface OnboardingAnswer {
  id: string;
  session_id: string;
  step_key: string;
  answers: Record<string, unknown>;
  completed: boolean;
  updated_at: string;
}

export interface Client {
  id: string;
  agency_id: string;
  client_name: string;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  created_at: string;
}

// Helper functions for common operations
export async function getClientById(clientId: string): Promise<Client | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (error || !data) {
    return null;
  }

  return data as Client;
}

export async function getSessionByToken(token: string): Promise<OnboardingSession | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('onboarding_sessions')
    .select('*')
    .eq('token', token)
    .single();

  if (error || !data) {
    return null;
  }

  return data as OnboardingSession;
}

export async function getSessionAnswers(sessionId: string): Promise<OnboardingAnswer[]> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('onboarding_answers')
    .select('*')
    .eq('session_id', sessionId)
    .order('updated_at', { ascending: true });

  if (error) {
    console.error('Error fetching answers:', error);
    return [];
  }

  return (data || []) as OnboardingAnswer[];
}

export async function upsertAnswer(
  sessionId: string,
  stepKey: string,
  answers: Record<string, unknown>,
  completed: boolean
): Promise<OnboardingAnswer | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('onboarding_answers')
    .upsert(
      {
        session_id: sessionId,
        step_key: stepKey,
        answers,
        completed,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: 'session_id,step_key',
      }
    )
    .select()
    .single();

  if (error) {
    console.error('Error upserting answer:', error);
    return null;
  }

  return data as OnboardingAnswer;
}

export async function updateSessionStep(
  sessionId: string,
  currentStep: number,
  status?: 'draft' | 'in_progress' | 'submitted'
): Promise<boolean> {
  const supabase = createServiceRoleClient();

  const updateData: Partial<OnboardingSession> = {
    current_step: currentStep,
    last_saved_at: new Date().toISOString(),
  };

  if (status) {
    updateData.status = status;
    if (status === 'submitted') {
      updateData.submitted_at = new Date().toISOString();
    }
  }

  const { error } = await supabase
    .from('onboarding_sessions')
    .update(updateData)
    .eq('id', sessionId);

  if (error) {
    console.error('Error updating session:', error);
    return false;
  }

  return true;
}

// ===========================================================================
// AUDIT / OPEN-EVENT WRITES — surfaced, never swallowed
// ===========================================================================
//
// WHAT THIS REPLACES. Both primitives used to be a bare
//
//     await supabase.from('<table>').insert({ ... });
//
// with `.error` never read. That is silent by construction, and the reason is
// in postgrest-js itself (node_modules/@supabase/postgrest-js/src/
// PostgrestBuilder.ts @ 2.89.0, line numbers verified against the installed
// copy):
//
//   :26   `shouldThrowOnError = false` is the DEFAULT. Nothing here flips it.
//   :182  a non-2xx body is JSON.parsed into `error` and RESOLVED.
//   :209  `if (error && this.shouldThrowOnError) {`
//   :210  `throw new PostgrestError(error)` — the file's ONLY throw, behind
//         that false guard, so it never runs on our path.
//   :224  `if (!this.shouldThrowOnError) {`
//   :225  `res = res.catch((fetchError) => {` — a TRANSPORT failure is caught
//         and converted into a RESOLVED value carrying
//   :259  `status: 0` and a synthesised error whose `code` is the EMPTY
//         STRING, not undefined.
//
// So on the code path actually in use there is NO rejection to normalise: an
// HTTP fault, a transport fault and a timeout are three spellings of the same
// RESOLVED `{ error, status }` shape. That is what `normaliseAuditFault`
// branches on.
//
// AND THE TIMEOUT IS OURS. Nothing upstream produces one on a useful horizon —
// undici's own header/body timeout is 300s, past any Vercel function lifetime
// — so the write is bounded here with `.abortSignal(AbortSignal.timeout(ms))`,
// with a different bound per disposition. See AUDIT_WRITE_TIMEOUT_MS_DEGRADE /
// AUDIT_WRITE_TIMEOUT_MS_FAIL_CLOSED below for the two numbers and why they
// differ. Without that bound these primitives were TOTAL but not TERMINATING:
// a hung write never resolved, so no fault was ever normalised and no line was
// ever logged.
//
// WHY NOT `.throwOnError()`. It is the one change that would CREATE a
// two-shape problem: with `shouldThrowOnError` true, :224's catch is skipped,
// so a transport fault rejects with the raw undici TypeError while an HTTP
// fault throws a PostgrestError. Two shapes to normalise instead of one, for
// no gain. It is deliberately not used.
//
// THE ONE GENUINE REJECTION PATH is `createServiceRoleClient()` (:9-12), which
// throws 'Missing Supabase environment variables' BEFORE any query is built.
// Both entry points below catch it and re-emit it as fault kind 'client_init',
// so a rotated or missing env var is a normal fault rather than an exception
// escaping from a different frame than every other failure.

/** Which layer refused the write. */
export type AuditFaultKind =
  /** createServiceRoleClient() threw: env missing or rotated away. */
  | 'client_init'
  /** status 0 plus a synthesised fetch-layer error (PostgrestBuilder.ts:225/:259). */
  | 'transport'
  /** status 0, and the synthesised message names a TimeoutError. */
  | 'timeout'
  /** status >= 400 with a real PostgREST error body: Postgres refused the row. */
  | 'postgrest'
  /**
   * status >= 400 but the body did NOT come from PostgREST: an HTML 502 from a
   * proxy, a Cloudflare interstitial, an LB's `{"error":"..."}`. See
   * `normaliseAuditFault` for how that is told apart, and why it is not
   * 'postgrest'.
   */
  | 'gateway'
  /** Anything that did not match the contract above. Should not occur. */
  | 'unknown';

export interface AuditFault {
  kind: AuditFaultKind;
  /** 0 for transport/timeout, the HTTP status for a PostgREST fault, null otherwise. */
  status: number | null;
  /** SQLSTATE / PGRST code. The empty string is normalised to null. */
  code: string | null;
  message: string;
}

/**
 * Everything an operator needs in order to act on the log line WITHOUT a
 * second query. `succeeded` is the field that stops someone chasing phantom
 * data loss: it says, in words, what really did land.
 */
export interface AuditWriteContext {
  sessionId: string;
  clientId?: string | null;
  /** Logical name of what was recorded (an audit event_type, or e.g. 'session_opened'). */
  eventType: string;
  /** Where the write was issued from, e.g. 'POST /api/public/onboarding/save-step'. */
  route: string;
  /** What DID succeed, so a lost audit row is not mistaken for lost user data. */
  succeeded: string;
}

/** A table-agnostic write. `row` is whatever that table's shape is. */
export interface AuditWriteSpec extends AuditWriteContext {
  table: string;
  row: Record<string, unknown>;
}

export class AuditWriteError extends Error {
  readonly fault: AuditFault;
  readonly table: string;
  readonly context: AuditWriteContext;

  constructor(spec: AuditWriteSpec, fault: AuditFault) {
    super(
      `audit write to ${spec.table} failed (${fault.kind}` +
        `${fault.status === null ? '' : `, status ${fault.status}`}` +
        `${fault.code === null ? '' : `, code ${fault.code}`}): ${fault.message}`,
    );
    this.name = 'AuditWriteError';
    this.fault = fault;
    this.table = spec.table;
    this.context = {
      sessionId: spec.sessionId,
      clientId: spec.clientId ?? null,
      eventType: spec.eventType,
      route: spec.route,
      succeeded: spec.succeeded,
    };
  }
}

/** The shape postgrest-js resolves into `.error`, both synthesised and real. */
interface PostgrestErrorLike {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * MESSAGE BOUND.
 *
 * The failure line is one line of JSON in a full-text search box, and
 * `message` is the ONE field whose content is chosen by whatever answered the
 * request rather than by this code. A proxy 502 lands its entire HTML body
 * there verbatim: measured at 768 bytes for a stock nginx error page, which is
 * a ~900-byte log line whose useful half (route, table, fault, session) is
 * pushed off the end of the operator's terminal.
 *
 * 300 characters is chosen because every message this app can actually produce
 * fits well inside it: the longest real one is the PostgREST RLS refusal
 * ('new row violates row-level security policy for table "onboarding_audit_events"',
 * 78 chars), and the synthesised transport message tops out near 60. So the
 * bound only ever bites on a body this code did not author, which is exactly
 * the case it exists for.
 */
export const MAX_FAULT_MESSAGE_CHARS = 300;

/**
 * Truncate to the bound, and SAY SO. A silently clipped message is worse than
 * a long one: it reads as a complete sentence that happens to be strange, and
 * an operator cannot tell whether the interesting part was cut. The marker
 * carries the original length so the size itself stays diagnosable.
 *
 * Applied to EVERY fault message, not just gateway bodies, so no path can
 * reintroduce an unbounded line later.
 */
function boundFaultMessage(message: string): string {
  if (message.length <= MAX_FAULT_MESSAGE_CHARS) return message;
  return (
    message.slice(0, MAX_FAULT_MESSAGE_CHARS) +
    `... [truncated: ${message.length} chars total, ${MAX_FAULT_MESSAGE_CHARS} shown]`
  );
}

/** Own-property presence, safe against a null-prototype or exotic `error`. */
function hasKey(error: PostgrestErrorLike, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(error, key);
  } catch {
    return false;
  }
}

/**
 * Normalise a RESOLVED `{ error, status }` into a fault. Written against the
 * resolved-value contract above, NOT against a rejection contract.
 *
 * `error.code || null` is deliberate and `??` would be a bug: a transport
 * fault carries `code: ''` (PostgrestBuilder.ts:259), and `?? null` keeps the
 * empty string, which then prints as `pg_code:""` and reads like a real
 * SQLSTATE that happens to be blank.
 *
 * POSTGREST vs GATEWAY. PostgrestBuilder.ts:179-201 handles a non-2xx body in
 * two branches, and they produce DIFFERENT shapes:
 *
 *   :182  `error = JSON.parse(body)` — a real PostgREST refusal, which always
 *         carries the quadruple message/details/hint/code (any of the last
 *         three may be null, but the KEY is present).
 *   :197  `error = { message: body }` — JSON.parse threw, so the raw body is
 *         stuffed into `message` and there is NO code, details or hint key at
 *         all. Verified empirically against the installed 2.89.0: a 502 with
 *         an HTML body resolves as status 502, `Object.keys(error)` exactly
 *         `["message"]`, `error.code === undefined`.
 *
 * So "none of code/details/hint is present" IS the discriminator, and it also
 * catches the near-miss case of a proxy answering valid JSON that is not a
 * PostgREST error (`{"error":"bad gateway"}`). Calling that 'postgrest' with
 * `pg_code: null` told an operator to go looking for a Postgres problem that
 * does not exist; 'gateway' sends them to the network path instead.
 */
export function normaliseAuditFault(
  status: number | null | undefined,
  error: PostgrestErrorLike | null | undefined,
): AuditFault {
  const message = boundFaultMessage(error?.message || 'the write was refused with no error body');
  const code = error?.code || null;
  const httpStatus = typeof status === 'number' ? status : null;

  if (httpStatus === 0) {
    // A timeout is the SAME resolved shape as any other transport fault; only
    // the synthesised message differs ('TimeoutError: ...' vs 'TypeError: ...',
    // built from `fetchError.name` at PostgrestBuilder.ts:249). An
    // AbortSignal.timeout abort RESOLVES here rather than rejecting, because
    // :225's catch swallows the rejection like any other fetch failure —
    // verified empirically against a stalling server on the installed 2.89.0.
    return {
      kind: /^TimeoutError\b/.test(message) ? 'timeout' : 'transport',
      status: 0,
      code,
      message,
    };
  }
  if (httpStatus !== null && httpStatus >= 400) {
    const fromPostgrest =
      error != null && (hasKey(error, 'code') || hasKey(error, 'details') || hasKey(error, 'hint'));
    return { kind: fromPostgrest ? 'postgrest' : 'gateway', status: httpStatus, code, message };
  }
  return { kind: 'unknown', status: httpStatus, code, message };
}

const AUDIT_WRITE_FAILURE_TAG = '[audit-write][WRITE-FAILURE]';

/**
 * THE LOG LINE.
 *
 * The only sink that survives Supabase being down is console.error into the
 * Vercel runtime logs. There is no drain, no Sentry, nothing else wired, and
 * every candidate "durable" table lives in the SAME Supabase project, so a
 * second row would fail for the same reason the first one did.
 *
 * That surviving sink is a full-text search box, so the shape is a fixed
 * literal tag followed by ONE line of JSON, mirroring the dashboard's proven
 * `[admin-activity][WRITE-FAILURE]` line. JSON.stringify escapes any newline
 * inside a message, so this can never fragment into several lines and lose the
 * tag off the interesting one.
 */
export function logAuditWriteFailure(err: AuditWriteError): void {
  try {
    console.error(
      `${AUDIT_WRITE_FAILURE_TAG} ${JSON.stringify({
        route: err.context.route,
        table: err.table,
        event_type: err.context.eventType,
        session_id: err.context.sessionId,
        client_id: err.context.clientId ?? null,
        fault: err.fault.kind,
        status: err.fault.status,
        pg_code: err.fault.code,
        message: err.fault.message,
        succeeded: err.context.succeeded,
      })}`,
    );
  } catch {
    // JSON.stringify can only fail on an exotic payload. Losing the structure
    // is acceptable; losing the news is not.
    console.error(
      `${AUDIT_WRITE_FAILURE_TAG} table=${err.table} event_type=${err.context.eventType} ` +
        `session_id=${err.context.sessionId} fault=${err.fault.kind} message=${err.fault.message}`,
    );
  }
}

// ===========================================================================
// BOUNDING THE WRITE — why 'timeout' was unreachable, and the two numbers
// ===========================================================================
//
// THE GAP. `recordAuditEvent` was TOTAL but not TERMINATING.
// createServiceRoleClient passes no custom `fetch` and no `signal`, so a write
// inherited undici's own 300s header/body timeout, which is far past any
// Vercel function lifetime. A Supabase that ACCEPTS the connection and then
// never answers — an overloaded PgBouncer, a half-open NAT path, a proxy
// holding the socket — therefore produced NO resolution at all:
// normaliseAuditFault never ran, no [audit-write][WRITE-FAILURE] line was ever
// emitted, and the function simply froze mid-await until the platform killed
// it. Declared fault kind 'timeout' was unreachable in production.
//
// THE BOUND. `.abortSignal()` is defined on PostgrestTransformBuilder
// (PostgrestTransformBuilder.ts:200) and `.insert()` returns a
// PostgrestFilterBuilder, which extends it, so it composes onto the insert.
// An abort RESOLVES rather than rejects (PostgrestBuilder.ts:225 catches it
// like any other fetch failure), landing as status 0 with the message
// 'TimeoutError: The operation was aborted due to timeout' — which is exactly
// what normaliseAuditFault already branches on to produce kind 'timeout'.
//
// TWO NUMBERS, NOT ONE, because the two dispositions want opposite things.

/**
 * LOG-AND-CONTINUE sites (recordAuditRow). SHORT on purpose.
 *
 * The caller is waiting: save-step and submit await this inline before
 * responding, and the session route's after() still holds the function open on
 * Vercel. The row is observability, not user data — every one of these sites
 * has already committed what the user cares about. So the cost of waiting is
 * paid by a real person, while the benefit is a log row we are about to
 * REPLACE with a WRITE-FAILURE line anyway. 2s is comfortably above a healthy
 * Supabase insert (single-digit to low-tens of ms from a Vercel function in
 * the same region) and low enough that a stall is invisible to the user.
 */
export const AUDIT_WRITE_TIMEOUT_MS_DEGRADE = 2_000;

/**
 * FAIL-CLOSED sites (insertAuditRowOrThrow; today, the analyze route).
 *
 * LONGER on purpose, because the failure mode is inverted. Here a timeout is
 * not a lost log line, it is a 503 to a caller whose request would otherwise
 * have succeeded, so a bound that is too tight manufactures outages out of
 * ordinary latency spikes. 5s buys a wide margin over any healthy write while
 * still terminating far inside this route's maxDuration of 300 (analyze/route.ts:57),
 * so the request fails CLOSED with a real 503 instead of freezing.
 *
 * A timeout here is NOT a pass-through: it resolves as a fault like any other,
 * insertAuditRowOrThrow throws AuditWriteError for it, and the analyze route's
 * catch turns that into the same 503 it returns for an RLS refusal.
 */
export const AUDIT_WRITE_TIMEOUT_MS_FAIL_CLOSED = 5_000;

/**
 * The same fail-closed budget, for the READ half of the analyze route's rate
 * limiter. Exported so that read cannot drift away from the write it guards:
 * a stalled count query freezes the identical route just as completely as a
 * stalled insert, and it happens FIRST.
 */
export const AUDIT_READ_TIMEOUT_MS_FAIL_CLOSED = AUDIT_WRITE_TIMEOUT_MS_FAIL_CLOSED;

/**
 * The TABLE-AGNOSTIC CORE. Returns the fault, or null when the row landed.
 * Never throws: both entry points below are built on it, and the total one may
 * not depend on an internal detail staying true.
 *
 * `timeoutMs` is REQUIRED rather than defaulted, so a future third entry point
 * has to state which disposition it is instead of silently inheriting one.
 */
async function attemptAuditWrite(
  spec: AuditWriteSpec,
  timeoutMs: number,
): Promise<AuditFault | null> {
  let supabase: ReturnType<typeof createServiceRoleClient>;
  try {
    supabase = createServiceRoleClient();
  } catch (err) {
    return {
      kind: 'client_init',
      status: null,
      code: null,
      message: boundFaultMessage(err instanceof Error ? err.message : String(err)),
    };
  }

  try {
    const { error, status } = await supabase
      .from(spec.table)
      .insert(spec.row)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    if (!error) return null;
    return normaliseAuditFault(status, error);
  } catch (err) {
    // Unreachable on the documented path (postgrest-js resolves both fault
    // classes, and an abort with them), so this is a floor, not a branch
    // anyone should rely on.
    return {
      kind: 'unknown',
      status: null,
      code: null,
      message: boundFaultMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * ENTRY POINT 1 — for a caller that must FAIL CLOSED.
 *
 * Throws AuditWriteError carrying a normalised fault, including the
 * createServiceRoleClient rejection re-emitted as kind 'client_init'. It does
 * NOT log, because the caller owns both the log line and the response it turns
 * this into.
 */
export async function insertAuditRowOrThrow(spec: AuditWriteSpec): Promise<void> {
  const fault = await attemptAuditWrite(spec, AUDIT_WRITE_TIMEOUT_MS_FAIL_CLOSED);
  if (fault) throw new AuditWriteError(spec, fault);
}

/**
 * ENTRY POINT 2 — for a caller that must DEGRADE.
 *
 * NEVER throws, under any input, including around client construction, and it
 * LOGS INSIDE ITSELF so loudness never depends on the caller remembering to.
 *
 * Deliberately NOT a discriminated result: TypeScript has no `must_use`, so
 * `await recordAuditRow(...)` discarding a returned result would be the
 * original bug moved one frame up.
 */
export async function recordAuditRow(spec: AuditWriteSpec): Promise<void> {
  try {
    const fault = await attemptAuditWrite(spec, AUDIT_WRITE_TIMEOUT_MS_DEGRADE);
    if (fault) logAuditWriteFailure(new AuditWriteError(spec, fault));
  } catch (err) {
    try {
      console.error(
        `${AUDIT_WRITE_FAILURE_TAG} {"table":${JSON.stringify(spec.table)},` +
          `"fault":"unknown","message":${JSON.stringify(
            err instanceof Error ? err.message : String(err),
          )}}`,
      );
    } catch {
      /* a total function stays total even if the console itself is broken */
    }
  }
}

/** Per-call-site metadata the log line needs. Required, so no site ships anonymous. */
export interface AuditEventOptions {
  clientId?: string | null;
  route: string;
  succeeded: string;
}

/** Thin wrapper: the `onboarding_audit_events` row shape (001_initial_schema.sql:56-62). */
function auditEventSpec(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown> | undefined,
  opts: AuditEventOptions,
): AuditWriteSpec {
  return {
    table: 'onboarding_audit_events',
    row: { session_id: sessionId, event_type: eventType, payload: payload ?? null },
    sessionId,
    clientId: opts.clientId ?? null,
    eventType,
    route: opts.route,
    succeeded: opts.succeeded,
  };
}

/**
 * Thin wrapper: the `onboarding_open_events` row shape
 * (008_workbook_tab_tables.sql:80-87). A DIFFERENT table with a DIFFERENT
 * shape, which is exactly why the core above is table-agnostic instead of
 * audit-field-shaped: an audit-shaped primitive would have covered six of
 * seven call sites and left this one silent.
 */
function openEventSpec(
  sessionId: string,
  opts: { userAgent?: string | null; ipHash?: string | null },
  meta: AuditEventOptions,
): AuditWriteSpec {
  return {
    table: 'onboarding_open_events',
    row: {
      session_id: sessionId,
      user_agent: opts.userAgent ?? null,
      ip_hash: opts.ipHash ?? null,
    },
    sessionId,
    clientId: meta.clientId ?? null,
    eventType: 'session_opened',
    route: meta.route,
    succeeded: meta.succeeded,
  };
}

/**
 * Append one row to `onboarding_audit_events`, FAILING CLOSED.
 * Used where those rows ARE application state (the analyze route's rate
 * limiter), so silence would fail the limit OPEN.
 */
export async function insertAuditEventOrThrow(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown> | undefined,
  opts: AuditEventOptions,
): Promise<void> {
  await insertAuditRowOrThrow(auditEventSpec(sessionId, eventType, payload, opts));
}

/**
 * Append one row to `onboarding_audit_events`, DEGRADING. Never throws, and
 * logs its own failure. This replaces the old silent `createAuditEvent`, and
 * the two `safeAudit` wrappers that used to try to catch a rejection
 * postgrest-js never produced.
 */
export async function recordAuditEvent(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown> | undefined,
  opts: AuditEventOptions,
): Promise<void> {
  await recordAuditRow(auditEventSpec(sessionId, eventType, payload, opts));
}

/**
 * Append a row to `onboarding_open_events` (migration 008). One row per
 * resolution of the public token-load route, i.e. per page-load of the
 * client-facing onboarding form once the session is found.
 *
 * DEGRADES, never throws: open-history is a Phase-6.1 modal in the workbook
 * spec, so a missing row degrades the modal and must never reach the caller.
 * Unlike the old `createOpenEvent`, a lost row now leaves a line behind.
 *
 * Both `userAgent` and `ipHash` are nullable in the schema, so pass null (or
 * omit) if the caller cannot compute them.
 */
export async function recordOpenEvent(
  sessionId: string,
  opts: { userAgent?: string | null; ipHash?: string | null },
  meta: AuditEventOptions,
): Promise<void> {
  await recordAuditRow(openEventSpec(sessionId, opts, meta));
}

// Get site intelligence snapshots from session
export async function getSiteIntelligenceSnapshots(sessionId: string): Promise<{
  prefill_map: Record<string, unknown> | null;
  question_overrides: Record<string, unknown> | null;
  branding: Record<string, unknown> | null;
  insights: Record<string, unknown> | null;
} | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('onboarding_sessions')
    .select('si_prefill_snapshot, si_overrides_snapshot, si_branding_snapshot, si_insights_snapshot, site_intelligence_id')
    .eq('id', sessionId)
    .single();

  if (error || !data) return null;

  // Return snapshots if they exist
  if (data.si_prefill_snapshot || data.si_branding_snapshot || data.si_insights_snapshot) {
    return {
      prefill_map: data.si_prefill_snapshot,
      question_overrides: data.si_overrides_snapshot,
      branding: data.si_branding_snapshot,
      insights: data.si_insights_snapshot,
    };
  }

  // If no snapshots but we have a linked record, try to fetch from the record
  if (data.site_intelligence_id) {
    const { data: si } = await supabase
      .from('onboarding_site_intelligence')
      .select('prefill_map, question_overrides, branding, insights')
      .eq('id', data.site_intelligence_id)
      .eq('status', 'completed')
      .single();

    if (si) {
      return {
        prefill_map: si.prefill_map,
        question_overrides: si.question_overrides,
        branding: si.branding,
        insights: si.insights,
      };
    }
  }

  return null;
}

// Generate signed URL for logo
export async function getSignedLogoUrl(logoPath: string): Promise<string | null> {
  if (!logoPath) return null;

  const supabase = createServiceRoleClient();

  const { data, error } = await supabase.storage
    .from('onboarding-logos')
    .createSignedUrl(logoPath, 3600); // 1 hour expiry

  if (error) {
    console.error('Error creating signed URL:', error);
    return null;
  }

  return data.signedUrl;
}
