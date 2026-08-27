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
 *
 * WHAT THE TESTS DO NOT COVER, stated because the alternative is implying they
 * do. Timing safety is NOT asserted anywhere and cannot be from a unit test in
 * this suite. The test that looks like it covers it ("a PREFIX of the real token
 * -> 401") protects nothing that plain `!==` would not also satisfy, because
 * `===` on strings is not length-blind either; a critic confirmed that replacing
 * timingSafeEqual with `===` leaves the whole suite green. The property here
 * rests on reading this function, not on a green assertion. If you change this
 * comparison, no test will stop you.
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
  //
  // AND .trim() IS NARROWER THAN IT LOOKS. Its whitespace set is Unicode
  // White_Space, which EXCLUDES the zero-width characters, so a lone U+200B once
  // read as CONFIGURED here. U+00A0 and U+FEFF were both handled, so the gap was
  // specific rather than general, which is the kind a spot check misses.
  //
  // THE FIX FOR THAT IS NOT HERE, and finding that out is why this note is this
  // long. A first version filtered U+200B/C/D, U+2060 and U+FEFF out of the value
  // before the emptiness test. Mutation testing then showed that DELETING that
  // filter changed nothing any test could see, and the reason was not a missing
  // test: the printable-ASCII check below already rejects every one of those code
  // points, so the filter was redundant for the outcome.
  //
  // The two designs diverge only for a token like "abc<U+200B>def", and there the
  // filter is actively WORSE: it silently cleans the value and accepts, so the
  // token in the environment and the token that actually works are invisibly
  // different strings. The check below refuses it and says why. A guard that
  // repairs a misconfiguration in silence is not a guard, so the filter is gone
  // and whitespace handling stays at .trim(), which covers the paste artefact
  // that actually happens: a trailing newline.
  const normalised = typeof expected === "string" ? expected.trim() : "";
  if (normalised.length === 0) {
    return { ok: false, status: 503, reason: "bearer_token_not_configured" };
  }

  // A NON-ASCII TOKEN CANNOT EVER MATCH, so it is a configuration fault and not
  // the caller's. HTTP header values are ByteStrings: `headers.get()` yields the
  // latin-1 reading of the wire bytes, while Buffer.from(env, "utf8") encodes
  // the env value as UTF-8, so the two can never be equal for any character
  // above U+007F. Measured: a token containing "é" produced a permanent 401 on
  // every request, including the correct one. Reported as 401 that is a deployment
  // that blames the integrator for the server's own misconfiguration, which is
  // the misdiagnosis this whole module exists to prevent.
  //
  // The RESPONSE reason stays `bearer_token_not_configured`, deliberately: the
  // contract has one 503 and widening it would make the outcome set a
  // configuration oracle. The specific cause goes to the log, where the operator
  // who can fix it will be looking.
  const printableAscii = Array.from(normalised).every((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 0x21 && cp <= 0x7e;
  });
  if (!printableAscii) {
    console.error(
      "[bearer-auth][TOKEN-NOT-USABLE] SHARED_INTEGRATION_BEARER_TOKEN contains " +
        "characters outside printable ASCII, so it can never match an HTTP header " +
        "value and EVERY request will 401. Re-set it to printable ASCII. " +
        "No token material is logged.",
    );
    return { ok: false, status: 503, reason: "bearer_token_not_configured" };
  }

  const header = request.headers.get("Authorization");
  if (!header) {
    return { ok: false, status: 401, reason: "missing_authorization_header" };
  }

  const presented = Buffer.from(header, "utf8");
  const wanted = Buffer.from(`Bearer ${normalised}`, "utf8");
  if (presented.length !== wanted.length) {
    return { ok: false, status: 401, reason: "invalid_bearer_token" };
  }
  if (!crypto.timingSafeEqual(presented, wanted)) {
    return { ok: false, status: 401, reason: "invalid_bearer_token" };
  }
  return { ok: true };
}
