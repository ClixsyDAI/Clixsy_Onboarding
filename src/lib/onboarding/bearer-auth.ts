// =============================================================
// bearer-auth — shared bearer-token gate for cross-repo endpoints
// =============================================================
//
// Phase 6 PR A step A1 (per phase-6-plan.md §4.1 + §5.1).
//
// The /api/admin/onboarding/sessions/[id]/* routes are reachable
// from any caller — the onboarding repo has no middleware. The
// workbook integration would deepen the existing exposure if it
// just called the unauthed endpoint, so we add a bearer-token
// gate here.
//
// Env-var shape:
//   SHARED_INTEGRATION_BEARER_TOKEN (Production-only)
//
// When SET: requests MUST carry `Authorization: Bearer ${token}`.
// When UNSET (local dev, preview): the gate is a no-op — the
// route behaves as it did before this PR. This avoids breaking
// preview / local development environments while closing the gap
// in Production.
//
// Same-process callers (the onboarding admin UI's Server Action)
// should NOT go through this gate — they call into
// rotate-pin.ts directly, no HTTP hop.

import type { NextRequest } from "next/server";

export type BearerCheck =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

export function checkBearerToken(request: NextRequest): BearerCheck {
  const expectedToken = process.env.SHARED_INTEGRATION_BEARER_TOKEN;

  // No env var configured → allow (dev / preview behaviour).
  if (!expectedToken) {
    return { kind: "allow" };
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return { kind: "deny", reason: "Missing Authorization header" };
  }
  if (authHeader !== `Bearer ${expectedToken}`) {
    return { kind: "deny", reason: "Invalid bearer token" };
  }
  return { kind: "allow" };
}
