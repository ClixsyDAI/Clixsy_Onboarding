import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifySessionCookie, PIN_COOKIE_NAME } from '@/lib/onboarding/pin-cookie';
import { verifyAmBypass, AM_BYPASS_HEADER } from '@/lib/onboarding/am-bypass';

/**
 * POST /api/public/onboarding/mark-welcome-seen
 *
 * Body: { token: string }
 *
 * Flips `welcome_wizard_seen` to true on the session row when the user
 * clicks "Start onboarding" on the P3 welcome modal's second step.
 * Server-side persistence so the flag survives cleared cookies / new
 * browsers — the modal really does fire ONLY once per session.
 *
 * Auth: requires a valid PIN cookie matching the resolved session, OR
 * a session with pin_hash = NULL (legacy bypass). We re-verify here
 * even though the page-level guard already checks, because this route
 * mutates a row.
 */
export async function POST(request: NextRequest) {
  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const supabase = createServiceRoleClient();

  const { data: session, error: sessionErr } = await supabase
    .from('onboarding_sessions')
    .select('id, pin_hash')
    .eq('token', token)
    .single();
  if (sessionErr || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Sprint 2 / #4: second layer of the double-gate. Under AM bypass the
  // wizard never renders, so this endpoint should never be called — but
  // if it is (manual call, future regression), NO-OP with 200 instead of
  // flipping the flag. An AM preview must never consume the client's
  // first-time welcome experience.
  if (verifyAmBypass(session.id, request.headers.get(AM_BYPASS_HEADER))) {
    return NextResponse.json({ success: true, skipped: 'am_bypass' });
  }

  // Authorise: legacy rows (no PIN) bypass; otherwise require cookie.
  if (session.pin_hash !== null) {
    const cookieStore = await cookies();
    const cookieValue = cookieStore.get(PIN_COOKIE_NAME)?.value;
    const verification = verifySessionCookie(cookieValue);
    if (!verification.valid || verification.sessionId !== session.id) {
      return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
    }
  }

  const { error: updateErr } = await supabase
    .from('onboarding_sessions')
    .update({ welcome_wizard_seen: true })
    .eq('id', session.id);
  if (updateErr) {
    console.error('mark-welcome-seen: update failed', updateErr);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
