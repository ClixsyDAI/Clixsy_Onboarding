// =============================================================
// rotate-pin — canonical PIN-rotation helper
// =============================================================
//
// Phase 6 PR A step A1 (per phase-6-plan.md §5.2).
//
// Single source of truth for "rotate a session's PIN". Called
// from two entry points in this repo:
//
//   1. POST /api/admin/onboarding/sessions/[id]/regenerate-pin
//      — the cross-repo entry point. Gated by bearer-token auth.
//      Used by the workbook integration (and any other external
//      caller authorised with the shared token).
//
//   2. regeneratePinAction() Server Action in
//      ./admin-actions.ts, the same-process entry point.
//      Used by the onboarding admin UI at /admin/onboarding/sessions/[id].
//      No bearer required because it runs server-side in the same
//      Next.js process.
//
// Both entry points construct a service-role Supabase client and
// call rotatePin(supabase, sessionId). The logic that actually
// touches the database lives here so changes (params, columns,
// error shape) happen in exactly one place.
//
// Side effects on success:
//   - new PIN generated, hashed, stored
//   - reversible copy stored in pin_envelope (best effort, see below)
//   - pin_attempts reset to 0
//   - pin_lockout_until cleared
//   - pin_locked_at cleared
//   - a pin_rotated audit event written (best effort, see below)
//
// The plaintext PIN is returned ONCE in the result. Callers are
// responsible for not logging it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generatePin, hashPin } from "./pin";
import { encryptPinForStorage } from "./pin-envelope-write";

export type RotatePinResult =
  | { kind: "ok"; pin: string }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

// The pin_* state as it was BEFORE this rotation. Selected (rather
// than just probing that the row exists) purely so the audit event can
// say what the rotation actually changed. Typed here because the
// SupabaseClient parameter carries no schema generic, so the row would
// otherwise be untyped at every use below.
type PreviousPinState = {
  id: string;
  pin_hash: string | null;
  pin_attempts: number | null;
  pin_lockout_until: string | null;
  pin_locked_at: string | null;
};

export async function rotatePin(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<RotatePinResult> {
  const { data: existing, error: existingErr } = await supabase
    .from("onboarding_sessions")
    .select("id, pin_hash, pin_attempts, pin_lockout_until, pin_locked_at")
    .eq("id", sessionId)
    .single();

  if (existingErr || !existing) {
    return { kind: "not_found" };
  }

  const previous = existing as PreviousPinState;

  const pin = generatePin();
  const pinHash = await hashPin(pin);

  // Reversible copy so a later admin can be shown THIS PIN instead of
  // being forced to rotate again. Never throws: see the fail-open
  // rationale in ./pin-envelope-write.ts. A null envelope here means
  // the rotation still succeeds and the session lands in state (b),
  // "PIN gated but unrecoverable", exactly like a pre-migration row.
  // errorCode is carried down to the audit event below, which is the
  // only record of that outcome once the server log ages out.
  //
  // Deliberately BEFORE the update, so hash and envelope go in one
  // statement and there is no window where a new pin_hash is live
  // beside the previous rotation's envelope. Keep that order if this
  // is ever made strict: encrypting after the update would turn a
  // harmless failure into an abandoned session whose old PIN is dead
  // and whose new PIN was never returned to anyone.
  const { envelope, errorCode } = encryptPinForStorage(pin, sessionId);

  const { error: updateErr } = await supabase
    .from("onboarding_sessions")
    .update({
      pin_hash: pinHash,
      // Written unconditionally, INCLUDING when it is null. Omitting
      // the column on encryption failure would leave the PREVIOUS
      // rotation's envelope in place, which still decrypts cleanly
      // (correct key, valid auth tag) to a PIN that no longer opens
      // the session. The retrieval endpoint would then hand an admin a
      // confidently wrong PIN, which is worse than telling them the
      // PIN cannot be read: they would read it to the client and both
      // sides would blame the client's typing.
      pin_envelope: envelope,
      pin_attempts: 0,
      pin_lockout_until: null,
      pin_locked_at: null,
    })
    .eq("id", sessionId);

  if (updateErr) {
    return {
      kind: "error",
      message: `Failed to rotate PIN: ${updateErr.message}`,
    };
  }

  // Rotations were previously unlogged entirely: a client's PIN could
  // change with no record of when, or through which of the two entry
  // points. Written AFTER the update, and wrapped, because the
  // rotation has already committed by this line. Turning a committed
  // rotation into an error return would abandon a session whose old
  // PIN is dead and whose new PIN was never handed back to anyone.
  //
  // This is the codebase's usual never-throw audit posture (see
  // safeAudit in ./dashboard-bridge.ts), and the deliberate OPPOSITE
  // of the PIN retrieval endpoint, which fails closed on its audit.
  // The difference is what the audit row is for: here it is a record
  // of a change that is already durable, there it is the only record
  // that a plaintext PIN was disclosed to someone, so a disclosure
  // that could not be logged must not happen at all.
  //
  // Written INLINE with the insert error checked, NOT through
  // createAuditEvent. That helper does
  // `await supabase.from(...).insert(...)` and never reads `.error`,
  // and postgrest-js resolves an RLS denial, an FK violation, a PGRST
  // schema-cache miss, a 5xx and a network failure all into a resolved
  // `{ error }` object rather than a rejection. So routing this
  // through it means a try/catch catches only the client construction,
  // and the insert can fail without throwing and without logging.
  //
  // That matters more here than anywhere else in this file. Three
  // lines up, this row is described as the only record of the outcome
  // once the server log ages out. If it can vanish silently, then a
  // deployment with PIN_ENCRYPTION_KEY unset rotates a PIN, stores no
  // envelope, loses the audit row, and a later census query returns
  // zero rows: indistinguishable from a deployment that never had a
  // problem. The operator then regenerates again, burning a second
  // live client PIN, and produces a second unrecorded failure. The
  // create route names this same hazard and routes around it; this
  // path used to walk into it.
  //
  // Note the coupling that makes it worse: the durable channel fails
  // for the same infrastructure reasons as the thing it is recording.
  //
  // It still must NOT throw. The rotation has already committed and
  // the new PIN is live in the caller's hand; failing here would
  // report a failure for work that succeeded. Loud, not fatal.
  try {
    const { error: auditError } = await supabase
      .from("onboarding_audit_events")
      .insert({
        session_id: sessionId,
        event_type: "pin_rotated",
        payload: {
          // NEVER the PIN and NEVER the envelope. This table is
          // readable by anything holding the service role, a far wider
          // set than the callers allowed to see a plaintext PIN, so
          // putting either one here would quietly undo the whole point
          // of gating retrieval. Only booleans, a count, and a fixed
          // vocabulary error code go in, so there is no free-text
          // field a secret could reach.
          had_previous_pin: previous.pin_hash !== null,
          cleared_lock:
            previous.pin_locked_at !== null ||
            previous.pin_lockout_until !== null,
          previous_failed_attempts: previous.pin_attempts ?? 0,
          pin_envelope_written: envelope !== null,
          pin_encryption_error_code: errorCode,
        },
      });

    if (auditError) {
      console.error(
        `[rotate-pin] pin_rotated audit INSERT REJECTED for session ` +
          `${sessionId}, the rotation itself SUCCEEDED and the new PIN is ` +
          `live. This session's rotation is now absent from ` +
          `onboarding_audit_events, so a census over that table will ` +
          `under-report. envelope_written=${envelope !== null} ` +
          `encryption_error=${errorCode ?? "none"}: ${auditError.message}`,
      );
    }
  } catch (err) {
    console.error(
      `[rotate-pin] pin_rotated audit threw for session ${sessionId}, ` +
        `the rotation itself SUCCEEDED and the new PIN is live: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { kind: "ok", pin };
}
