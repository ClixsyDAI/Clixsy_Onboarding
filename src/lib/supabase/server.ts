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

/**
 * `opts.signal` exists for callers that must FAIL CLOSED on a stall, and it is
 * OPTIONAL for the same reason `getSessionAnswers`' bound is: every other
 * caller is on a request path where a stall is at least visible as a gateway
 * timeout. Passing a signal genuinely CANCELS the underlying request rather
 * than merely stopping the caller waiting, which is why `withDeadline` hands
 * one to its `run` callback — see the note there.
 *
 * The return contract is unchanged (null on any failure), so the caller that
 * needs to tell "no such session" apart from "Supabase never answered" must
 * get that from `withDeadline` rejecting, not from this function.
 */
export async function getSessionByToken(
  token: string,
  opts?: { signal?: AbortSignal },
): Promise<OnboardingSession | null> {
  const supabase = createServiceRoleClient();

  // `.abortSignal` precedes `.single()`, which returns a PostgrestBuilder and
  // does not carry it.
  let query = supabase.from('onboarding_sessions').select('*').eq('token', token);
  if (opts?.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query.single();

  if (error || !data) {
    return null;
  }

  return data as OnboardingSession;
}

/**
 * `opts` exists only for the after()-resident callers, and it is OPTIONAL on
 * purpose. This helper is shared with two REQUEST-path callers (the session
 * and submit routes), where a stall is at least visible: the request hangs and
 * the platform kills it with a gateway timeout an operator can see. On an
 * after() path the 200 has already shipped, so an unbounded read here freezes
 * the callback with nothing emitted anywhere. Passing the bound only from
 * there confines the behaviour change to the paths that need it.
 */
export async function getSessionAnswers(
  sessionId: string,
  opts?: {
    /** Bound the read. Omitted = unbounded, i.e. the request-path behaviour. */
    timeoutMs?: number;
    /** When given, a failure is reported as one tagged, structured line. */
    readFailure?: {
      tag: string;
      route: string;
      eventType: string;
      clientId?: string | null;
      succeeded: string;
    };
  },
): Promise<OnboardingAnswer[]> {
  const supabase = createServiceRoleClient();

  let query = supabase
    .from('onboarding_answers')
    .select('*')
    .eq('session_id', sessionId)
    .order('updated_at', { ascending: true });
  if (typeof opts?.timeoutMs === 'number') {
    query = query.abortSignal(AbortSignal.timeout(opts.timeoutMs));
  }
  const { data, error, status } = await query;

  if (error) {
    const failure = opts?.readFailure;
    if (failure) {
      logSupabaseFailure(
        failure.tag,
        {
          route: failure.route,
          table: 'onboarding_answers',
          eventType: failure.eventType,
          sessionId,
          clientId: failure.clientId ?? null,
          succeeded: failure.succeeded,
        },
        normaliseAuditFault(status, error, 'the answers read was refused with no error body'),
      );
    } else {
      console.error('Error fetching answers:', error);
    }
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
  /**
   * The call ANSWERED, with no error at all, and the answer is unusable: an
   * exact-count query that resolved with `count === null`. There is no
   * PostgREST error to normalise here, so this kind is SYNTHESISED (the same
   * way 'client_init' is) rather than derived from a body. Read-side only.
   */
  | 'null_result'
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
  /**
   * What to say when the fault carries no message of its own. Defaulted rather
   * than required so the write path is unchanged, and parameterised so the
   * READ path can say "the count query" instead of "the write" without
   * needing a second normaliser. A HEAD response is the case that forces this:
   * an HTTP HEAD can carry no body at all, so `error.message` is the EMPTY
   * STRING for every non-2xx answer to the exact-count probe.
   */
  noBodyMessage = 'the write was refused with no error body',
): AuditFault {
  const message = boundFaultMessage(error?.message || noBodyMessage);
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

/**
 * READ-SIDE NORMALISATION, routed through the SAME normaliser.
 *
 * A read has one fault class a write does not: the query ANSWERED, with no
 * error at all, and the answer is unusable. `head: true, count: 'exact'`
 * resolving with `count === null` is the case in production — PostgrestBuilder
 * only assigns `count` when the response carries a parseable `content-range`
 * (PostgrestBuilder.ts:150-155), so a proxy that strips that header yields a
 * null count with `error === null`. There is no PostgREST error document to
 * normalise, so the fault is SYNTHESISED here, exactly as attemptAuditWrite
 * synthesises 'client_init'. EVERY other read fault delegates to
 * normaliseAuditFault, so a timeout is 'timeout', an HTML 502 is 'gateway' and
 * a real refusal is 'postgrest' — on the read side too, and by the same code.
 */
export function normaliseReadFault(
  status: number | null | undefined,
  error: PostgrestErrorLike | null | undefined,
  nullResultMessage: string,
  noBodyMessage: string,
): AuditFault {
  if (error === null || error === undefined) {
    return {
      kind: 'null_result',
      status: typeof status === 'number' ? status : null,
      code: null,
      message: boundFaultMessage(nullResultMessage),
    };
  }
  return normaliseAuditFault(status, error, noBodyMessage);
}

/**
 * NORMALISE A REJECTION.
 *
 * Everything above is written against postgrest-js's RESOLVED-value contract.
 * The calls this file now also has to bound do not honour it: `fetch()`, a
 * gaxios/`node-fetch` Google request and `withDeadline` all REJECT. Without a
 * normaliser of their own each site would invent its own vocabulary, and the
 * `fault` field would stop meaning the same thing across tags — which is
 * exactly the drift that produced the hand-built read-side line.
 *
 * The mapping, and why each spelling is here rather than assumed:
 *   'timeout'   a `DeadlineExceededError` (ours); a `TimeoutError` DOMException
 *               (undici's `AbortSignal.timeout` on the global `fetch`, used by
 *               the dashboard bridge); an `AbortError` (node-fetch 3.3.2's
 *               spelling for the SAME condition — verified empirically against
 *               the installed gaxios 7.1.6 + node-fetch 3.3.2 stack, where a
 *               `transporterOptions.timeout` abort surfaces as a plain Error
 *               named 'Error' whose message is 'The operation was aborted.'
 *               with `code === undefined`). Nothing in this app aborts a
 *               request for any reason OTHER than a deadline, so treating an
 *               abort as a timeout is not a guess.
 *   'transport' a network-layer failure: `TypeError: fetch failed`, or an error
 *               carrying a libuv/undici `code` (ECONNREFUSED, ENOTFOUND,
 *               UND_ERR_*).
 *   'unknown'   anything else, so the kind is never silently wrong.
 *
 * TOTAL, like every other reader in this file: `err` came from a dependency,
 * so its `name`, `message` and `code` are read through guards. An exotic
 * object may not turn a failure report into a second failure.
 */
export function normaliseThrownFault(err: unknown): AuditFault {
  const read = (key: string): unknown => {
    try {
      if (err === null || typeof err !== 'object') return undefined;
      return (err as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  };
  let name = '';
  let message = '';
  try {
    name = typeof read('name') === 'string' ? String(read('name')) : '';
  } catch {
    name = '';
  }
  try {
    message = err instanceof Error ? err.message : String(err);
  } catch {
    message = '<unreadable error>';
  }
  const rawCode = read('code');
  const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : null;
  const bounded = boundFaultMessage(message || 'the call rejected with no message');

  if (err instanceof DeadlineExceededError) {
    return { kind: 'timeout', status: 0, code: DEADLINE_FAULT_CODE, message: bounded };
  }
  if (name === 'TimeoutError' || name === 'AbortError' || /\baborted\b/i.test(message)) {
    return { kind: 'timeout', status: 0, code, message: bounded };
  }
  const causeName = (() => {
    try {
      const cause = read('cause');
      if (cause && typeof cause === 'object') {
        const n = (cause as Record<string, unknown>).name;
        return typeof n === 'string' ? n : '';
      }
    } catch {
      /* a hostile cause getter is not news */
    }
    return '';
  })();
  if (causeName === 'TimeoutError' || causeName === 'AbortError') {
    return { kind: 'timeout', status: 0, code, message: bounded };
  }
  if (
    name === 'TypeError' ||
    /^(E[A-Z]+|UND_ERR_)/.test(code ?? '') ||
    /fetch failed/i.test(message)
  ) {
    return { kind: 'transport', status: 0, code, message: bounded };
  }
  return { kind: 'unknown', status: null, code, message: bounded };
}

/**
 * NORMALISE A NON-2XX HTTP ANSWER from a non-Supabase dependency.
 *
 * Kind 'gateway' rather than a new kind: its documented meaning above is
 * "status >= 400 whose body did NOT come from PostgREST", and a remote
 * service's opaque error body is precisely that. Reusing it keeps the `fault`
 * vocabulary closed, so an operator's grep for one kind keeps working.
 *
 * The body is the ONE field chosen by the remote, so it goes through
 * `boundFaultMessage` like every other message. That is the whole of D6's
 * complaint: the dashboard bridge used to CONCATENATE `body.slice(0, 500)`
 * into a console.error, unescaped, so a newline in the remote's body split the
 * record and stranded the tag on the half without the news.
 */
export function normaliseHttpResponseFault(status: number, body: string): AuditFault {
  return {
    kind: 'gateway',
    status,
    code: null,
    message: boundFaultMessage(body || 'the remote answered with no body'),
  };
}

/**
 * THE TAGS. Four conditions, ONE line shape (see emitFailureLine). A tag is a
 * fixed literal so it is greppable, and the tag is the ONLY thing that differs
 * between them: an operator who has learned to read one has learned to read
 * all four, and a field added to one is added to all four.
 */
export const AUDIT_WRITE_FAILURE_TAG = '[audit-write][WRITE-FAILURE]';
/** An upstream Supabase READ that a code path depends on refused or stalled. */
export const SUPABASE_READ_FAILURE_TAG = '[supabase-read][READ-FAILURE]';
/** A non-audit Supabase WRITE (today: the pm_tracker_pushes seed) failed. */
export const SUPABASE_WRITE_FAILURE_TAG = '[supabase-write][WRITE-FAILURE]';
/** The analyze route could not read its own rate-limit counter. */
export const RATE_LIMIT_READ_FAILURE_TAG = '[rate-limit][READ-FAILURE]';

/**
 * THE OTHER TWO TAGS, and why they are not simply five and six of the above.
 *
 * The four tags share one field set because all four describe a call to ONE
 * dependency against ONE TABLE. The conditions below have no table: an
 * outbound HTTP request has an ENDPOINT, and a bounded background stage has a
 * STAGE NAME. Emitting `"table":"https://workbooks.clixsy.co/api/clients"`
 * would keep the shape identical at the cost of making the field a lie, and a
 * field an operator cannot trust is worse than a second shape they can.
 *
 * So: TWO shapes, ONE bar. Every common field (route, event_type, session_id,
 * client_id, fault, status, message, succeeded) is the same field with the
 * same meaning and the same bound; the subject is `target` instead of `table`,
 * and the code is a transport code rather than a SQLSTATE, so it is `code`
 * instead of `pg_code`. Both shapes go through the same `emitLine` primitive,
 * the same `boundFaultMessage`, the same `AuditFaultKind` vocabulary and the
 * same degraded fallback.
 */
/** An outbound HTTP call this app depends on refused, stalled or was unreachable. */
export const UPSTREAM_HTTP_FAILURE_TAG = '[upstream-http][REQUEST-FAILURE]';
/**
 * A stage this app put a DEADLINE on failed or ran out of time. Covers both
 * the analyze route's upstream reads (request path) and its after()-resident
 * background stages, because the condition is the same one in both places: a
 * bounded stage that did not deliver, named by `target`.
 */
export const BOUNDED_STAGE_FAILURE_TAG = '[bounded-stage][FAILURE]';

/**
 * The field set EVERY failure line carries. Declared once, as a type, so a
 * second tag cannot quietly ship a different shape: that is precisely how the
 * read-side line drifted into hard-coding `fault` and omitting `status`.
 */
interface FailureLineFields {
  route: string;
  table: string;
  event_type: string;
  session_id: string;
  client_id: string | null;
  fault: AuditFaultKind;
  status: number | null;
  pg_code: string | null;
  message: string;
  succeeded: string;
}

/**
 * The field set for the two NON-TABLE conditions. Identical to
 * FailureLineFields except where the subject genuinely differs — see the note
 * at UPSTREAM_HTTP_FAILURE_TAG for why that is two fields rather than a lie in
 * one.
 */
interface UpstreamFailureLineFields {
  route: string;
  /** An endpoint URL, or the name of the bounded stage. */
  target: string;
  event_type: string;
  session_id: string;
  client_id: string | null;
  fault: AuditFaultKind;
  status: number | null;
  /** A transport/deadline code (ECONNREFUSED, DEADLINE_EXCEEDED), never a SQLSTATE. */
  code: string | null;
  message: string;
  succeeded: string;
}

/** Tag, then ONE line of JSON. The single place BOTH shapes are realised. */
function emitLine(tag: string, fields: FailureLineFields | UpstreamFailureLineFields): void {
  console.error(`${tag} ${JSON.stringify(fields)}`);
}

/** Tag, then ONE line of JSON. The single place the shape is realised. */
function emitFailureLine(tag: string, fields: FailureLineFields): void {
  emitLine(tag, fields);
}

/**
 * Read one value that may throw, and hand it back JSON-ENCODED — never raw.
 *
 * ENCODING IS THE POINT, not tidiness. The degraded line below used to
 * CONCATENATE `err.fault.message`, so a message containing a newline split the
 * record in two and stranded the tag on the half without the interesting text
 * — the exact hazard the JSON path is documented to avoid, reintroduced on the
 * fallback path. JSON.stringify escapes the newline, so the record stays one
 * physical line whatever the message contains.
 */
function safeField(read: () => unknown): string {
  let value: unknown;
  try {
    value = read();
  } catch (err) {
    value = `<unreadable: ${err instanceof Error ? err.name : 'throw'}>`;
  }
  try {
    const encoded = JSON.stringify(value ?? null);
    return typeof encoded === 'string' ? encoded : '"<unserialisable>"';
  } catch {
    return '"<unserialisable>"';
  }
}

/**
 * The floor: the complete record could not be built, so print whatever can
 * still be read, one field at a time, each independently guarded and each
 * JSON-ENCODED. Losing the structure is acceptable; losing the news is not,
 * and so is losing the tag off the half of a fragmented line that mattered.
 */
function emitDegradedFailureLine(tag: string, err: AuditWriteError): void {
  try {
    console.error(
      `${tag} {"table":${safeField(() => err.table)},` +
        `"event_type":${safeField(() => err.context.eventType)},` +
        `"session_id":${safeField(() => err.context.sessionId)},` +
        `"fault":${safeField(() => err.fault.kind)},` +
        `"message":${safeField(() => err.fault.message)},` +
        `"degraded":"the full record could not be serialised"}`,
    );
  } catch {
    /* a total function stays total even if the console itself is broken */
  }
}

/**
 * One failure line for a Supabase call that is NOT an audit write: an upstream
 * read a code path depends on, or the pm_tracker_pushes seed. Same shape, same
 * bound (the fault arrives already normalised, and every normaliser above runs
 * boundFaultMessage), different tag.
 */
export function logSupabaseFailure(
  tag: string,
  ctx: {
    route: string;
    table: string;
    /** Logical name of what the call was for, e.g. 'client_lookup'. */
    eventType: string;
    sessionId: string;
    clientId?: string | null;
    succeeded: string;
  },
  fault: AuditFault,
): void {
  try {
    emitFailureLine(tag, {
      route: ctx.route,
      table: ctx.table,
      event_type: ctx.eventType,
      session_id: ctx.sessionId,
      client_id: ctx.clientId ?? null,
      fault: fault.kind,
      status: fault.status,
      pg_code: fault.code,
      message: fault.message,
      succeeded: ctx.succeeded,
    });
  } catch {
    /* the logger is observability; it may never become the fault */
  }
}

/** Everything the non-table line needs. Same required fields as its twin. */
export interface UpstreamFailureContext {
  route: string;
  /** The endpoint that was called, or the name of the bounded stage. */
  target: string;
  /** Logical name of what the call was for, e.g. 'dashboard_client_sync'. */
  eventType: string;
  sessionId: string;
  clientId?: string | null;
  succeeded: string;
}

/**
 * ONE failure line for an outbound HTTP call or a bounded background stage.
 *
 * D6 in one function. The dashboard bridge used to say this with two hand-built
 * console.error lines that CONCATENATED remote text — `body.slice(0, 500)` and
 * a caught `message` — so a newline anywhere in the remote's answer fragmented
 * the record and stranded the tag on the half without the news, which is the
 * exact hazard `emitFailureLine` and `safeField` were written to remove.
 * Routing them here gets them the escaping, the message bound, the normalised
 * fault vocabulary and the `succeeded` field in one move.
 */
export function logUpstreamFailure(
  tag: string,
  ctx: UpstreamFailureContext,
  fault: AuditFault,
): void {
  try {
    emitLine(tag, {
      route: ctx.route,
      target: ctx.target,
      event_type: ctx.eventType,
      session_id: ctx.sessionId,
      client_id: ctx.clientId ?? null,
      fault: fault.kind,
      status: fault.status,
      code: fault.code,
      message: fault.message,
      succeeded: ctx.succeeded,
    });
  } catch {
    // Same floor as the audit line: print what can still be read, each field
    // independently guarded and JSON-ENCODED, never concatenated raw.
    try {
      console.error(
        `${tag} {"target":${safeField(() => ctx.target)},` +
          `"event_type":${safeField(() => ctx.eventType)},` +
          `"session_id":${safeField(() => ctx.sessionId)},` +
          `"fault":${safeField(() => fault.kind)},` +
          `"message":${safeField(() => fault.message)},` +
          `"degraded":"the full record could not be serialised"}`,
      );
    } catch {
      /* the logger is observability; it may never become the fault */
    }
  }
}

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
export function logAuditWriteFailure(
  err: AuditWriteError,
  /**
   * D4 — `succeeded` CAN BE FAULT-DEPENDENT, and on one path it must be.
   *
   * The sentence is chosen by the CALL SITE, before the call, so it cannot
   * know how the write failed. That is fine everywhere the sentence is a
   * fact about work already committed ("the answers are saved"), and wrong
   * on the analyze route, where it asserts a NEGATIVE about the write that
   * just failed: "nothing was started". On kind 'timeout' that can be false,
   * because aborting does not roll back an INSERT PostgREST may already have
   * committed (see the abort site in attemptAuditWrite).
   *
   * An override rather than a callback on AuditWriteContext, so the six sites
   * whose sentence is fault-independent stay exactly as they are and the one
   * that needs it states so at the point it decides.
   */
  succeededOverride?: string,
): void {
  try {
    emitFailureLine(AUDIT_WRITE_FAILURE_TAG, {
      route: err.context.route,
      table: err.table,
      event_type: err.context.eventType,
      session_id: err.context.sessionId,
      client_id: err.context.clientId ?? null,
      fault: err.fault.kind,
      status: err.fault.status,
      pg_code: err.fault.code,
      message: err.fault.message,
      succeeded: succeededOverride ?? err.context.succeeded,
    });
  } catch {
    // Either JSON.stringify refused an exotic payload, or reading one of the
    // fields threw (a hostile getter on `err`). Fall through to the degraded
    // line, which reads each field independently and ENCODES every one of
    // them — the previous version concatenated `err.fault.message` raw, so a
    // newline in it fragmented the record and lost the tag off the
    // interesting half.
    emitDegradedFailureLine(AUDIT_WRITE_FAILURE_TAG, err);
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
 * THE GENERALISATION. Bounding the audit WRITE was necessary and not
 * sufficient, because on both after()-resident paths an UNBOUNDED Supabase
 * READ sits immediately UPSTREAM of it, on the same code path, inside the same
 * callback.
 *
 * Under a Supabase that accepts the connection and never answers, that read
 * never settles, so the audit write is NEVER ISSUED, logAuditWriteFailure
 * never runs, and the operator gets literally zero output. Measured against
 * the previous revision: 10s elapsed, the promise never settled, the stub saw
 * exactly ONE request (the clients GET) and zero POSTs to
 * onboarding_audit_events, and the captured operator output was empty. The 200
 * has already shipped by then, so nothing anywhere notices.
 *
 * THE PRINCIPLE, stated once and repeated at each site: reading `.error` is
 * NECESSARY BUT NOT SUFFICIENT, because a call that never settles has no
 * `.error` to read. Every Supabase call on an after() path must be bounded as
 * well as checked.
 *
 * 5s, not the 2s degrade bound: these calls gather the data the callback
 * exists to deliver rather than a log row, so a bound that is too tight throws
 * away real work on an ordinary latency spike. It is still an order of
 * magnitude under the dashboard bridge's own 15s HTTP bound, so the whole
 * callback terminates well inside any after() budget.
 */
export const SUPABASE_READ_TIMEOUT_MS_AFTER = 5_000;

// ===========================================================================
// THE GENERAL CLOSE — bounding a call that takes no signal of its own
// ===========================================================================
//
// Every bound above threads a real `AbortSignal` into the call, which is
// strictly the better tool: it stops us waiting AND releases the socket. It is
// only available where the callee accepts one. The same failure shape keeps
// reappearing one layer further out at calls that do not:
//
//   - the analyze route's `getSessionByToken` / `resolveSessionAccess` /
//     `findReusableScan`, all UPSTREAM of the fail-closed 503, so a stall
//     froze the handler before the bounded counter read was ever reached and
//     the route neither failed closed nor reported anything;
//   - that route's own after() callback, which held `runSiteAnalysis`,
//     `getSiteIntelligence` and `linkSiteIntelligenceToSession` with NO
//     failure-reporting write at all;
//   - sheet-export's four Google HTTP calls, upstream of its own
//     `sheet_export_failed` audit write on the same after() path.
//
// So the rule is stated once, as a primitive, rather than re-derived per site:
// AN AWAIT UPSTREAM OF A FAILURE-REPORTING WRITE MUST HAVE A DEADLINE. Where
// the callee takes a signal, `withDeadline` hands it one and the work is
// genuinely CANCELLED. Where it does not, the deadline still fires and the
// CALLER terminates with a normalisable rejection — which is the half that
// makes the report possible at all.
//
// THE HONEST LIMIT, named here rather than discovered later: for a callee that
// takes no signal the losing promise is ABANDONED, not cancelled. It may still
// be running, and it may still complete its side effects, exactly as
// `attemptAuditWrite`'s abort does not roll back an INSERT PostgREST may
// already have committed. Abandoning is not free and it is not pretended to
// be; it is strictly better than an await that never settles, because a
// process that has given up can say so and one that is frozen cannot.

/** The code the fault line carries when OUR deadline, not the peer, ended it. */
export const DEADLINE_FAULT_CODE = 'DEADLINE_EXCEEDED';

export class DeadlineExceededError extends Error {
  /** The stage that ran out of time, as it appears in the failure line's `target`. */
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} did not settle within ${timeoutMs}ms`);
    this.name = 'DeadlineExceededError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `run` under a wall-clock deadline. Rejects with DeadlineExceededError if
 * it has not settled in `timeoutMs`, and aborts the signal it handed in so a
 * signal-aware callee is cancelled rather than merely abandoned.
 *
 * THREE DETAILS THAT ARE NOT DECORATION:
 *
 *   1. The loser gets a `.catch`. A `Promise.race` leaves the loser's eventual
 *      rejection UNHANDLED, and an unhandled rejection terminates a Node
 *      process by default — so the naive version of this function turns a
 *      bounded stall into a crash, which is a worse outcome than the hang it
 *      replaces.
 *   2. The timer is cleared AND unref'd. A pending `setTimeout` keeps the
 *      event loop alive; a deadline that outlives the work it bounded would
 *      hold a serverless invocation open for exactly as long as the bound.
 *   3. `run` is invoked inside a try. A callee that throws SYNCHRONOUSLY (an
 *      env guard, a bad argument) would otherwise escape past the deadline's
 *      own cleanup and leak the timer.
 */
export function withDeadline<T>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  let work: Promise<T>;
  try {
    work = Promise.resolve(run(controller.signal));
  } catch (err) {
    return Promise.reject(err);
  }
  // Detail 1. This handler exists ONLY to keep an abandoned rejection from
  // becoming an unhandled one; the race below still observes the real result.
  work.catch(() => {});

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // REJECT FIRST, THEN ABORT. Aborting can cause `work` to settle, and a
      // callee that swallows its own abort (getSessionByToken returns null on
      // any error) would then RESOLVE — turning "Supabase never answered" into
      // "no such session", i.e. a 404 where the route must fail closed. The
      // race is settled before the abort can produce that, so the outcome is
      // deterministic rather than a microtask ordering accident.
      reject(new DeadlineExceededError(label, timeoutMs));
      controller.abort();
    }, timeoutMs);
    // Detail 2.
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  return Promise.race([work, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * The deadline for the analyze route's three UPSTREAM reads. The same
 * fail-closed budget as the counter read they sit in front of, because they
 * freeze the identical handler just as completely and they happen FIRST — the
 * same argument that made AUDIT_READ_TIMEOUT_MS_FAIL_CLOSED an alias rather
 * than a second number.
 */
export const UPSTREAM_READ_TIMEOUT_MS_FAIL_CLOSED = AUDIT_READ_TIMEOUT_MS_FAIL_CLOSED;

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
    // THE ABORT SITE. Aborting stops US waiting; it does NOT roll back an
    // INSERT that PostgREST may already have COMMITTED server-side. The
    // request is fire-and-forget from the abort onward, so the row can land
    // after we have given up on it.
    //
    // THE CONSEQUENCE, NAMED SO THE NEXT READER FINDS IT. On the fail-closed
    // path (the analyze route's rate limiter) a Supabase that is SLOW BUT
    // WORKING therefore spends a rate-limit slot per attempt while returning
    // 503, so a client retrying can burn all five hourly slots and then be
    // 429'd once Supabase recovers.
    //
    // This is DELIBERATELY NOT FIXED. It follows directly from the ruled
    // fail-closed decision: those rows ARE the limiter's state, so the only
    // alternatives are to fail the limit OPEN on the one route that spends
    // Anthropic tokens, or to invent a compensating delete that would itself
    // need to succeed against the same degraded Supabase. Recorded as a
    // decision, not a defect.
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
 * THE CLAIM IS ABOUT THE WHOLE ENTRY POINT, wrappers included, and that had to
 * be MADE true rather than merely asserted. `recordAuditRow` itself was total,
 * but the two spec builders it is reached through (auditEventSpec,
 * openEventSpec) dereferenced `opts.clientId` / `meta.clientId` OUTSIDE this
 * try — a spec argument is EVALUATED BEFORE the call it is passed to — so a
 * caller handing in a null or hostile options object got a raw TypeError out
 * of a frame that promised not to throw. Those builders are now total in their
 * own right (see readOpt/optText/optClientId below), so the claim above holds
 * for every public entry point in this section, not just for this function.
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
      // Every value ENCODED, never concatenated: `spec` reached us from a
      // caller, so neither its fields nor the error's message are ours to
      // trust with the line's structure.
      console.error(
        `${AUDIT_WRITE_FAILURE_TAG} {"table":${safeField(() => spec.table)},` +
          `"fault":"unknown","message":${safeField(() =>
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

/**
 * TOTAL PROPERTY READS — why the spec builders below do not simply use dots.
 *
 * These builders run OUTSIDE recordAuditRow's try: a spec argument is
 * evaluated before the call it is passed to. So `opts.clientId` on a null
 * `opts` threw a raw TypeError from a frame documented as never throwing, and
 * a throwing getter did the same from a frame that looked safe. The types say
 * this cannot happen; the types are not present at runtime, the options object
 * reaches here from six call sites, and the whole point of this section is
 * that the audit path stays loud when everything else is broken.
 *
 * Guarded against all three shapes at once: a null/undefined object, a
 * non-object, and a property whose getter throws.
 */
function readOpt(opts: unknown, key: string): unknown {
  if (opts === null || opts === undefined) return undefined;
  if (typeof opts !== 'object' && typeof opts !== 'function') return undefined;
  try {
    return (opts as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * A required text field. The fallback is DESCRIPTIVE rather than empty: this
 * value ends up in the failure line's `route` / `succeeded`, and a blank there
 * is indistinguishable from a site that shipped anonymous.
 */
function optText(opts: unknown, key: string, fallback: string): string {
  const value = readOpt(opts, key);
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

/** A nullable text field: absent, unreadable and null all collapse to null. */
function optNullableText(opts: unknown, key: string): string | null {
  const value = readOpt(opts, key);
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  try {
    return String(value);
  } catch {
    return null;
  }
}

const HOSTILE_OPTS_ROUTE = '(route unknown: the call site passed no usable options object)';
const HOSTILE_OPTS_SUCCEEDED =
  '(unknown: the call site passed no usable options object, so what else survived cannot be stated here)';

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
    clientId: optNullableText(opts, 'clientId'),
    eventType,
    route: optText(opts, 'route', HOSTILE_OPTS_ROUTE),
    succeeded: optText(opts, 'succeeded', HOSTILE_OPTS_SUCCEEDED),
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
  // Total in its own right, for the same reason auditEventSpec is: BOTH
  // objects arrive from the caller and BOTH were dereferenced outside
  // recordAuditRow's try.
  return {
    table: 'onboarding_open_events',
    row: {
      session_id: sessionId,
      user_agent: optNullableText(opts, 'userAgent'),
      ip_hash: optNullableText(opts, 'ipHash'),
    },
    sessionId,
    clientId: optNullableText(meta, 'clientId'),
    eventType: 'session_opened',
    route: optText(meta, 'route', HOSTILE_OPTS_ROUTE),
    succeeded: optText(meta, 'succeeded', HOSTILE_OPTS_SUCCEEDED),
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
