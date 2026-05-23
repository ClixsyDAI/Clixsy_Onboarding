// =============================================================
// Onboarding repo auth gate — Phase 9 emergency hotfix
// =============================================================
//
// Closes the PII exposure documented in phase-9-discovery.md §2:
// /api/admin/onboarding/sessions{,/[id]} both return the full
// session payload (joined with clients PII) without any auth
// check. /admin/onboarding/sessions{,/[id]} render the same data
// in the browser. Same shape as the workbook's pre-Phase-8 state.
//
// Closes by adding the same proxy gate shape the workbook
// shipped in PR #20 (workbook repo), with the four lessons from
// PRs #17-#20 baked in:
//   1. The matcher export MUST be named `config`, not
//      `proxyConfig` — Next.js 16's static analyser ignores any
//      other name (workbook PR #17 redirect-loop regression).
//   2. In-function allowlist short-circuits BEFORE auth — even
//      if the matcher misregisters, /admin/login + /api/admin/auth
//      can never reach the redirect branch. Belt-and-braces.
//   3. Loop-detection assertion throws if /admin/login ever
//      reaches the redirect branch (would otherwise produce a
//      silent /admin/login → /admin/login infinite loop).
//   4. NO env-var defaults. If ADMIN_PASSWORD or ADMIN_SESSION_SECRET
//      is unset, computeExpectedCookie() returns null and the
//      cookie comparison always fails — fail closed.
//
// Auth model (per Phase 9 discovery decision 1 — option B):
//   Cookie OR Bearer at the proxy. Either:
//     - `admin_token` cookie matches
//       sha256(ADMIN_PASSWORD + ":" + ADMIN_SESSION_SECRET)
//     - `Authorization: Bearer <SHARED_INTEGRATION_BEARER_TOKEN>`
//   Bearer-gated routes (regenerate-pin, unlock) keep their
//   in-handler bearer check as a second layer — they're called
//   cross-repo by the workbook with the bearer header, which now
//   passes the proxy via the OR branch.
//
// Cookie issuance lives in src/app/api/admin/auth/route.ts
// (POST sign-in + GET validate). Login UI at /admin/login.

import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

// Matcher: only paths under /admin and /api/admin hit this proxy.
// Public form (/onboarding/[token]), /api/public/*, /, /favicon.ico,
// /_next/* never touch the proxy. Their own auth (if any) applies.
//
// IMPORTANT: This export MUST be named `config`. Next.js 16's
// static analyser ignores any other name (e.g. `proxyConfig`),
// which would silently make the proxy run on every path — the
// exact PR #17 regression on the workbook repo.
export const config = {
  matcher: [
    "/admin/:path*",
    "/api/admin/:path*",
  ],
};

// In-function allowlist — paths inside the matcher's scope that
// must short-circuit BEFORE the cookie/bearer check. Belt-and-
// braces against the matcher misregistering. If the `config`
// export ever silently fails, these paths still pass through
// at the top of the function — /admin/login can never enter the
// redirect branch.
const ALLOW_EXACT = new Set<string>([
  "/admin/login",
  "/api/admin/auth",
]);

const ALLOW_PREFIXES: readonly string[] = [
  "/admin/login/",
  "/api/admin/auth/",
];

function isAllowListed(path: string): boolean {
  if (ALLOW_EXACT.has(path)) return true;
  for (const prefix of ALLOW_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

// Cookie expected-value derivation. Returns null if either env
// var is unset — caller treats null as "no match" so the gate
// fails closed. NO fallback defaults: a misconfigured environment
// would otherwise grant access via a known-plaintext default,
// which is the worst possible failure mode.
function computeExpectedCookie(): string | null {
  const pw = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!pw || !secret) return null;
  return createHash("sha256").update(`${pw}:${secret}`).digest("hex");
}

// Bearer check. Mirrors src/lib/onboarding/bearer-auth.ts shape:
// returns false (not "allow") when the env var is unset. This is
// stricter than bearer-auth.ts's behaviour by design — bearer-auth
// is a per-route gate that may be no-op in dev; the proxy is the
// outer perimeter and should never be a no-op in production.
function bearerMatches(req: NextRequest): boolean {
  const expected = process.env.SHARED_INTEGRATION_BEARER_TOKEN;
  if (!expected) return false;
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return false;
  return authHeader === `Bearer ${expected}`;
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // Layer 1: explicit allowlist short-circuit. Authoritative even
  // if the matcher misfires. /admin/login + /api/admin/auth can
  // never reach the redirect branch from here.
  if (isAllowListed(path)) {
    return NextResponse.next();
  }

  // Layer 2: cookie OR bearer.
  const cookie = req.cookies.get("admin_token")?.value;
  const expected = computeExpectedCookie();
  if (expected && cookie && cookie === expected) {
    return NextResponse.next();
  }
  if (bearerMatches(req)) {
    return NextResponse.next();
  }

  // Unauthorized API calls return 401 JSON — fetch clients can
  // surface the error inline rather than chasing a redirect.
  if (path.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Layer 3: loop-detection assertion. If we somehow reach the
  // redirect branch with /admin/login as the path, the allowlist
  // failed — refuse to ship the redirect rather than send the
  // user into a /admin/login → /admin/login loop. Surfaces the
  // bug as a 500 (visible) instead of a silent infinite redirect.
  if (path === "/admin/login" || path.startsWith("/admin/login/")) {
    throw new Error(
      `proxy.ts loop-detection: ${path} reached the redirect-to-/admin/login branch. ` +
      `The allowlist should have short-circuited this path. Refusing to redirect ` +
      `to prevent a /admin/login → /admin/login loop.`,
    );
  }

  // Page request — redirect to the login page. 307 preserves
  // method on redirect (GET stays GET; POST stays POST). No
  // return-URL handling in this emergency PR; AMs landing on
  // /admin/onboarding/sessions after sign-in is the universal
  // need (decision 4 in pre-work).
  const loginUrl = new URL("/admin/login", req.url);
  return NextResponse.redirect(loginUrl, 307);
}
