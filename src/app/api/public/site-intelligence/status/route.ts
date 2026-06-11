// =============================================================
// POST /api/public/site-intelligence/status
// =============================================================
//
// Client-side polling endpoint. Mirrors the public-auth pattern
// (token + checkSessionGuard cookie) so the wizard can ask "what's
// the state of THIS analysis I just triggered" (active poll) OR
// "what's currently linked to my session" (initial mount).
//
// Two read paths:
//   1. body.recordId present  → read that specific record directly.
//      The wizard owns the polling context and supplies the recordId
//      from the analyze POST response. This is the bug-#2 fix path —
//      the previous "always read session.site_intelligence_id"
//      behavior would return STALE data on re-analyze, because the
//      session's linked record only updates AFTER the new analysis
//      completes.
//   2. body.recordId absent   → fall back to session.site_intelligence_id.
//      Used by initial-mount fallback paths if the wizard ever needs
//      to fetch "whatever's currently linked" without an active poll.
//
// Returns one of:
//   - { status: 'none' }                  — no recordId resolved
//   - { status: 'queued'|'running' ...}  — in-flight
//   - { status: 'completed' ...prefill}  — terminal happy path
//   - { status: 'failed' ...error}       — terminal sad path
//
// POST (not GET) because the body carries the session token and
// (optionally) the recordId — same shape as the existing
// /api/public/onboarding/submit endpoint.

import { NextRequest, NextResponse } from 'next/server';
import { getSiteIntelligence } from '@/lib/siteIntelligence/analyze';
import { getSessionByToken } from '@/lib/supabase/server';
import { checkSessionGuard } from '@/lib/onboarding/session-guard';
import { isAmBypassRequest } from '@/lib/onboarding/am-bypass';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, recordId } = body;

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    const session = await getSessionByToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    // Sprint 2 / #4: AM bypass skips the PIN gate. This is a pure read
    // (no audit writes) so there's nothing to suppress — it just needs
    // to not 401 the AM polling the scan they kicked off.
    if (!isAmBypassRequest(session.id, request)) {
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
    }

    // Resolve which record to read. Active-poll path (recordId supplied)
    // takes priority — the wizard knows which analysis it's tracking.
    // Fall back to session.site_intelligence_id only when no recordId
    // is supplied (initial-mount / fallback path).
    const targetRecordId: string | null =
      typeof recordId === 'string' && recordId
        ? recordId
        : session.site_intelligence_id ?? null;

    if (!targetRecordId) {
      // No record to read — neither an active poll target nor anything
      // linked to the session. Tell the wizard to show the "Analyze my
      // site" affordance.
      return NextResponse.json({ status: 'none' });
    }

    const record = await getSiteIntelligence(targetRecordId);
    if (!record) {
      // Orphan link or invalid recordId — defensively return 'none' so
      // the wizard recovers by offering to re-analyze.
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
