"use server";

// =============================================================
// admin-actions — Server Actions for the onboarding admin UI
// =============================================================
//
// Phase 6 PR A step A1 per phase-6-plan.md §5.2 (plus the unlock
// gap-fill called out in the commit history).
//
// The admin UI at /admin/onboarding/sessions/[id] used to call
// the /api/admin/onboarding/sessions/[id]/regenerate-pin and
// /unlock routes directly from the browser. PR A gates those
// routes behind a bearer-token check
// (SHARED_INTEGRATION_BEARER_TOKEN) so the cross-repo workbook
// integration can call them safely.
//
// To keep the admin UI working without leaking the bearer token
// into the browser bundle, the UI now invokes these Server
// Actions instead. They run server-side in the same Next.js
// process, share the underlying logic with the route handlers
// (rotatePin lives in rotate-pin.ts; the unlock update is small
// enough to inline here), and never go through the bearer gate
// because they don't traverse the public HTTP interface.

import { createServiceRoleClient } from "@/lib/supabase/server";
import { adminUnlockUpdate } from "./pin";
import { rotatePin } from "./rotate-pin";

export type RegeneratePinActionResult =
  | { ok: true; pin: string }
  | { ok: false; error: string };

/**
 * Server Action wrapper around rotatePin(). Used by the admin
 * UI's "Regenerate PIN" button. Same canonical logic as the
 * cross-repo POST endpoint — they both call rotate-pin.ts.
 */
export async function regeneratePinAction(
  sessionId: string,
): Promise<RegeneratePinActionResult> {
  const supabase = createServiceRoleClient();
  const result = await rotatePin(supabase, sessionId);

  if (result.kind === "ok") return { ok: true, pin: result.pin };
  if (result.kind === "not_found") {
    return { ok: false, error: "Session not found" };
  }
  return { ok: false, error: result.message };
}

export type UnlockActionResult =
  | { ok: true; note?: string }
  | { ok: false; error: string };

/**
 * Server Action wrapper for the admin UI's "Unlock session"
 * button. Mirrors the route handler at unlock/route.ts but
 * runs in-process so it doesn't need a bearer token.
 *
 * The logic is small enough to inline rather than extracting a
 * shared helper — if a future caller needs the same update
 * elsewhere, extract then.
 */
export async function unlockSessionAction(
  sessionId: string,
): Promise<UnlockActionResult> {
  const supabase = createServiceRoleClient();

  const { data: existing, error: existingErr } = await supabase
    .from("onboarding_sessions")
    .select("id, pin_hash")
    .eq("id", sessionId)
    .single();

  if (existingErr || !existing) {
    return { ok: false, error: "Session not found" };
  }

  if (existing.pin_hash === null) {
    return {
      ok: true,
      note: "Session has no PIN configured; nothing to unlock.",
    };
  }

  const update = adminUnlockUpdate();
  const { error: updateErr } = await supabase
    .from("onboarding_sessions")
    .update(update)
    .eq("id", sessionId);

  if (updateErr) {
    return {
      ok: false,
      error: `Failed to unlock session: ${updateErr.message}`,
    };
  }

  return { ok: true };
}
