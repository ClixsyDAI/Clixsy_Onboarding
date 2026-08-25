// =============================================================
// pin-envelope-write - the write-time half of PIN recovery
// =============================================================
//
// One function, called from every point a PIN comes into existence:
//
//   1. POST /api/admin/onboarding/create, which mints the first PIN
//      inline and does NOT go through rotatePin.
//   2. rotatePin() in ./rotate-pin.ts, which covers BOTH regenerate
//      entry points (the bearer-gated route and regeneratePinAction()
//      in ./admin-actions.ts).
//
// It exists so the fail-open decision below is stated once instead of
// once per call site. Two copies of a policy comment is two copies to
// keep in sync, and the site that gets forgotten is the one that then
// behaves differently under load.
//
// THE DECISION: encryption failure must NOT fail the write
// -------------------------------------------------------
// pin_hash is the gate. A session whose PIN hashed fine but failed to
// encrypt is completely usable: the client signs in with that PIN
// exactly as before. The only loss is that an admin later sees "PIN
// cannot be shown, regenerate it" (state b in migration 011) instead
// of the PIN. That is the same answer every pre-existing session
// already gives, so failing open costs a convenience this feature
// adds and nothing that existed before it.
//
// Throwing instead would trade that convenience for reachable damage
// at both call sites. The most likely cause by far is an unset or
// mistyped PIN_ENCRYPTION_KEY on one deployment, which means the
// damage would be total for that deployment, not occasional:
//
//   - In the create route it would 500 EVERY onboarding-session
//     creation. One of those callers is the GoHighLevel webhook
//     receiver, which answers HTTP 200 to GHL no matter what the
//     create call returned, so nothing retries and nothing alerts:
//     clients silently never get a session. That exact
//     half-created-silently failure is the bug the create route's own
//     vertical 'other' comment was written about, and a required
//     encryption step would reintroduce it for every vertical at once.
//
//   - In rotatePin it would block PIN rotation outright, at both entry
//     points. Rotation is also the ONLY way to clear a PIN lockout: it
//     is what resets pin_attempts, pin_lockout_until and pin_locked_at.
//     So a locked-out client could not be unblocked at all, because of
//     an optional convenience feature's env var. Note that the harm
//     there is NOT a mid-rotation lockout: rotatePin encrypts before
//     it updates, and writes pin_hash and pin_envelope in one
//     statement, so a throw would land before any write and the old
//     PIN would keep working. Anyone making rotation strict later must
//     preserve that order, or the harmless failure becomes a real one.
//
// So it fails open, and pays for that by being loud on channels that
// outlive a log line, because "the PIN cannot be shown" is
// indistinguishable in the data from a pre-011 row:
//
//   - console.error with the session id (the Vercel runtime log).
//   - a durable audit row at each call site: pin_envelope_write_failed
//     from the create route, and pin_encryption_error_code on the
//     pin_rotated event from rotatePin. Migration 011's POST-APPLY
//     CHECK 5 is the query that finds both.
//
// It deliberately cannot be loud in the RESPONSE: no existing response
// shape may grow a field, so neither the create route's body nor
// RotatePinResult reports this.
//
// The PIN is never logged here. Only whether an envelope came out.

import {
  encryptPin,
  isPinEncryptionError,
  type PinEncryptionErrorCode,
} from "./pin-encryption";

// "unknown" is a real, distinct outcome and not padding: without it,
// a non-typed throw would record the same null code as a success, and
// the audit row could not tell "encrypted fine" from "something we
// have never seen went wrong".
export type PinEnvelopeWriteErrorCode = PinEncryptionErrorCode | "unknown";

export type PinEnvelopeWriteOutcome = {
  /**
   * The envelope to store, or null to leave the column NULL, which is
   * state (b): PIN gated but unrecoverable. Callers must write this
   * value THROUGH to the column even when it is null, never omit the
   * column, or a rotation leaves the previous envelope in place and
   * the retrieval endpoint later hands out a PIN that no longer works.
   */
  envelope: string | null;
  /**
   * Which class of failure, for the audit payload. Null on success.
   * Callers must not discard this: it is the only channel that
   * survives log retention, and the failure it reports is silent by
   * design in every other direction.
   */
  errorCode: PinEnvelopeWriteErrorCode | null;
};

export function encryptPinForStorage(
  pin: string,
  sessionId: string,
): PinEnvelopeWriteOutcome {
  try {
    return { envelope: encryptPin(pin), errorCode: null };
  } catch (err) {
    // Catch EVERYTHING, not just PinEncryptionError. A throw from
    // crypto.createCipheriv itself (an OpenSSL build without GCM, a
    // FIPS-mode process) is not one of the typed errors, and letting
    // that single case escape would reintroduce exactly the
    // create-route 500 and the blocked rotation described above, for
    // the one failure nobody tested.
    const errorCode: PinEnvelopeWriteErrorCode = isPinEncryptionError(err)
      ? err.code
      : "unknown";

    console.error(
      `[pin-envelope] failed to encrypt PIN for session ${sessionId}, ` +
        `pin_envelope left NULL so this PIN can never be shown again ` +
        `(code: ${errorCode}). The PIN itself still works, pin_hash is ` +
        `the gate. Fix: ${
          errorCode === "configuration"
            ? "set PIN_ENCRYPTION_KEY to canonical base64 of 32 random bytes"
            : "investigate below, then regenerate the PIN to repopulate"
        }. ${err instanceof Error ? err.message : String(err)}`,
    );

    return { envelope: null, errorCode };
  }
}
