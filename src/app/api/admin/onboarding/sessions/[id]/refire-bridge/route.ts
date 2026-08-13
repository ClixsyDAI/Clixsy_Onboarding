import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient, type OnboardingSession } from '@/lib/supabase/server';
import { checkBearerToken } from '@/lib/onboarding/bearer-auth';
import { fireDashboardClientBridge } from '@/lib/onboarding/dashboard-bridge';
import { exportSubmissionToSheet } from '@/lib/onboarding/sheet-export';

/**
 * POST /api/admin/onboarding/sessions/[id]/refire-bridge
 *
 * Re-runs the two post-submit side effects for an ALREADY-SUBMITTED session.
 *
 * WHY THIS EXISTS (dashboard remediation item 10)
 *
 * A failed bridge had no retry path at all. The submit route sets
 * status='submitted' (submit/route.ts:196) and then rejects every later POST with
 * "Session has already been submitted" (:148-153). The two side effects run in
 * `after()` (:220, :224) and had no other call site, so if either failed — a
 * dashboard deploy mid-submit, a transient 502, an expired bearer — the client was
 * submitted and the roster never learned about it. Recovery meant editing the
 * database by hand to un-submit a session, which is worse than the failure.
 *
 * This is a thin wrapper around the two existing functions. It adds no dedupe
 * logic because none is needed: both are already idempotent on workbook_id. The
 * dashboard's /api/clients reconciles on that key (it created the roster entry the
 * first time and merges on later calls), and the sheet export claims a row by the
 * same id rather than appending blindly.
 *
 * DELIBERATELY NOT under /api/public. It sits under /api/admin so it inherits the
 * proxy matcher at src/proxy.ts (`/api/admin/:path*`), which fails closed — a
 * missing cookie AND a missing bearer both deny. The bearer check below is the
 * second layer, matching the sibling unlock and regenerate-pin routes, so a matcher
 * misregistration cannot leave this open. Two gates, because this route causes
 * writes in another system.
 *
 * Requires status='submitted'. Firing the bridge for a session that was never
 * submitted would create a roster entry for an incomplete onboarding, which is the
 * opposite of the problem being fixed.
 *
 * Returns per-side-effect outcomes rather than a bare ok, so an operator can see
 * which half recovered. Both functions handle their own errors and never throw, so
 * a thrown error here means something unexpected and is reported as a 500.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = checkBearerToken(request);
  if (auth.kind === 'deny') {
    return NextResponse.json(
      { error: 'Unauthorized', reason: auth.reason },
      { status: 401 }
    );
  }

  try {
    const { id } = await params;
    const supabase = createServiceRoleClient();

    // Select * : fireDashboardClientBridge and exportSubmissionToSheet both take
    // the whole session row, and naming columns here would break silently the next
    // time either of them reads a new one.
    const { data: session, error } = await supabase
      .from('onboarding_sessions')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: 'Lookup failed', detail: error.message },
        { status: 500 }
      );
    }
    if (!session) {
      return NextResponse.json({ error: 'Session not found', id }, { status: 404 });
    }
    if (session.status !== 'submitted') {
      return NextResponse.json(
        {
          error: 'invalid_state',
          detail:
            'Only a submitted session can have its bridge re-fired. Firing for an ' +
            'unsubmitted session would create a roster entry for an incomplete onboarding.',
          id,
          status: session.status,
        },
        { status: 409 }
      );
    }

    // Awaited, not fired through after(): the caller is an operator recovering a
    // known failure and needs the outcome in the response. The submit path uses
    // after() so it never blocks a client; that reasoning does not apply here.
    // Settled independently so one failure cannot hide the other's result.
    // Cast rather than trust inference. The submit path feeds these functions a
    // session from getSessionByToken, which is already typed OnboardingSession;
    // this route loads by id with select('*'), which returns the same full row but
    // whose inferred type depends on whether the client carries generated Database
    // types. OnboardingSession is the description of that row, so the cast is
    // narrowing to the truth rather than asserting something unchecked.
    const full = session as unknown as OnboardingSession;

    const [bridge, sheet] = await Promise.allSettled([
      fireDashboardClientBridge(full),
      exportSubmissionToSheet(full),
    ]);

    const describe = (r: PromiseSettledResult<unknown>) =>
      r.status === 'fulfilled'
        ? { ok: true }
        : {
            ok: false,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          };

    return NextResponse.json({
      ok: true,
      id,
      refired: {
        dashboardBridge: describe(bridge),
        sheetExport: describe(sheet),
      },
      note:
        'Both side effects are idempotent on workbook_id, so re-running is safe. ' +
        'An ok:false half can be re-fired on its own by calling this route again.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[refire-bridge] unexpected failure:', message);
    return NextResponse.json({ error: 'Refire failed', detail: message }, { status: 500 });
  }
}
