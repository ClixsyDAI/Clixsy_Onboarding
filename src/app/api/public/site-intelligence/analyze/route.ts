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
} from '@/lib/siteIntelligence/analyze';
import {
  getSessionByToken,
  createServiceRoleClient,
  createAuditEvent,
} from '@/lib/supabase/server';
import { checkSessionGuard } from '@/lib/onboarding/session-guard';

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

    // Auth: session lookup + PIN guard.
    const session = await getSessionByToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    const guard = await checkSessionGuard(session);
    if (guard.kind === 'locked') {
      return NextResponse.json(
        { error: 'Session is locked. Contact your Clixsy account manager.' },
        { status: guard.lock === 'permanent' ? 423 : 429 }
      );
    }
    if (guard.kind === 'needs_pin') {
      return NextResponse.json(
        { error: 'PIN verification required' },
        { status: 401 }
      );
    }

    const normalizedUrl = normalizeUrl(websiteUrl);

    // Idempotency: if the session is already linked to a completed
    // analysis for the same URL, return that record without
    // re-running. Prevents wasted Firecrawl / PageSpeed cost when
    // the client clicks "Analyze my site" twice for the same URL.
    if (session.site_intelligence_id) {
      const existing = await getSiteIntelligence(session.site_intelligence_id);
      if (
        existing &&
        existing.status === 'completed' &&
        normalizeUrl(existing.website_url) === normalizedUrl
      ) {
        return NextResponse.json({
          success: true,
          recordId: existing.id,
          status: existing.status,
          reused: true,
        });
      }
    }

    // Rate limit: count prior analyze-requested audit events for
    // this session within the past rolling hour. The count is
    // incremented BEFORE the analyzer runs (one audit row per
    // request), so a session that gets 5 quick clicks gets blocked
    // even before any analysis completes.
    const supabase = createServiceRoleClient();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: countErr } = await supabase
      .from('onboarding_audit_events')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', session.id)
      .eq('event_type', 'site_intelligence_analyze_requested')
      .gte('created_at', oneHourAgo);

    if (!countErr && (count ?? 0) >= RATE_LIMIT_PER_HOUR) {
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
    await createAuditEvent(
      session.id,
      'site_intelligence_analyze_requested',
      {
        website_url: normalizedUrl,
        via: 'public_wizard_step_1',
      }
    );

    // Create the record (status='queued'), kick the analyzer off
    // via after(), return immediately. The wizard polls
    // /api/public/site-intelligence/status to know when the work
    // is done.
    const recordId = await createSiteIntelligenceRecord(websiteUrl);

    after(async () => {
      try {
        await runSiteAnalysis(recordId);
        // Always link on completion. If the session already had a
        // different site_intelligence_id (re-analyze flow), this
        // replaces it — the old record is orphaned but kept in the
        // table for audit / debugging.
        await linkSiteIntelligenceToSession(session.id, recordId);
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
