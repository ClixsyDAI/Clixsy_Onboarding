// =============================================================
// PIN module — generation, hashing, verification, lockout decisions
// =============================================================
//
// Uses Node's built-in crypto.scrypt. No external dependency.
// Hash format is self-describing — parameters can rotate without
// a schema change (just re-hash on next successful auth).
//
//   scrypt$<N>$<r>$<p>$<saltHex>$<derivedHex>
//
// Verification is constant-time via crypto.timingSafeEqual.

import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// Tuning notes
// ------------
//   N = 2^14 (16,384) is the libsodium "interactive" preset.
//   r = 8, p = 1 are the standard ratios.
//   Yields ~25 ms verify on a Vercel Fluid Compute warm instance,
//   ~50 ms cold. Adequate for a 6-digit PIN (entropy ≈ 20 bits)
//   gated behind both rate limit and permanent lock.
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

const PIN_DIGITS = 6;
// Largest power-of-10 still in the uniform sampling range below.
// 4 bytes = 32 bits = max 4,294,967,295 — plenty of headroom for
// the 1,000,000 buckets needed for a 6-digit PIN.
const PIN_MODULO = 10 ** PIN_DIGITS;

// Cumulative attempts after which we set pin_lockout_until.
export const PIN_RATE_LIMIT_THRESHOLD = 5;
// How far into the future pin_lockout_until is pushed.
export const PIN_RATE_LIMIT_DURATION_MS = 15 * 60 * 1000;
// Cumulative attempts after which pin_locked_at is set (permanent
// until admin intervenes).
export const PIN_PERMANENT_LOCK_THRESHOLD = 10;

/**
 * Generate a random 6-digit PIN, zero-padded.
 * Uses crypto.randomBytes for cryptographic randomness — never
 * Math.random.
 */
export function generatePin(): string {
  // Sample 4 random bytes. Reject samples that fall outside the
  // largest multiple of PIN_MODULO that fits in 32 bits, to keep
  // the distribution uniform. With PIN_MODULO=1e6, the rejection
  // band is microscopic so this loop almost always exits on the
  // first iteration.
  const maxValid = Math.floor(2 ** 32 / PIN_MODULO) * PIN_MODULO;
  for (;;) {
    const buf = crypto.randomBytes(4);
    const sample = buf.readUInt32BE(0);
    if (sample < maxValid) {
      return (sample % PIN_MODULO).toString().padStart(PIN_DIGITS, "0");
    }
    // Try again — rejection sampling.
  }
}

/**
 * Hash a PIN with scrypt. Returns a self-describing string that
 * encodes the parameters alongside the salt + derived key.
 */
export async function hashPin(pin: string): Promise<string> {
  if (!/^\d{6}$/.test(pin)) {
    throw new Error("hashPin: PIN must be exactly 6 digits");
  }
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(pin, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // scrypt's default maxmem is too small for these params.
    // 128 * N * r * p bytes is the working set; double it for safety.
    maxmem: 128 * SCRYPT_N * SCRYPT_R * SCRYPT_P * 2,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a plaintext PIN against a stored hash. Returns true on
 * match, false otherwise. Constant-time comparison.
 *
 * Tolerates ANY scheme-tagged scrypt hash this module has ever
 * written — parameters can rotate without invalidating old hashes.
 */
export async function verifyPin(
  pin: string,
  stored: string,
): Promise<boolean> {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, derivedHex] = parts;
  const N = Number.parseInt(nStr, 10);
  const r = Number.parseInt(rStr, 10);
  const p = Number.parseInt(pStr, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(derivedHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(pin, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * p * 2,
    });
  } catch {
    return false;
  }
  return (
    derived.length === expected.length &&
    crypto.timingSafeEqual(derived, expected)
  );
}

// =============================================================
// Lockout policy
// =============================================================
// Used by the (future) verify endpoint and by the admin "unlock"
// helper. The functions below DON'T touch the DB themselves — the
// caller is responsible for reading the current session state and
// writing the new state. This keeps the policy pure and unit-testable.

export type SessionPinState = {
  pin_hash: string | null;
  pin_attempts: number;
  pin_lockout_until: string | null; // ISO timestamp or null
  pin_locked_at: string | null;     // ISO timestamp or null
};

export type PinGateDecision =
  | { kind: "no_pin_required" }
  | { kind: "permanently_locked"; lockedAt: string }
  | { kind: "rate_limited"; retryAfter: string }
  | { kind: "ready" };

/**
 * Inspect a session's PIN state and decide whether we should
 * even ATTEMPT to verify the submitted PIN. Pure function — no
 * IO, no clock dependency beyond the caller-supplied `now`.
 */
export function gateDecision(
  state: SessionPinState,
  now: Date = new Date(),
): PinGateDecision {
  if (state.pin_hash === null) return { kind: "no_pin_required" };
  if (state.pin_locked_at !== null) {
    return { kind: "permanently_locked", lockedAt: state.pin_locked_at };
  }
  if (state.pin_lockout_until !== null) {
    const until = new Date(state.pin_lockout_until);
    if (until.getTime() > now.getTime()) {
      return { kind: "rate_limited", retryAfter: state.pin_lockout_until };
    }
  }
  return { kind: "ready" };
}

export type PinStateUpdate = {
  pin_attempts: number;
  pin_lockout_until: string | null;
  pin_locked_at: string | null;
};

/**
 * Given a current session state and the outcome of a verify, compute
 * the next state to write back. Returns the diff to apply.
 *
 *   verifyResult = true  → reset attempts + clear both lockouts
 *   verifyResult = false → increment attempts; set rolling lockout
 *                          if we crossed RATE_LIMIT_THRESHOLD;
 *                          set permanent lock if we crossed
 *                          PERMANENT_LOCK_THRESHOLD.
 */
export function nextStateAfterAttempt(
  current: SessionPinState,
  verifyResult: boolean,
  now: Date = new Date(),
): PinStateUpdate {
  if (verifyResult) {
    return {
      pin_attempts: 0,
      pin_lockout_until: null,
      pin_locked_at: null,
    };
  }

  const newAttempts = current.pin_attempts + 1;

  let lockout_until: string | null = current.pin_lockout_until;
  let locked_at: string | null = current.pin_locked_at;

  // Cross the temporary-lockout threshold every 5 attempts up to
  // (but not including) the permanent threshold. After 10 we go
  // permanent — no more rolling lockouts needed.
  if (
    newAttempts < PIN_PERMANENT_LOCK_THRESHOLD &&
    newAttempts % PIN_RATE_LIMIT_THRESHOLD === 0
  ) {
    lockout_until = new Date(
      now.getTime() + PIN_RATE_LIMIT_DURATION_MS,
    ).toISOString();
  }

  if (newAttempts >= PIN_PERMANENT_LOCK_THRESHOLD && locked_at === null) {
    locked_at = now.toISOString();
  }

  return {
    pin_attempts: newAttempts,
    pin_lockout_until: lockout_until,
    pin_locked_at: locked_at,
  };
}

/**
 * Compute the state diff for an admin-triggered "unlock" action.
 * Zeros all PIN-failure state but does NOT rotate the hash.
 * Used by the session-detail "Unlock session" button.
 */
export function adminUnlockUpdate(): PinStateUpdate {
  return {
    pin_attempts: 0,
    pin_lockout_until: null,
    pin_locked_at: null,
  };
}
