// =============================================================
// IP hashing for onboarding_open_events
// =============================================================
//
// Migration 008's `onboarding_open_events.ip_hash` column stores a
// hashed IP, never a raw one (per Phase 1 plan §3.B and the spec's
// privacy note at line 140). This module owns the hashing logic.
//
// Hash = sha256(ip || secret), hex-encoded. Secret falls back from
// PIN_COOKIE_SECRET to SUPABASE_SERVICE_ROLE_KEY, mirroring
// src/lib/onboarding/pin-cookie.ts — same precedence so a future
// PIN_COOKIE_SECRET rotation also rotates the IP hash space.
//
// If neither env is configured we return null and the open event is
// inserted with a NULL ip_hash. Open events are best-effort; missing
// metadata is not a failure mode.

import crypto from 'node:crypto';

function getSalt(): string | null {
  const explicit = process.env.PIN_COOKIE_SECRET;
  if (explicit && explicit.length >= 32) return explicit;
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (fallback && fallback.length >= 32) return fallback;
  return null;
}

/**
 * Hash a request IP. Returns null if no IP is available, or if no
 * salt is configured (best-effort; caller stores NULL in that case).
 */
export function hashRequestIp(ip: string | null | undefined): string | null {
  if (!ip || typeof ip !== 'string') return null;
  const salt = getSalt();
  if (!salt) return null;
  // X-Forwarded-For can carry a comma-separated chain; the client IP
  // is the first entry. Normalise here so the same client always
  // hashes to the same value regardless of upstream proxy layering.
  const clientIp = ip.split(',')[0].trim();
  if (!clientIp) return null;
  return crypto
    .createHash('sha256')
    .update(`${clientIp}|${salt}`)
    .digest('hex');
}

/** Cap a user-agent string to a sane length before storage. */
export function capUserAgent(ua: string | null | undefined, maxLen = 512): string | null {
  if (!ua || typeof ua !== 'string') return null;
  const trimmed = ua.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}
