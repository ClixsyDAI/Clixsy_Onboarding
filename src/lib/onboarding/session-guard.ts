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
import type { NextRequest } from 'next/server';
import { verifySessionCookie, PIN_COOKIE_NAME } from './pin-cookie';
import { gateDecision, type SessionPinState } from './pin';
import { isAmBypassRequest } from './am-bypass';

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

// =============================================================
// AM-bypass-aware access decision (Sprint 2 / #4)
// =============================================================
//
// Every public route shares ONE rule for how an AM-bypass signature
// interacts with the PIN guard, so a new route can't reinvent it wrong
// (this PR's own review found two routes that did). The rule, per the
// operator-locked matrix:
//
//   - A `locked` session is ALWAYS blocked. The bypass token skips the
//     PIN, NOT the brute-force / rate-limit protection — if a leaked
//     link is hammering a locked session it must stay blocked.
//   - `needs_pin` is waived ONLY under a valid bypass signature (that's
//     the whole point: the AM has no PIN cookie).
//   - The resulting `isAmBypass` flag travels with the decision so each
//     route gates its audit/tracking writes on it consistently.

export type AccessDecision =
  | { kind: 'ok'; pinSet: boolean; isAmBypass: boolean }
  | { kind: 'needs_pin' }
  | { kind: 'locked'; lock: 'permanent' | 'rate_limited'; retryAfter?: string };

/**
 * Pure decision: combine a GuardResult with whether the request carries
 * a valid bypass signature. Separated from I/O so the submit route —
 * which swaps checkSessionGuard for an in-memory test shim — can reuse
 * the exact same rule without going through the live guard.
 */
export function decideAccess(guard: GuardResult, isAmBypass: boolean): AccessDecision {
  if (guard.kind === 'locked') return guard; // lock always wins
  if (guard.kind === 'needs_pin') {
    return isAmBypass ? { kind: 'ok', pinSet: true, isAmBypass: true } : { kind: 'needs_pin' };
  }
  return { kind: 'ok', pinSet: guard.pinSet, isAmBypass };
}

/**
 * Convenience wrapper for routes that use the live guard: run
 * checkSessionGuard, read the bypass signature off the request, and
 * apply decideAccess. The session-load GET passes the signature via the
 * `am` query param; mutating routes via the x-am-bypass header —
 * isAmBypassRequest checks both.
 */
export async function resolveSessionAccess(
  session: SessionRow,
  request: NextRequest,
): Promise<AccessDecision> {
  const guard = await checkSessionGuard(session);
  // Skip the bypass-signature work entirely when the guard already says
  // ok-without-PIN — saves an HMAC on the common legacy-session path.
  const isAmBypass =
    guard.kind === 'locked' ? false : isAmBypassRequest(session.id, request);
  return decideAccess(guard, isAmBypass);
}
