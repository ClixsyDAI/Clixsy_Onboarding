import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  gateDecision,
  nextStateAfterAttempt,
  verifyPin,
  type SessionPinState,
} from '@/lib/onboarding/pin';
import {
  signSessionCookie,
  cookieOptions,
  PIN_COOKIE_NAME,
} from '@/lib/onboarding/pin-cookie';

/**
 * POST /api/public/onboarding/verify-pin
 *
 * Body: { token: string, pin: string }
 *
 * Resolves the session by public token, runs the gateDecision +
 * verifyPin + nextStateAfterAttempt pipeline from Stage 1's PIN
 * module, writes the new PIN state back, and on success sets the
 * HMAC-signed session cookie so subsequent requests on the same
 * browser skip the prompt.
 *
 * Responses are deliberately generic on failure so the client UI
 * never reveals whether a wrong PIN happens to share digits with
 * a real one, or anything else about the underlying row.
 */
export async function POST(request: NextRequest) {
  let body: { token?: unknown; pin?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const pin = typeof body.pin === 'string' ? body.pin : '';

  if (!token || !/^\d{6}$/.test(pin)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // Fetch the session by token. Service role bypasses RLS so we can read
  // pin_hash without leaking it to the client.
  const { data: session, error: sessionErr } = await supabase
    .from('onboarding_sessions')
    .select('id, pin_hash, pin_attempts, pin_lockout_until, pin_locked_at')
    .eq('token', token)
    .single();

  if (sessionErr || !session) {
    // Token not found — keep the response generic. Pretend it's just
    // another wrong-PIN so token-hunting attackers can't enumerate.
    return NextResponse.json(
      { error: "That PIN doesn't match. Please check with your Clixsy contact." },
      { status: 401 }
    );
  }

  const state: SessionPinState = {
    pin_hash: session.pin_hash,
    pin_attempts: session.pin_attempts ?? 0,
    pin_lockout_until: session.pin_lockout_until,
    pin_locked_at: session.pin_locked_at,
  };

  const gate = gateDecision(state);

  if (gate.kind === 'no_pin_required') {
    // Legacy / pre-Stage-1 row with no PIN configured. Authorise the
    // browser directly so subsequent loads of THIS session sail through
    // without us special-casing the absence of a cookie everywhere.
    const cookieStore = await cookies();
    cookieStore.set(PIN_COOKIE_NAME, signSessionCookie(session.id), cookieOptions());
    return NextResponse.json({ success: true, sessionId: session.id, noPinRequired: true });
  }

  if (gate.kind === 'permanently_locked') {
    return NextResponse.json(
      {
        error: 'This onboarding link is locked. Please contact your Clixsy account manager to reissue access.',
        locked: 'permanent',
      },
      { status: 423 }
    );
  }

  if (gate.kind === 'rate_limited') {
    return NextResponse.json(
      {
        error: 'Too many incorrect attempts. Try again in 15 minutes or contact your Clixsy account manager.',
        locked: 'rate_limited',
        retryAfter: gate.retryAfter,
      },
      { status: 429 }
    );
  }

  // gate.kind === 'ready' — actually verify.
  const ok = await verifyPin(pin, session.pin_hash as string);
  const update = nextStateAfterAttempt(state, ok);

  // Persist the new attempt state regardless of outcome.
  const { error: updateErr } = await supabase
    .from('onboarding_sessions')
    .update(update)
    .eq('id', session.id);

  if (updateErr) {
    console.error('verify-pin: failed to persist attempt state', updateErr);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  if (!ok) {
    // Re-derive the gate decision against the JUST-WRITTEN state so we
    // surface lockouts immediately on the attempt that crossed the line.
    const postGate = gateDecision({ ...state, ...update });
    if (postGate.kind === 'permanently_locked') {
      return NextResponse.json(
        {
          error: 'This onboarding link is now locked after too many incorrect attempts. Please contact your Clixsy account manager.',
          locked: 'permanent',
        },
        { status: 423 }
      );
    }
    if (postGate.kind === 'rate_limited') {
      return NextResponse.json(
        {
          error: 'Too many incorrect attempts. Try again in 15 minutes or contact your Clixsy account manager.',
          locked: 'rate_limited',
          retryAfter: postGate.retryAfter,
        },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: "That PIN doesn't match. Please check with your Clixsy contact." },
      { status: 401 }
    );
  }

  // Success — issue the cookie.
  const cookieStore = await cookies();
  cookieStore.set(PIN_COOKIE_NAME, signSessionCookie(session.id), cookieOptions());

  return NextResponse.json({ success: true, sessionId: session.id });
}
