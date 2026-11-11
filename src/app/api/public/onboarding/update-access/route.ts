import { NextRequest, NextResponse } from 'next/server';
import {
  getSessionByToken,
  upsertAnswer,
  recordAuditEvent,
  createServiceRoleClient,
} from '@/lib/supabase/server';
import { resolveSessionAccess } from '@/lib/onboarding/session-guard';

// The nine v2 access_checklist fields (steps-v2.ts STEP 9). These are the
// ONLY keys a post-submit client update may write; every other key in the
// request body is dropped before the write. This is the allowlist the brief
// asks for — it keeps the client from flipping status or injecting fields.
const ACCESS_FIELD_KEYS = [
  'has_google_analytics',
  'ga_access_status',
  'gsc_access_status',
  'gbp_access_status',
  'wordpress_access_status',
  'domain_access_status',
  'dns_access_status',
  'has_youtube',
  'youtube_access_status',
] as const;

// Post-submit access edits per session per rolling hour. Fail-OPEN on a
// counter read error: the write is cheap and self-correcting, so a transient
// Supabase blip must never lock a client out of fixing their own access.
const RATE_LIMIT_PER_HOUR = 10;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, answers } = body;

    if (!token || !answers || typeof answers !== 'object') {
      return NextResponse.json(
        { error: 'Missing required fields: token, answers' },
        { status: 400 },
      );
    }

    const session = await getSessionByToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Same gate as save-step: a locked session is always blocked (bypass
    // waives the PIN, not the lock), needs_pin is blocked, and a valid
    // x-am-bypass signature waives the PIN. isAmBypass then suppresses both
    // the rate limit and the audit row — AM-entered edits are real data but
    // must not register as client engagement.
    const access = await resolveSessionAccess(session, request);
    if (access.kind === 'locked') {
      return NextResponse.json(
        { error: 'Session is locked. Contact your Clixsy account manager.' },
        { status: access.lock === 'permanent' ? 423 : 429 },
      );
    }
    if (access.kind === 'needs_pin') {
      return NextResponse.json({ error: 'PIN verification required' }, { status: 401 });
    }
    const isAmBypass = access.isAmBypass;

    // This route exists ONLY for post-submit access edits. A not-yet-submitted
    // session uses save-step; reject here so the two paths stay distinct and
    // this route never has a reason to advance a step or change status.
    if (session.status !== 'submitted') {
      return NextResponse.json(
        { error: 'Session has not been submitted yet' },
        { status: 400 },
      );
    }

    const supabase = createServiceRoleClient();

    // Rolling-hour rate limit on this session's post-submit edits. Counts
    // prior 'client_post_submit' audit rows. Fail-open (see note above).
    if (!isAmBypass) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error } = await supabase
        .from('onboarding_audit_events')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', session.id)
        .eq('event_type', 'client_post_submit')
        .gte('created_at', oneHourAgo);
      if (!error && (count ?? 0) >= RATE_LIMIT_PER_HOUR) {
        return NextResponse.json(
          { error: 'Too many updates. Please wait a little before trying again.' },
          { status: 429 },
        );
      }
    }

    // Allowlist the incoming answers down to the nine known access fields.
    const filtered: Record<string, unknown> = {};
    const incoming = answers as Record<string, unknown>;
    for (const key of ACCESS_FIELD_KEYS) {
      if (key in incoming) filtered[key] = incoming[key];
    }

    // Merge over the existing access_checklist answers. upsertAnswer REPLACES
    // the row's whole `answers` object, so a merge is required: without it, a
    // field the client's view didn't send (e.g. has_youtube when the channel
    // question was hidden) would be wiped. The allowlist above still bounds
    // what this request can change or add.
    const { data: existingRow } = await supabase
      .from('onboarding_answers')
      .select('answers')
      .eq('session_id', session.id)
      .eq('step_key', 'access_checklist')
      .maybeSingle();
    const existing = (existingRow?.answers as Record<string, unknown> | null) || {};
    const merged = { ...existing, ...filtered };

    const saved = await upsertAnswer(
      session.id,
      'access_checklist',
      merged,
      true,
      'onboarding_save',
    );
    if (!saved) {
      return NextResponse.json({ error: 'Failed to save access' }, { status: 500 });
    }

    // Audit the post-submit edit. event_type 'client_post_submit' is also the
    // rate-limit counter above. Suppressed under AM bypass. recordAuditEvent
    // never throws and logs its own failure — a lost row degrades the
    // workbook activity view and nothing else, so the save still succeeds.
    if (!isAmBypass) {
      await recordAuditEvent(
        session.id,
        'client_post_submit',
        { changedFields: Object.keys(filtered) },
        {
          clientId: session.client_id,
          route: 'POST /api/public/onboarding/update-access',
          succeeded:
            'the access answers were persisted post-submit; only the audit row was lost',
        },
      );
    }

    return NextResponse.json({ success: true, savedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error updating access:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
