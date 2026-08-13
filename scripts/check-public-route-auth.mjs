#!/usr/bin/env node
// =============================================================
// scripts/check-public-route-auth.mjs
// =============================================================
//
// Every route under src/app/api/public/** authorises its caller,
// or carries a declared exemption with a stated reason.
//
// WHY
//
// src/proxy.ts's matcher covers only /admin/:path* and
// /api/admin/:path*. That is correct and deliberate: the public
// onboarding routes are authorised by an unguessable session token
// (and a PIN where it matters), not by an admin session, so routing
// them through the cookie gate would break the client-facing form.
//
// The consequence is that a route added under /api/public/* is
// reachable by anyone unless its own handler checks something, and
// nothing enforced that. All 8 existing routes are correctly gated,
// so this is prospective rather than a live hole — but THIS REPO IS
// PUBLIC, and it reads and writes onboarding_sessions and
// onboarding_answers, so one ungated route is worse here than the
// same mistake in the private dashboard.
//
// This is the counterpart of the dashboard's
// scripts/check-route-coverage.mjs, which exists because "/" served
// the whole client roster to anonymous visitors after being left out
// of that repo's matcher. Same shape, different key: there the gate
// is a session cookie, here it is a token in the request.
//
// Usage:  npm run lint:public-route-auth
// Exits 1 naming any route that authorises nothing.
//
// ADDING A ROUTE: check the token, or declare it below with a reason.
// Do not widen AUTH_MARKERS to make a route pass.

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";

// Evidence that a handler establishes who is calling. Derived from what the 8
// existing routes actually do, not from a wishlist:
//   getSessionByToken  6 routes resolve the session from the token
//   .eq('token'        2 routes look the session up directly by token
//   verifyPin          the PIN gate, on top of a token lookup
//   checkBearerToken   the shared-integration bearer, used by admin routes
const AUTH_MARKERS = [
  /getSessionByToken\s*\(/,
  /\.eq\(\s*['"]token['"]/,
  /verifyPin/,
  /checkBearerToken\s*\(/,
];

/** Public routes that deliberately authorise nothing, and why. */
const DECLARED_OPEN = new Map([
  // Empty on purpose. Every current public route authorises its caller. An entry
  // here is a decision that a route may be called by anyone, which belongs in
  // review rather than in a diff nobody reads.
]);

const failures = [];

const stripCommentLines = (src) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

// --cached --others --exclude-standard so a brand-new, uncommitted route is seen.
// Plain `git ls-files` lists only tracked files, which would make this guard blind
// to exactly the change it exists to catch. The dashboard version learned that the
// hard way, via mutation testing.
const files = execSync(
  "git ls-files --cached --others --exclude-standard -- src/app/api/public",
  { encoding: "utf-8" },
)
  .split("\n")
  .filter((f) => /\/route\.tsx?$/.test(f));

if (files.length === 0) {
  console.error("[public-route-auth] found no routes under src/app/api/public — refusing to pass.");
  process.exit(1);
}

for (const file of files) {
  const url = file.replace(/^src\/app/, "").replace(/\/route\.tsx?$/, "");
  if (DECLARED_OPEN.has(url)) continue;
  const src = await readFile(file, "utf-8").catch(() => null);
  if (src === null) continue;
  const code = stripCommentLines(src);
  if (AUTH_MARKERS.some((re) => re.test(code))) continue;
  failures.push({
    url,
    file,
    detail:
      "authorises nothing: no getSessionByToken, no token lookup, no PIN check and no bearer " +
      "check. It is outside src/proxy.ts's matcher (which covers only /admin and /api/admin), " +
      "so it is reachable by anyone. Resolve the session from the request token, or declare it " +
      "in DECLARED_OPEN with a reason.",
  });
}

if (failures.length === 0) {
  console.log(
    `[public-route-auth] OK: ${files.length} public route(s) checked; every one authorises its caller.`,
  );
  process.exit(0);
}

console.error(`\n[public-route-auth] ${failures.length} public route(s) authorise nothing:\n`);
for (const { url, file, detail } of failures) {
  console.error(`  ${url}   (${file})`);
  console.error(`     ${detail}\n`);
}
console.error("This repository is public and these routes touch onboarding sessions and answers.\n");
process.exit(1);
