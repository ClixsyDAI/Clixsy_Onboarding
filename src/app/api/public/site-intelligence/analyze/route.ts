// =============================================================
// POST /api/public/site-intelligence/analyze
// =============================================================
//
// Client-facing trigger for the website-intelligence analyzer.
// Mirrors the /api/admin/site-intelligence/analyze flow but with
// public auth (token + PIN-cookie via checkSessionGuard) instead
// of admin-cookie auth. Allows a client filling the wizard to
// kick off the same analyze pipeline the admin /new flow uses,
// so cron-created sessions (Phase 3) can pre-fill subsequent
// steps based on the client's own website.
//
// Auth shape mirrors /api/public/onboarding/submit:
//   1. Token must resolve to a real session row.
//   2. checkSessionGuard validates the PIN-cookie state — the PIN
//      is verified once via the separate verify-pin flow, which
//      sets a cookie; subsequent public calls just need a valid
//      cookie for THIS session id.
//
// Behaviour:
//   - Idempotent on (session_id, normalized URL): if the session
//     already has a completed analysis for the same URL, return
//     the existing recordId immediately with reused=true.
//   - Per-session rate limit: 5 analyses per rolling hour, tracked
//     via onboarding_audit_events rows of type
//     'site_intelligence_analyze_requested'. Each public call
//     writes one audit event before kicking the analyzer off, so
//     attempts AND completions both count.
//   - Re-analyze flow: when the URL differs from the existing
//     linked record, create a new analysis and update the session's
//     site_intelligence_id to point at it on completion.

import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { isSiteIntelligenceEnabled } from '@/lib/siteIntelligence/config';
import {
  createSiteIntelligenceRecord,
  runSiteAnalysis,
  linkSiteIntelligenceToSession,
  getSiteIntelligence,
  findReusableScan,
  attachPendingScanToSession,
} from '@/lib/siteIntelligence/analyze';
import {
  getSessionByToken,
  createServiceRoleClient,
  insertAuditEventOrThrow,
  logAuditWriteFailure,
  logSupabaseFailure,
  logUpstreamFailure,
  normaliseReadFault,
  normaliseThrownFault,
  withDeadline,
  AuditWriteError,
  AUDIT_READ_TIMEOUT_MS_FAIL_CLOSED,
  BOUNDED_STAGE_FAILURE_TAG,
  RATE_LIMIT_READ_FAILURE_TAG,
  UPSTREAM_READ_TIMEOUT_MS_FAIL_CLOSED,
} from '@/lib/supabase/server';
import { resolveSessionAccess } from '@/lib/onboarding/session-guard';
import { isLikelyUrl } from '@/lib/onboarding/url-shape';

// Same Vercel platform max as the admin route — see the comment in
// src/app/api/admin/site-intelligence/analyze/route.ts for the
// historical-runtime rationale.
export const maxDuration = 300;

const RATE_LIMIT_PER_HOUR = 5;

const ANALYZE_ROUTE = 'POST /api/public/site-intelligence/analyze';

/**
 * THE LIMITER's code, and it now means ONLY the limiter.
 *
 * It used to be the one code for every precondition on this route, on the
 * argument that a caller wants the same handling either way. The argument
 * survives; the WORDING did not. `session_lookup`, `session_access` and
 * `reusable_scan_lookup` are not the rate limiter, and the body attached to
 * this code says "We could not check your analysis limit just now", which is a
 * sentence that is FALSE for all three of them — it sends an operator reading
 * a support ticket to the limiter, and it tells a client their limit is in
 * doubt when the truth is that we could not load their session at all.
 *
 * So: two codes, split by whether the LIMITER is the thing that could not be
 * established. Both still mean "retry in a few minutes" and both are still
 * 503, so a caller that branches on either one keeps working; the difference
 * is that each sentence is now true of the condition that produced it.
 */
const UNAVAILABLE_CODE = 'rate_limit_state_unavailable';

/**
 * The code for the preconditions that are NOT the limiter: the session lookup,
 * the PIN/bypass access decision and the reusable-scan (dedup) lookup. Named
 * for what they are — the things that must hold before an analysis can be
 * considered at all.
 */
const PRECONDITION_UNAVAILABLE_CODE = 'analyze_precondition_unavailable';

/**
 * AUD-1. The code for an UNEXPECTED failure anywhere else in the handler.
 *
 * Everything above is a condition this route anticipated. This one is the
 * `catch` at the bottom, which used to answer an opaque 500 with no code, no
 * tag, no session id and a multi-line `console.error(..., error)` — the single
 * untagged emit left in the whole change, and the one an operator reaches
 * exactly when they have the least to go on.
 */
const HANDLER_FAILED_CODE = 'analyze_request_failed';

/**
 * Nothing had been started at the point the upstream reads run: no analysis
 * record exists, no Anthropic call has been made, no rate-limit row has been
 * written. Unlike the WRITE-side wording below, this sentence is true for
 * EVERY fault kind including 'timeout', because no INSERT has been issued yet
 * for PostgREST to have committed behind our back.
 */
const UPSTREAM_SUCCEEDED = 'nothing was started: no analysis record, no Anthropic spend';

/**
 * D4. The WRITE-side `succeeded` sentence cannot be a constant, because on a
 * TIMEOUT it would be FALSE.
 *
 * `attemptAuditWrite` documents the reason at its abort site: aborting stops
 * US waiting, it does NOT roll back an INSERT that PostgREST may already have
 * COMMITTED server-side. So on kind 'timeout' the rate-limit row — which IS
 * this route's limiter state — may or may not exist. Telling an operator
 * "nothing was started" there is the one sentence in the whole line that could
 * send them to the wrong conclusion: they would read a 503 as a no-op and tell
 * a client to retry freely, while each attempt may in fact be spending one of
 * five hourly slots.
 *
 * Every OTHER fault kind is genuinely a no-op: 'client_init' never reached the
 * network, and 'postgrest' / 'gateway' / 'transport' all carry a definite
 * refusal from a layer that answered.
 */
function writeSucceededFor(kind: string): string {
  if (kind === 'timeout') {
    return (
      'no analysis was started and no Anthropic spend was incurred, but the rate-limit row is UNCERTAIN: ' +
      'the insert was aborted at our deadline, which does not roll back a row PostgREST may already have ' +
      'committed, so this attempt may or may not have spent one of the hourly slots'
    );
  }
  return 'nothing was started: no analysis record, no Anthropic spend';
}

/**
 * How long the analyze route's own after() callback may spend on the analysis
 * stage. The route declares maxDuration = 300, so this terminates and REPORTS
 * inside the platform's own window instead of being killed mid-await with only
 * a console.error to show for it. It is deliberately generous: a real scan
 * runs providers and an Anthropic call, and a bound that is too tight would
 * throw away paid work on an ordinary latency spike.
 *
 * WHAT IT COVERS THAT NOTHING ELSE DOES, stated plainly: runSiteAnalysis holds
 * three DISCARDED-RESULT WRITES that are annotated as out of scope and are NOT
 * changed here. Their error handling is untouched. This deadline bounds the
 * WAITING on them, which is not the same thing — without it, a stall on any of
 * the three still freezes the callback with nothing said.
 */
const SITE_ANALYSIS_DEADLINE_MS = 240_000;

/** Normalize a URL for idempotency comparison. */
function normalizeUrl(url: string): string {
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = 'https://' + u;
  }
  return u.replace(/\/+$/, '').toLowerCase();
}

/**
 * THE LOG AND THE ANSWER ARE TWO DECISIONS — the same split D5 already made
 * for the limiter read, applied to the three upstream stages.
 *
 * They used to be ONE function that logged and then unconditionally 503'd, and
 * that fused two rules together. ALWAYS LOG: a degraded Supabase is degraded
 * for everyone, and an AM's analyze click is often the earliest evidence a
 * session ever gets. The ANSWER is a separate question, and at
 * `reusable_scan_lookup` it has a separate answer — see the call site.
 */
function reportUpstreamStageFailure(
  stage: string,
  target: string,
  sessionId: string | null,
  err: unknown,
): void {
  logUpstreamFailure(
    BOUNDED_STAGE_FAILURE_TAG,
    {
      route: ANALYZE_ROUTE,
      target: `${stage} (${target})`,
      eventType: 'analyze_upstream_read',
      sessionId: sessionId ?? '',
      clientId: null,
      succeeded: UPSTREAM_SUCCEEDED,
    },
    normaliseThrownFault(err),
  );
}

/**
 * The 503 for a precondition that could not be established.
 *
 * AUD-5(a). The sentence no longer mentions the analysis limit, because none
 * of the three stages this answers for IS the limit: one loads the session,
 * one decides access, one looks for a scan to reuse. The limiter's own 503
 * keeps its own sentence and its own code, below.
 */
function preconditionUnavailable(): NextResponse {
  return NextResponse.json(
    {
      error:
        'We could not start your website analysis just now. Please try again in a few minutes.',
      code: PRECONDITION_UNAVAILABLE_CODE,
    },
    { status: 503 },
  );
}

export async function POST(request: NextRequest) {
  // AUD-1. Two facts the TERMINAL CATCH needs and could not previously have,
  // because both were block-scoped inside the try: WHICH session this was, and
  // whether a rate-limit slot had already been spent by the time it failed.
  //
  // The second is the one that matters. Once the fail-closed audit write
  // SUCCEEDS, one of the client's five hourly attempts is gone. Every failure
  // after that point fell into an opaque 500 that said nothing about it, so an
  // operator (and the client) read a retry as free when it was not.
  let handlerSessionId: string | null = null;
  let handlerClientId: string | null = null;
  let rateLimitSlotSpent = false;
  try {
    if (!isSiteIntelligenceEnabled()) {
      return NextResponse.json(
        { error: 'Site intelligence is disabled' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { token, websiteUrl } = body;

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }
    if (!websiteUrl || typeof websiteUrl !== 'string') {
      return NextResponse.json(
        { error: 'websiteUrl is required' },
        { status: 400 }
      );
    }
    // URL-shape guard: reject junk before spending a scan. A real
    // website always has a dotted host; "N/A"/"tbd"/bare words don't.
    if (!isLikelyUrl(websiteUrl)) {
      return NextResponse.json(
        { error: 'Please enter a valid website URL (e.g. example.com).' },
        { status: 400 }
      );
    }

    // Auth: session lookup + PIN guard. Sprint 2 / #4: a valid AM-bypass
    // signature skips the PIN gate — running the scan to pre-fill the
    // form is the core reason the AM link exists. The analyze-requested
    // audit below is suppressed under bypass so the AM's prep doesn't
    // register as client activity (zero-tracking invariant).
    //
    // D2 — THE FAIL-CLOSED 503 WAS ITSELF GUARDED BY UNBOUNDED READS.
    //
    // The counter read below is bounded and fails closed. The three awaits in
    // FRONT of it were not, and they run FIRST: `getSessionByToken`,
    // `resolveSessionAccess` and `findReusableScan`. Under a PostgREST that
    // accepts the connection and never answers, the handler froze on the first
    // of them — so the route neither failed closed nor reported anything, and
    // the bounded counter read was never reached at all. Bounding the thing
    // downstream of a hang is worth nothing.
    //
    // Each is wrapped in `withDeadline`, which does two things a bare race
    // does not: it hands the callee an AbortSignal, so the Supabase read is
    // genuinely CANCELLED rather than abandoned, and it rejects with a
    // DeadlineExceededError that `normaliseThrownFault` turns into the same
    // fault vocabulary as every other line.
    //
    // A stall must produce the SAME 503 as any other fault on this route:
    // "we could not establish whether you may run this" is one answer however
    // the establishing failed.
    //
    // `resolveSessionAccess` is wrapped too even though today it touches no
    // network (cookies + an HMAC). The rule is about the SHAPE — an unbounded
    // await upstream of a failure-reporting write — not about which awaits
    // happen to be I/O this month, and a future PIN-state read inside it would
    // otherwise reopen the hole silently.
    let session: Awaited<ReturnType<typeof getSessionByToken>>;
    let access: Awaited<ReturnType<typeof resolveSessionAccess>>;
    let reuse: Awaited<ReturnType<typeof findReusableScan>>;
    try {
      session = await withDeadline('session_lookup', UPSTREAM_READ_TIMEOUT_MS_FAIL_CLOSED, (signal) =>
        getSessionByToken(token, { signal }),
      );
    } catch (err) {
      reportUpstreamStageFailure('session_lookup', 'onboarding_sessions', null, err);
      return preconditionUnavailable();
    }
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    handlerSessionId = session.id;
    handlerClientId = session.client_id;
    try {
      access = await withDeadline('session_access', UPSTREAM_READ_TIMEOUT_MS_FAIL_CLOSED, () =>
        resolveSessionAccess(session!, request),
      );
    } catch (err) {
      // No bypass scoping here, and that is not an oversight: this stage is the
      // one that DECIDES whether the caller is an AM. There is no bypass state
      // to scope by until it answers, so it fails closed for everyone.
      reportUpstreamStageFailure(
        'session_access',
        'pin-cookie + am-bypass guard',
        session.id,
        err,
      );
      return preconditionUnavailable();
    }
    if (access.kind === 'locked') {
      return NextResponse.json(
        { error: 'Session is locked. Contact your Clixsy account manager.' },
        { status: access.lock === 'permanent' ? 423 : 429 }
      );
    }
    if (access.kind === 'needs_pin') {
      return NextResponse.json(
        { error: 'PIN verification required' },
        { status: 401 }
      );
    }
    const isAmBypass = access.isAmBypass;

    const normalizedUrl = normalizeUrl(websiteUrl);

    // Idempotency / dedup: if the session already has a scan for the
    // same URL that's reusable — completed (return it) OR still in-flight
    // (queued/running, attach/resume) — don't pay for a second one. This
    // is what stops a GHL-webhook auto-scan and a later AM "Analyze my
    // site" click from double-charging: the AM's click finds the
    // in-flight auto-scan and the wizard just resumes polling it.
    const priorLinkedId = session.site_intelligence_id ?? null;
    try {
      reuse = await withDeadline('reusable_scan_lookup', UPSTREAM_READ_TIMEOUT_MS_FAIL_CLOSED, (signal) =>
        findReusableScan(priorLinkedId, websiteUrl, { signal }),
      );
    } catch (err) {
      // AUD-5(b) — A DISPOSITION VIOLATION, FIXED BY SCOPING RATHER THAN BY
      // SILENCE.
      //
      // The ruling on this route is that an AM-bypass caller is never refused
      // over limiter state they are exempt from. This stage 503'd them anyway,
      // and did it under the LIMITER's own machine code, so an AM whose dedup
      // lookup stalled was told their analysis limit was in doubt when they
      // have no limit at all.
      //
      // The fix is the same shape D5 used for the counter read: ALWAYS LOG,
      // 503 only when the caller is actually subject to this route's gating.
      // For a bypass caller the lookup is pure DEDUP — it only ever saves a
      // scan — so losing it costs one duplicate scan on a click the AM made
      // deliberately, which is strictly better than refusing them. The line
      // above records that it happened, so the duplicate is explicable rather
      // than mysterious.
      reportUpstreamStageFailure(
        'reusable_scan_lookup',
        'onboarding_site_intelligence',
        session.id,
        err,
      );
      if (!isAmBypass) return preconditionUnavailable();
      reuse = null;
    }
    if (reuse) {
      return NextResponse.json({
        success: true,
        recordId: reuse.recordId,
        status: reuse.status,
        reused: true,
      });
    }

    // Rate limit: count prior analyze-requested audit events for
    // this session within the past rolling hour. The count is
    // incremented BEFORE the analyzer runs (one audit row per
    // request), so a session that gets 5 quick clicks gets blocked
    // even before any analysis completes.
    const supabase = createServiceRoleClient();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    //
    // BOUNDED, for the same reason the write is (see server.ts,
    // AUDIT_READ_TIMEOUT_MS_FAIL_CLOSED). Nothing upstream bounds a Supabase
    // request on a useful horizon, so a PostgREST that accepts the connection
    // and never answers froze this handler here — BEFORE the write, before any
    // log line, and with no 503 ever reaching the caller. An abort resolves as
    // `{ count: null, error: { message: 'TimeoutError: ...' }, status: 0 }`,
    // which is `countErr !== null` and therefore already lands in the
    // fail-closed branch below. A stall is now a 503, not a freeze.
    const { count, error: countErr, status: countStatus } = await supabase
      .from('onboarding_audit_events')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', session.id)
      .eq('event_type', 'site_intelligence_analyze_requested')
      .gte('created_at', oneHourAgo)
      .abortSignal(AbortSignal.timeout(AUDIT_READ_TIMEOUT_MS_FAIL_CLOSED));

    // FAIL CLOSED ON THE READ TOO. `if (!countErr && ...)` skipped the limit
    // entirely whenever the count query errored — the same degraded Supabase
    // that loses the write, so fixing only the write would leave the bigger
    // hole open. A `count` of null when a count WAS requested is the same
    // condition wearing a different face.
    //
    // Scoped to the non-bypass branch on purpose: an AM-bypass caller is never
    // counted (the write below is suppressed for them), so an unknown counter
    // cannot fail an AM's limit open and must not 503 them.
    const rateLimitStateUnknown = countErr !== null || count === null;
    //
    // D5 — THE LOG AND THE 503 ARE TWO DECISIONS, NOT ONE.
    //
    // Both used to sit inside `if (rateLimitStateUnknown && !isAmBypass)`, so
    // under AM bypass a failed or STALLED counter read was COMPLETELY SILENT:
    // no line, no status, no trace anywhere. The ruling scoped the 503 to the
    // non-bypass branch — an AM is never counted, so an unknown counter cannot
    // fail their limit open and must not 503 them — and it said nothing about
    // the log. Silence was an accident of where the braces fell.
    //
    // A degraded Supabase is degraded for everyone. An AM's analyze click is
    // often the FIRST thing that touches a session, so it is frequently the
    // earliest evidence available; throwing it away because the caller happens
    // to be exempt from the limiter is throwing away the news, not the policy.
    // So: ALWAYS log, 503 only when not bypassed.
    if (rateLimitStateUnknown) {
      // ONE SHAPE FOR BOTH HALVES OF THE LIMITER. This line used to be built
      // by hand: it hard-coded `fault: countErr ? 'postgrest' : 'null_count'`,
      // carried no HTTP status at all, and applied neither the fault
      // normaliser nor the message bound. Two of those were wrong rather than
      // merely thin — a STALLED count read (kind 'timeout', status 0) and a
      // proxy's HTML 502 (kind 'gateway') were both reported as 'postgrest',
      // sending an operator to hunt a Postgres refusal that never happened,
      // and an unbounded gateway body could push the actionable half of the
      // line off the screen. It now goes through the same normaliser, the same
      // bound and the same emitter as the write-side line below.
      //
      // ONE HONEST CAVEAT, since this is a `head: true` probe: an HTTP HEAD
      // can carry NO BODY, so the postgrest-vs-gateway discriminator (the
      // presence of a code/details/hint triple) degenerates and any non-2xx
      // answer to THIS query reads as 'gateway'. The `status` field, which the
      // old line omitted entirely, is what carries the information there.
      logSupabaseFailure(
        RATE_LIMIT_READ_FAILURE_TAG,
        {
          route: ANALYZE_ROUTE,
          table: 'onboarding_audit_events',
          eventType: 'site_intelligence_analyze_requested',
          sessionId: session.id,
          clientId: session.client_id,
          // TRUE FOR EVERY FAULT KIND on the READ side, timeout included: an
          // aborted exact-count HEAD writes nothing, so unlike the write-side
          // sentence below this one needs no fault-awareness.
          succeeded: UPSTREAM_SUCCEEDED,
        },
        normaliseReadFault(
          countStatus,
          countErr,
          'the count query answered with a null count where an exact count was requested',
          'the count query was refused with no error body (an HTTP HEAD carries none)'
        )
      );
      // The 503, and ONLY the 503, is scoped to the non-bypass branch.
      if (!isAmBypass) {
        return NextResponse.json(
          {
            error:
              'We could not check your analysis limit just now. Please try again in a few minutes.',
            code: UNAVAILABLE_CODE,
          },
          { status: 503 }
        );
      }
    }

    if (!rateLimitStateUnknown && (count ?? 0) >= RATE_LIMIT_PER_HOUR) {
      return NextResponse.json(
        {
          error: `Rate limit exceeded. You can run up to ${RATE_LIMIT_PER_HOUR} analyses per hour. Please wait before trying again.`,
        },
        { status: 429 }
      );
    }

    // Record the attempt up-front so it counts toward the rate
    // limit even if the analyzer later fails. Audit payload notes
    // the via-channel so a future analytics query can distinguish
    // admin /new triggers from public wizard triggers.
    // Sprint 2 / #4: suppressed under AM bypass — this is a tracking
    // write (and the rate-limit counter), so an AM-run scan neither
    // logs as client activity nor counts against the client's hourly
    // limit. The rate-limit CHECK above still runs (protects against a
    // real-client flood); AM runs simply aren't recorded.
    //
    // FAIL CLOSED. This row is not bookkeeping here: it IS the rate limiter's
    // state, counted by the exact-count query above. A silent loss therefore
    // fails the limit OPEN on the one route in this app that spends Anthropic
    // tokens, so a degraded Supabase would turn the 5-per-hour cap into no cap
    // at all. The accepted consequence, stated plainly: this route errors while
    // Supabase is degraded. Nothing is stranded by returning here, because
    // createSiteIntelligenceRecord, attachPendingScanToSession and the
    // Anthropic spend inside after() are ALL still below this point.
    if (!isAmBypass) {
      try {
        await insertAuditEventOrThrow(
          session.id,
          'site_intelligence_analyze_requested',
          {
            website_url: normalizedUrl,
            via: 'public_wizard_step_1',
          },
          {
            clientId: session.client_id,
            route: ANALYZE_ROUTE,
            // The DEFAULT sentence. True for every fault kind except
            // 'timeout', which the catch below overrides — see writeSucceededFor.
            succeeded: UPSTREAM_SUCCEEDED,
          }
        );
        // AUD-1. THE SLOT IS NOW SPENT. Everything below this line runs with
        // one of the client's five hourly attempts already consumed, and the
        // terminal catch has to be able to say so.
        rateLimitSlotSpent = true;
      } catch (err) {
        // Caught HERE, above the generic catch below, which would flatten
        // this into an opaque 500 and lose the machine-readable reason.
        //
        // A TIMEOUT IS NOT A PASS-THROUGH. The insert is bounded by
        // AUDIT_WRITE_TIMEOUT_MS_FAIL_CLOSED, and an abort arrives as an
        // ordinary fault (kind 'timeout', status 0) inside the same
        // AuditWriteError as an RLS refusal — so it takes this identical 503
        // branch. There is deliberately no `if (fault.kind === 'timeout')`
        // escape hatch: "we could not tell whether you are over your limit"
        // is the same answer whichever way Supabase failed to say so.
        if (err instanceof AuditWriteError) {
          // D4. The `succeeded` sentence handed to the write below asserts
          // "nothing was started", which is a claim about THIS write's effect
          // and is not true for every way it can fail. On a timeout the row
          // may already be committed, so the line says so instead of telling
          // an operator a slot definitely was not spent. See writeSucceededFor.
          logAuditWriteFailure(err, writeSucceededFor(err.fault.kind));
          // Same machine code as the read-side 503 above, deliberately: from
          // the caller's side both mean "your analysis limit cannot be
          // maintained right now, retry", and one code to branch on beats two
          // that need the same handling.
          return NextResponse.json(
            {
              error:
                'We could not start the analysis just now. Please try again in a few minutes.',
              code: UNAVAILABLE_CODE,
            },
            { status: 503 }
          );
        }
        throw err;
      }
    }

    // Create the record (status='queued'), kick the analyzer off
    // via after(), return immediately. The wizard polls
    // /api/public/site-intelligence/status to know when the work
    // is done.
    //
    // AUD-1. NOW BOUNDED. The previous note argued these two could stay
    // unbounded because a request-path stall is "at least visible" as a
    // gateway timeout. That argument does not survive the line above it: by
    // this point the fail-closed audit write has SUCCEEDED, so a rate-limit
    // slot is already spent. A stall here holds the invocation to
    // maxDuration = 300s, the platform kills it, the client sees a gateway
    // error with no code, and they are one hourly attempt down with no scan
    // and no log line explaining either. It also loses scan dedup: the FK that
    // makes an in-flight scan discoverable is the second of these two calls.
    //
    // WHAT THE BOUND DOES AND DOES NOT DO, stated rather than implied. Neither
    // helper takes an AbortSignal, so `withDeadline` bounds the WAITING and
    // does not CANCEL the underlying request the way the signal-aware reads
    // above are cancelled. That is the honest difference between this bound
    // and those; it is still the difference between a report at 5s and a
    // gateway kill at 300s. Threading a signal into these two helpers is a
    // change to src/lib/siteIntelligence/analyze.ts and is deliberately not
    // made here.
    // A failure here is deliberately left to the TERMINAL CATCH rather than
    // answered locally: that catch is now tagged, coded and slot-aware
    // (AUD-1), and it is the one place that knows how to say "a slot was
    // spent". A local answer would be a second sentence for one condition.
    const recordId = await withDeadline(
      'record_create',
      UPSTREAM_READ_TIMEOUT_MS_FAIL_CLOSED,
      () => createSiteIntelligenceRecord(websiteUrl),
    );

    // Make the in-flight scan discoverable so a reload (or an AM clicking
    // Analyze while it runs) resumes/dedups it instead of starting a
    // duplicate. Sets the FK only; snapshots are written on completion by
    // linkSiteIntelligenceToSession. Skips when a still-good completed
    // record is already linked (bug-#2 invariant — see the helper).
    //
    // LOG AND CONTINUE, not fail. The record EXISTS at this point and the
    // scan below is worth running; this call only makes it discoverable for
    // dedup. Failing the caller here would waste a slot that has already been
    // spent AND throw away a scan that can still succeed, so the disposition
    // is the same one the helper's own internal error handling already chose,
    // now with a line an operator can grep instead of a console.warn.
    try {
      await withDeadline('attach_pending_scan', UPSTREAM_READ_TIMEOUT_MS_FAIL_CLOSED, () =>
        attachPendingScanToSession(session!.id, recordId, priorLinkedId),
      );
    } catch (err) {
      logUpstreamFailure(
        BOUNDED_STAGE_FAILURE_TAG,
        {
          route: ANALYZE_ROUTE,
          target: 'attach_pending_scan (onboarding_sessions)',
          eventType: 'analyze_attach_pending_scan',
          sessionId: session.id,
          clientId: session.client_id,
          succeeded:
            'the rate-limit slot was spent and the analysis record EXISTS and is being scanned; ' +
            'only the dedup FK was not set, so a reload or a second Analyze click may start a duplicate scan',
        },
        normaliseThrownFault(err),
      );
    }

    // -----------------------------------------------------------------------
    // D3 — THE AFTER() CALLBACK: three unbounded awaits and NO failure report.
    // -----------------------------------------------------------------------
    //
    // This callback held `runSiteAnalysis`, `getSiteIntelligence` and
    // `linkSiteIntelligenceToSession` with no bound on any of them and, when
    // one of them threw, a bare `console.error(..., err)` — not a tagged line,
    // not one line of JSON, no session id, no `succeeded`, nothing an operator
    // could grep for alongside the other tags. Under a Supabase that accepts
    // and never answers it did not even reach that: the callback simply hung
    // past the response, holding the invocation open until the platform killed
    // it, with the 200 already delivered and nothing said anywhere.
    //
    // EACH STAGE IS NOW BOUNDED SEPARATELY, so the line can name which one
    // failed. The two Supabase-only stages get the ordinary 5s after()-path
    // budget and a real AbortSignal, so their reads are CANCELLED. The
    // analysis stage gets the long deadline, because it legitimately runs
    // providers and an Anthropic call — see SITE_ANALYSIS_DEADLINE_MS,
    // including what it does and does not cover.
    const analysisSessionId = session.id;
    after(async () => {
      const report = (stage: string, target: string, err: unknown, succeeded: string): void => {
        logUpstreamFailure(
          BOUNDED_STAGE_FAILURE_TAG,
          {
            route: `after(${ANALYZE_ROUTE})`,
            target: `${stage} (${target})`,
            eventType: 'site_intelligence_background_analysis',
            sessionId: analysisSessionId,
            clientId: session.client_id,
            succeeded,
          },
          normaliseThrownFault(err),
        );
      };

      try {
        await withDeadline('site_analysis', SITE_ANALYSIS_DEADLINE_MS, () =>
          runSiteAnalysis(recordId, { sessionId: analysisSessionId }),
        );
      } catch (err) {
        report(
          'site_analysis',
          `runSiteAnalysis(${recordId})`,
          err,
          'the analyze request was answered and the queued record exists; the scan did not complete, so the session keeps whatever prefill it already had and the client can retry',
        );
        return;
      }

      // Bug #2 fix: link to the session ONLY if the analysis
      // actually succeeded. If we relinked unconditionally (or
      // pre-linked on record creation), a failed re-analyze would
      // overwrite a prior good record's link with a failed one —
      // orphaning the good prefill data the session was already
      // benefiting from. By gating on status='completed' here, a
      // failed re-analyze leaves the session pointing at whatever
      // last-good record it had (or NULL if none).
      let record: Awaited<ReturnType<typeof getSiteIntelligence>>;
      try {
        record = await withDeadline(
          'analysis_status_read',
          UPSTREAM_READ_TIMEOUT_MS_FAIL_CLOSED,
          (signal) => getSiteIntelligence(recordId, { signal }),
        );
      } catch (err) {
        report(
          'analysis_status_read',
          'onboarding_site_intelligence',
          err,
          'the analysis itself ran and its own result write already happened; only the link-on-completion step was skipped, so the session may still be pointing at an older record',
        );
        return;
      }

      if (record && record.status === 'completed') {
        try {
          await withDeadline(
            'link_to_session',
            UPSTREAM_READ_TIMEOUT_MS_FAIL_CLOSED,
            (signal) => linkSiteIntelligenceToSession(analysisSessionId, recordId, { signal }),
          );
        } catch (err) {
          report(
            'link_to_session',
            'onboarding_sessions',
            err,
            'the analysis COMPLETED and its record is intact; only the session link and prefill snapshots were not written, so re-run the link for this session rather than re-paying for the scan',
          );
        }
      }
    });

    return NextResponse.json({
      success: true,
      recordId,
      status: 'queued',
    });
  } catch (error) {
    // -----------------------------------------------------------------------
    // AUD-1 — THE LAST UNTAGGED EMIT IN THE CHANGE, AND THE WORST PLACE FOR IT
    // -----------------------------------------------------------------------
    //
    // This was `console.error('[public site-intel analyze] error:', error)`:
    // no tag to grep, no session id, no machine code on the response, and —
    // because a caught Error is printed with its stack — SEVERAL physical
    // lines, which is the exact fragmentation every other emitter in this
    // change was written to avoid.
    //
    // It is also the branch reached AFTER the fail-closed audit write has
    // succeeded, which is the part that made the silence expensive rather than
    // merely untidy. Driven live: the rate-limit row landed 201,
    // createSiteIntelligenceRecord was then refused with a real 42501, and the
    // caller got `500 {"error":"Internal server error"}`. The client was one
    // of five hourly attempts down and nothing anywhere said so, so the
    // obvious advice — "just try again" — silently burned the rest.
    //
    // So the line now goes through the SAME emitter as every other failure on
    // this route (one tag, one line of JSON, escaped, bounded, normalised
    // fault vocabulary), names the session, and its `succeeded` field states
    // the slot outcome as a FACT rather than leaving it to be inferred.
    logUpstreamFailure(
      BOUNDED_STAGE_FAILURE_TAG,
      {
        route: ANALYZE_ROUTE,
        target: 'request_handler (unhandled)',
        eventType: 'analyze_request_handler',
        sessionId: handlerSessionId ?? '',
        clientId: handlerClientId,
        succeeded: rateLimitSlotSpent
          ? 'A RATE-LIMIT SLOT WAS SPENT: the site_intelligence_analyze_requested row is committed, so this ' +
            'client is one of their five hourly attempts down. No analysis record is guaranteed and no ' +
            'Anthropic spend is guaranteed. Telling them to simply retry burns the remaining slots.'
          : 'no rate-limit slot was spent, no analysis record was created and no Anthropic spend was incurred: ' +
            'this failed before the analyze-requested row was written',
      },
      normaliseThrownFault(error),
    );
    return NextResponse.json(
      {
        error: 'We could not complete your request just now. Please try again in a few minutes.',
        code: HANDLER_FAILED_CODE,
        // The one fact a CLIENT can act on, and the reason it is in the body
        // rather than only in the log: whether a retry is free.
        slotSpent: rateLimitSlotSpent,
      },
      { status: 500 }
    );
  }
}
