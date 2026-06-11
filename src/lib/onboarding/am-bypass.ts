// =============================================================
// AM bypass token — sign / verify (Sprint 2, #4)
// =============================================================
//
// An account manager opens a client's onboarding session through a
// signed link when auto-prefill fails and they need to fill the form
// on the client's behalf. Semantics (operator-locked matrix):
//
//   - PIN entry is skipped (the signature IS the authorisation)
//   - form writes save as REAL data, identical to a client session
//   - ZERO audit/tracking events fire (session_accessed,
//     onboarding_open_events, step_saved, session_submitted)
//   - the welcome wizard / popups never render
//   - mark-welcome-seen no-ops so the AM never consumes the client's
//     first-time UX
//
// Shape: the link is /onboarding/<token>?am=<sig> where
// sig = HMAC-SHA256(secret, "am-bypass.<sessionId>"). Domain-separated
// from the PIN cookie HMAC (same secret, different prefix) so a PIN
// cookie can never double as a bypass signature or vice versa. No
// expiry — the bypass link lives exactly as long as the session link
// it wraps; revoking the session revokes both.
//
// Client-side the signature travels back on every mutating request as
// the `x-am-bypass` header; each route re-verifies server-side. The
// flag is therefore proven per-request — a client can't forge it by
// flipping a boolean in the page payload.

import crypto from 'node:crypto';
import { getCookieSecret } from './pin-cookie';

export const AM_BYPASS_PARAM = 'am';
export const AM_BYPASS_HEADER = 'x-am-bypass';

function hmac(input: string): string {
  return crypto
    .createHmac('sha256', getCookieSecret())
    .update(input)
    .digest('base64url');
}

/** Signature for an AM bypass link/header for the given session. */
export function signAmBypass(sessionId: string): string {
  return hmac(`am-bypass.${sessionId}`);
}

/** Timing-safe verification of a provided bypass signature. */
export function verifyAmBypass(
  sessionId: string,
  provided: string | null | undefined,
): boolean {
  if (!provided || !sessionId) return false;
  const expected = signAmBypass(sessionId);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
