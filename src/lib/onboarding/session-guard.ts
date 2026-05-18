// =============================================================
// Server-side session guard
// =============================================================
//
// Shared between every public onboarding API route. Resolves the
// request token to a session row, runs the gateDecision pipeline,
// and decides whether the caller is authorised to read/write that
// session. Returns one of three outcomes — the caller responds
// according to the kind.
//
// Behaviour:
//   pin_hash IS NULL                 → 'ok' (legacy bypass)
//   permanently_locked               → 'locked' kind='permanent'
//   rate_limited                     → 'locked' kind='rate_limited'
//   ready + valid cookie for session → 'ok'
//   ready + invalid/missing cookie   → 'needs_pin'
//
// pin_hash itself is never returned to callers; we surface `pin_set`
// (boolean) for the page-level guard to decide whether to show the
// PIN entry screen.

import { cookies } from 'next/headers';
import { verifySessionCookie, PIN_COOKIE_NAME } from './pin-cookie';
import { gateDecision, type SessionPinState } from './pin';

export interface SessionRow {
  id: string;
  pin_hash: string | null;
  pin_attempts: number;
  pin_lockout_until: string | null;
  pin_locked_at: string | null;
}

export type GuardResult =
  | { kind: 'ok'; pinSet: boolean }
  | { kind: 'needs_pin' }
  | { kind: 'locked'; lock: 'permanent' | 'rate_limited'; retryAfter?: string };

/**
 * Inspect cookies + session row and return whether the caller is
 * authorised. Caller is responsible for translating each outcome to
 * an HTTP response.
 */
export async function checkSessionGuard(session: SessionRow): Promise<GuardResult> {
  const state: SessionPinState = {
    pin_hash: session.pin_hash,
    pin_attempts: session.pin_attempts ?? 0,
    pin_lockout_until: session.pin_lockout_until,
    pin_locked_at: session.pin_locked_at,
  };
  const gate = gateDecision(state);

  if (gate.kind === 'no_pin_required') {
    return { kind: 'ok', pinSet: false };
  }
  if (gate.kind === 'permanently_locked') {
    return { kind: 'locked', lock: 'permanent' };
  }
  if (gate.kind === 'rate_limited') {
    return { kind: 'locked', lock: 'rate_limited', retryAfter: gate.retryAfter };
  }

  // gate.kind === 'ready' — must present a valid cookie for this session.
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(PIN_COOKIE_NAME)?.value;
  const verification = verifySessionCookie(cookieValue);
  if (verification.valid && verification.sessionId === session.id) {
    return { kind: 'ok', pinSet: true };
  }
  return { kind: 'needs_pin' };
}
