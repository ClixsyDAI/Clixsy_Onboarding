import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getSessionByToken } from '@/lib/supabase/server';
import { checkSessionGuard } from '@/lib/onboarding/session-guard';

/**
 * POST /api/public/onboarding/submit-feedback
 *
 * Body: { token: string, rating: number }   // 1-5 inclusive
 *
 * Persists the 1-5 star rating from the rebuilt thank-you screen
 * (Stage 8 / S12.4). Writes:
 *   feedback_rating         = rating
 *   feedback_submitted_at   = now()
 *
 * Auth: same gate as save-step / submit. PIN cookie required unless
 * pin_hash IS NULL (legacy session). The session being already
 * submitted is fine — rating is post-submit by design.
 *
 * Re-submitting a different rating overwrites the previous one. The
 * UI only fires this on each star click, so the column always
 * reflects the user's final pick when they click Finish.
 */
export async function POST(request: NextRequest) {
  let body: { token?: unknown; rating?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const rating = typeof body.rating === 'number' ? body.rating : NaN;

  if (!token || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const session = await getSessionByToken(token);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const guard = await checkSessionGuard(session);
  if (guard.kind === 'locked') {
    return NextResponse.json({ error: 'Session is locked.' }, { status: guard.lock === 'permanent' ? 423 : 429 });
  }
  if (guard.kind === 'needs_pin') {
    return NextResponse.json({ error: 'PIN verification required' }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const { error: updateErr } = await supabase
    .from('onboarding_sessions')
    .update({
      feedback_rating: rating,
      feedback_submitted_at: new Date().toISOString(),
    })
    .eq('id', session.id);

  if (updateErr) {
    console.error('submit-feedback: update failed', updateErr);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
