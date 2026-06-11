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

import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { adminUnlockUpdate } from "./pin";
import { rotatePin } from "./rotate-pin";
import { signAmBypass } from "./am-bypass";

/**
 * Server Actions are publicly-invocable POST endpoints: Next resolves
 * them by action-id from a global manifest regardless of which route
 * receives the POST, so the /admin/* proxy matcher does NOT gate them.
 * Every action here mints or mutates privileged state (PINs, unlock,
 * bypass links), so each must authenticate the caller itself. This
 * re-derives the same admin_token cookie the proxy checks
 * (sha256("<ADMIN_PASSWORD>:<ADMIN_SESSION_SECRET>")) and fails closed
 * when either env var is unset — never granting access via a default.
 */
async function isAdmin(): Promise<boolean> {
  const pw = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!pw || !secret) return false;
  const expected = createHash("sha256").update(`${pw}:${secret}`).digest("hex");
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_token")?.value;
  return Boolean(token && token === expected);
}

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
  if (!(await isAdmin())) return { ok: false, error: "Not authorised" };
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
  if (!(await isAdmin())) return { ok: false, error: "Not authorised" };
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

export type AmBypassLinkResult =
  | { ok: true; token: string; sig: string }
  | { ok: false; error: string };

/**
 * Sprint 2 / #4: mint the AM-bypass link parts for a session. The
 * signature must be computed server-side (HMAC secret); the client
 * assembles `${origin}/onboarding/${token}?am=${sig}`. Server Action so
 * the admin UI gets it without a bearer-gated route — same Phase 6 PR A
 * rationale as the PIN actions above.
 */
export async function getAmBypassLinkAction(
  sessionId: string,
): Promise<AmBypassLinkResult> {
  if (!(await isAdmin())) return { ok: false, error: "Not authorised" };
  const supabase = createServiceRoleClient();

  const { data: session, error } = await supabase
    .from("onboarding_sessions")
    .select("id, token")
    .eq("id", sessionId)
    .single();

  if (error || !session) {
    return { ok: false, error: "Session not found" };
  }

  return { ok: true, token: session.token, sig: signAmBypass(session.id) };
}
