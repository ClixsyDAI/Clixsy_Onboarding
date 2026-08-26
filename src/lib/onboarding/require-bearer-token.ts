import crypto from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * FAIL-CLOSED bearer check, for routes that hand back a credential.
 *
 * WHY THIS EXISTS INSTEAD OF checkBearerToken. The existing
 * `checkBearerToken` in bearer-auth.ts ALLOWS the request when
 * SHARED_INTEGRATION_BEARER_TOKEN is unset:
 *
 *     // No env var configured -> allow (dev / preview behaviour).
 *     if (!expectedToken) return { kind: "allow" };
 *
 * That is deliberate and correct for the webhook and bridge routes it guards,
 * where an unconfigured preview should still function. It is exactly wrong for a
 * route that returns a client's PIN in plaintext: an unset variable would turn
 * the endpoint into an unauthenticated credential oracle, and the failure would
 * be invisible because everything would appear to work.
 *
 * bearer-auth.ts is a protected file on this branch and is not modified. This is
 * a separate, deliberately stricter check, and the two must not be confused: if
 * you are guarding a credential, use this one.
 *
 * OUTCOMES, and they are three rather than two on purpose:
 *   unconfigured -> 503. A deployment fault, not the caller's. It must never be
 *                   reported as 401, because a 401 tells an integrator their
 *                   token is wrong and sends them to rotate a perfectly good one.
 *   absent/wrong -> 401. The caller's fault.
 *   match        -> allow.
 *
 * The comparison is timing-safe. `checkBearerToken` uses `!==`, which is fine for
 * a shared integration token on a webhook, but this route returns a credential
 * and there is no reason to leak a prefix-match oracle when the fix is three
 * lines. Length is compared first because timingSafeEqual throws on a length
 * mismatch, and length is not a secret.
 */
export type BearerOutcome =
  | { ok: true }
  | { ok: false; status: 503; reason: "bearer_token_not_configured" }
  | { ok: false; status: 401; reason: "missing_authorization_header" | "invalid_bearer_token" };

export function requireBearerToken(request: NextRequest): BearerOutcome {
  const expected = process.env.SHARED_INTEGRATION_BEARER_TOKEN;

  // Trimmed and length-checked, not just truthy: an env var set to an empty
  // string or to whitespace is a misconfiguration that a truthiness test reads
  // as configured, and would then compare against "Bearer " plus nothing.
  if (typeof expected !== "string" || expected.trim().length === 0) {
    return { ok: false, status: 503, reason: "bearer_token_not_configured" };
  }

  const header = request.headers.get("Authorization");
  if (!header) {
    return { ok: false, status: 401, reason: "missing_authorization_header" };
  }

  const presented = Buffer.from(header, "utf8");
  const wanted = Buffer.from(`Bearer ${expected.trim()}`, "utf8");
  if (presented.length !== wanted.length) {
    return { ok: false, status: 401, reason: "invalid_bearer_token" };
  }
  if (!crypto.timingSafeEqual(presented, wanted)) {
    return { ok: false, status: 401, reason: "invalid_bearer_token" };
  }
  return { ok: true };
}
