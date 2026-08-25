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
  AuditWriteError,
  AUDIT_READ_TIMEOUT_MS_FAIL_CLOSED,
} from '@/lib/supabase/server';
import { resolveSessionAccess } from '@/lib/onboarding/session-guard';
import { isLikelyUrl } from '@/lib/onboarding/url-shape';

// Same Vercel platform max as the admin route — see the comment in
// src/app/api/admin/site-intelligence/analyze/route.ts for the
// historical-runtime rationale.
export const maxDuration = 300;

const RATE_LIMIT_PER_HOUR = 5;

/** Normalize a URL for idempotency comparison. */
function normalizeUrl(url: string): string {
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = 'https://' + u;
  }
  return u.replace(/\/+$/, '').toLowerCase();
}

export async function POST(request: NextRequest) {
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
    const session = await getSessionByToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    const access = await resolveSessionAccess(session, request);
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
    const reuse = await findReusableScan(priorLinkedId, websiteUrl);
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
    const { count, error: countErr } = await supabase
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
    if (rateLimitStateUnknown && !isAmBypass) {
      console.error(
        `[rate-limit][READ-FAILURE] ${JSON.stringify({
          route: 'POST /api/public/site-intelligence/analyze',
          table: 'onboarding_audit_events',
          event_type: 'site_intelligence_analyze_requested',
          session_id: session.id,
          client_id: session.client_id,
          fault: countErr ? 'postgrest' : 'null_count',
          pg_code: countErr?.code || null,
          message:
            countErr?.message ||
            'the count query returned no error body, or a null count where an exact count was requested',
          succeeded: 'nothing was started: no analysis record, no Anthropic spend',
        })}`
      );
      return NextResponse.json(
        {
          error:
            'We could not check your analysis limit just now. Please try again in a few minutes.',
          code: 'rate_limit_state_unavailable',
        },
        { status: 503 }
      );
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
            route: 'POST /api/public/site-intelligence/analyze',
            succeeded: 'nothing was started: no analysis record, no Anthropic spend',
          }
        );
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
          logAuditWriteFailure(err);
          // Same machine code as the read-side 503 above, deliberately: from
          // the caller's side both mean "your analysis limit cannot be
          // maintained right now, retry", and one code to branch on beats two
          // that need the same handling.
          return NextResponse.json(
            {
              error:
                'We could not start the analysis just now. Please try again in a few minutes.',
              code: 'rate_limit_state_unavailable',
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
    const recordId = await createSiteIntelligenceRecord(websiteUrl);

    // Make the in-flight scan discoverable so a reload (or an AM clicking
    // Analyze while it runs) resumes/dedups it instead of starting a
    // duplicate. Sets the FK only; snapshots are written on completion by
    // linkSiteIntelligenceToSession. Skips when a still-good completed
    // record is already linked (bug-#2 invariant — see the helper).
    await attachPendingScanToSession(session.id, recordId, priorLinkedId);

    after(async () => {
      try {
        await runSiteAnalysis(recordId);
        // Bug #2 fix: link to the session ONLY if the analysis
        // actually succeeded. If we relinked unconditionally (or
        // pre-linked on record creation), a failed re-analyze would
        // overwrite a prior good record's link with a failed one —
        // orphaning the good prefill data the session was already
        // benefiting from. By gating on status='completed' here, a
        // failed re-analyze leaves the session pointing at whatever
        // last-good record it had (or NULL if none).
        const record = await getSiteIntelligence(recordId);
        if (record && record.status === 'completed') {
          await linkSiteIntelligenceToSession(session.id, recordId);
        }
      } catch (err) {
        console.error(
          '[public site-intel analyze] background analysis failed:',
          err
        );
      }
    });

    return NextResponse.json({
      success: true,
      recordId,
      status: 'queued',
    });
  } catch (error) {
    console.error('[public site-intel analyze] error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
