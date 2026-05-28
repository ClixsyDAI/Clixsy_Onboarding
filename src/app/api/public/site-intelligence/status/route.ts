// =============================================================
// POST /api/public/site-intelligence/status
// =============================================================
//
// Client-side polling endpoint. Mirrors the public-auth pattern
// (token + checkSessionGuard cookie) so the wizard can ask "what's
// the state of my session's currently-linked analysis?" without
// needing the analysis recordId on the client.
//
// Returns one of:
//   - { status: 'none' }                  — no analysis linked yet
//   - { status: 'queued'|'running' ...}  — in-flight
//   - { status: 'completed' ...prefill}  — terminal happy path
//   - { status: 'failed' ...error}       — terminal sad path
//
// POST (not GET) because the body carries the session token and
// the PIN cookie rides via headers — same shape as the existing
// /api/public/onboarding/submit endpoint.

import { NextRequest, NextResponse } from 'next/server';
import { getSiteIntelligence } from '@/lib/siteIntelligence/analyze';
import { getSessionByToken } from '@/lib/supabase/server';
import { checkSessionGuard } from '@/lib/onboarding/session-guard';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token } = body;

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

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

    // No analysis ever linked → tell the client the field is empty
    // so the wizard can show the "Analyze my site" affordance.
    if (!session.site_intelligence_id) {
      return NextResponse.json({ status: 'none' });
    }

    const record = await getSiteIntelligence(session.site_intelligence_id);
    if (!record) {
      // Orphan link — shouldn't happen but defensively return 'none'
      // so the wizard recovers by offering to re-analyze.
      return NextResponse.json({ status: 'none' });
    }

    return NextResponse.json({
      id: record.id,
      status: record.status,
      website_url: record.website_url,
      domain: record.domain,
      started_at: record.started_at,
      completed_at: record.completed_at,
      branding: record.branding,
      insights: record.insights,
      prefill_map: record.prefill_map,
      question_overrides: record.question_overrides,
      prefill_count: record.prefill_map
        ? Object.keys(record.prefill_map).length
        : 0,
      autofill_count: record.prefill_map
        ? Object.values(record.prefill_map).filter(
            (e: { policy: string }) => e.policy === 'autofill'
          ).length
        : 0,
      suggest_count: record.prefill_map
        ? Object.values(record.prefill_map).filter(
            (e: { policy: string }) => e.policy === 'suggest_only'
          ).length
        : 0,
      error: record.error,
    });
  } catch (error) {
    console.error('[public site-intel status] error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
