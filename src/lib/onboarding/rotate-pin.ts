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
//      ./regenerate-pin-action.ts — the same-process entry point.
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
//   - pin_attempts reset to 0
//   - pin_lockout_until cleared
//   - pin_locked_at cleared
//
// The plaintext PIN is returned ONCE in the result. Callers are
// responsible for not logging it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { generatePin, hashPin } from "./pin";

export type RotatePinResult =
  | { kind: "ok"; pin: string }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export async function rotatePin(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<RotatePinResult> {
  const { data: existing, error: existingErr } = await supabase
    .from("onboarding_sessions")
    .select("id")
    .eq("id", sessionId)
    .single();

  if (existingErr || !existing) {
    return { kind: "not_found" };
  }

  const pin = generatePin();
  const pinHash = await hashPin(pin);

  const { error: updateErr } = await supabase
    .from("onboarding_sessions")
    .update({
      pin_hash: pinHash,
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

  return { kind: "ok", pin };
}
