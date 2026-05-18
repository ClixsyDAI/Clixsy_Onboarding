// =============================================================
// PIN session cookie — sign / verify / serialise
// =============================================================
//
// One cookie per browser identifies the session the user has
// successfully PIN-verified for. HMAC-signed so the value can't
// be forged client-side; tied to the session ID so a cookie from
// one session can't unlock another.
//
//   name:    cob_pin
//   value:   <sessionId>.<issuedAtMillis>.<hmacB64url>
//   path:    /
//   age:     30 days
//   flags:   HttpOnly; SameSite=Lax; Secure (production only)
//
// Re-issued on every successful verify so an idle-but-extended
// visitor doesn't get logged out mid-form.
//
// Pure functions — the route handlers do the cookie I/O themselves
// via the next/headers `cookies()` helper. Keeps unit testing easy
// and the cookie shape in one place.

import crypto from 'node:crypto';

export const PIN_COOKIE_NAME = 'cob_pin';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Derive the HMAC key. Prefers a dedicated env var; falls back to the
 * service-role key (already secret, already server-only) so dev / preview
 * work without an extra configuration step. Production deployments should
 * set PIN_COOKIE_SECRET explicitly to allow future rotation independent
 * of the Supabase key.
 */
function getCookieSecret(): string {
  const explicit = process.env.PIN_COOKIE_SECRET;
  if (explicit && explicit.length >= 32) return explicit;
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!fallback) {
    throw new Error(
      'PIN cookie secret unavailable: set PIN_COOKIE_SECRET or SUPABASE_SERVICE_ROLE_KEY'
    );
  }
  return fallback;
}

function hmac(input: string): string {
  return crypto
    .createHmac('sha256', getCookieSecret())
    .update(input)
    .digest('base64url');
}

/** Build the cookie value string for a freshly-verified session. */
export function signSessionCookie(sessionId: string, now: Date = new Date()): string {
  const issuedAt = now.getTime();
  const payload = `${sessionId}.${issuedAt}`;
  return `${payload}.${hmac(payload)}`;
}

export type CookieVerification =
  | { valid: true; sessionId: string; issuedAt: number }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a cookie value. Returns the session ID it claims to be for
 * on success. Caller is responsible for checking that the claimed
 * session ID matches the session the user is trying to access.
 */
export function verifySessionCookie(
  value: string | undefined | null,
  now: Date = new Date(),
): CookieVerification {
  if (!value) return { valid: false, reason: 'malformed' };
  const parts = value.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [sessionId, issuedAtRaw, sig] = parts;
  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (!sessionId || !Number.isFinite(issuedAt)) {
    return { valid: false, reason: 'malformed' };
  }
  const expected = hmac(`${sessionId}.${issuedAt}`);
  if (sig.length !== expected.length) {
    return { valid: false, reason: 'bad_signature' };
  }
  const sigOk = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!sigOk) return { valid: false, reason: 'bad_signature' };
  const ageMs = now.getTime() - issuedAt;
  if (ageMs < 0 || ageMs > COOKIE_MAX_AGE_SECONDS * 1000) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, sessionId, issuedAt };
}

/** Serialised cookie options for `cookies().set(...)`. */
export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
}
