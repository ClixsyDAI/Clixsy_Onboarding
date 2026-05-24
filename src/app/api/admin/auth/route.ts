// =============================================================
// POST /api/admin/auth  +  GET /api/admin/auth
// =============================================================
//
// Phase 9 emergency hotfix — onboarding repo admin auth endpoint.
//
// Two handlers sharing one expected-token derivation. Cookie
// issuance lives here; cookie validation also lives here. The
// proxy (/proxy.ts at repo root) does the perimeter check on
// every /admin/* and /api/admin/* request.
//
// Auth shape mirrors the workbook's /api/admin/auth pattern
// (Phase 8 PR #20) so future cross-repo work can rely on the
// same primitive — but with two important differences:
//
//   1. POST returns ONLY `{ ok: true }` (no token in the body).
//      The cookie is the single source of truth. There's no
//      sessionStorage shadow store on the client. Cleaner trust
//      model: a credential never reaches the browser bundle as
//      readable text, and we can't accidentally log it.
//
//   2. GET validates the cookie directly (no `?token=` query
//      param). The client never sees the token, so it can't
//      send it. The cookie IS the auth state.
//
// NO env-var fallback defaults. If ADMIN_PASSWORD or
// ADMIN_SESSION_SECRET is unset, both handlers return 500
// "Server misconfigured" rather than computing a digest from
// known-plaintext fallback values. Fail closed.

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

// Cookie name MUST stay "admin_token" — that's the literal
// proxy.ts reads at `req.cookies.get("admin_token")`. If you
// rename here, rename there in the same commit.
const COOKIE_NAME = "admin_token";

// 7 days. Long enough that AMs don't re-auth daily; short
// enough that future Phase 9+ work (multi-user identity, real
// session revocation) can introduce shorter-lived sessions
// without months of stale long-lived cookies to migrate.
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function computeExpectedToken(): string | null {
  const pw = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!pw || !secret) return null;
  return createHash("sha256").update(`${pw}:${secret}`).digest("hex");
}

function setAdminCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(COOKIE_NAME, token, {
    // HttpOnly: never readable by JS. Browser only sends it on
    // requests to this origin. Even an XSS in the admin UI
    // cannot exfiltrate the token.
    httpOnly: true,
    // Secure in production. Local dev (NODE_ENV !== "production")
    // doesn't get Secure so the cookie works over http://localhost.
    secure: process.env.NODE_ENV === "production",
    // SameSite=lax: cookie is sent on top-level cross-site
    // navigations from /admin/login to /admin/onboarding/sessions
    // (and from the workbook's `<a>` links to /admin/onboarding/
    // sessions if any). "strict" would drop the cookie on those
    // navigations and the proxy would still redirect signed-in
    // users back to /admin/login.
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

/**
 * POST /api/admin/auth
 * Body: { password: string }
 *
 * Validates the admin password against ADMIN_PASSWORD env.
 * Returns { ok: true } and sets the admin_token cookie on
 * success. Returns 401 on bad password, 400 on bad body, 500
 * if the server is misconfigured (env vars missing).
 *
 * The response body never contains the token.
 */
export async function POST(req: NextRequest) {
  let password: unknown;
  try {
    const body = await req.json();
    password = body?.password;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Bad request" },
      { status: 400 },
    );
  }

  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Bad request" },
      { status: 400 },
    );
  }

  const correct = process.env.ADMIN_PASSWORD;
  if (!correct) {
    console.error("[api/admin/auth] ADMIN_PASSWORD env var is not set");
    return NextResponse.json(
      { ok: false, error: "Server misconfigured" },
      { status: 500 },
    );
  }

  if (password !== correct) {
    return NextResponse.json(
      { ok: false, error: "Invalid password" },
      { status: 401 },
    );
  }

  const token = computeExpectedToken();
  if (!token) {
    console.error(
      "[api/admin/auth] ADMIN_SESSION_SECRET env var is not set",
    );
    return NextResponse.json(
      { ok: false, error: "Server misconfigured" },
      { status: 500 },
    );
  }

  const response = NextResponse.json({ ok: true });
  return setAdminCookie(response, token);
}

/**
 * GET /api/admin/auth
 *
 * Validates the existing admin_token cookie. Returns
 * { valid: true } and refreshes the cookie (slides the
 * 7-day expiry) on a valid cookie. Returns { valid: false }
 * with 401 on no cookie or mismatched cookie.
 *
 * Mostly useful for client-side "am I still signed in?"
 * checks before triggering a write — though the proxy will
 * also reject the write, the explicit check produces a
 * cleaner UX.
 */
export async function GET(req: NextRequest) {
  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  if (!cookie) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const expected = computeExpectedToken();
  if (!expected) {
    return NextResponse.json(
      { valid: false, error: "Server misconfigured" },
      { status: 500 },
    );
  }

  const valid = cookie === expected;
  const response = NextResponse.json({ valid });
  if (valid) {
    setAdminCookie(response, expected);
  }
  return response;
}
