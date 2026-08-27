// =============================================================
// Tests for POST /api/admin/onboarding/pin. Run with: npm test
// =============================================================
//
// This endpoint hands back a live client credential, so every test here is about
// a way it must REFUSE to, and about the four outcomes staying distinguishable.
//
// THE OUTCOME THAT MATTERS MOST is 503-unconfigured versus 200-unrecoverable.
// Both look like "no PIN came back" to whoever is on the phone to the client, and
// they have opposite causes: one is a property of the deployment, the other of
// the row. Only the second is fixed by regenerating, and regenerating because of
// a misread 503 destroys a PIN the client is currently using, for nothing.
//
// THE AUDIT-FAILURE PATH IS DRIVEN WITH REAL FAULTS, not asserted. The endpoint
// returns 500 and no PIN when the audit write fails, and insertAuditEventOrThrow
// deliberately does not log because the caller owns the log line. That means a
// client-visible failure whose explanation could vanish, which would be worse
// than the fail-open write path because that one at least documents its silence.
// So the two faults the audit branch documents as Known limitations are driven
// through this endpoint directly:
//     a normaliser handed a non-string `message`
//     a field whose read throws
// and each must leave exactly one greppable [pin-reveal][AUDIT-FAILURE] line.
//
// Everything is hermetic. global fetch is stubbed, so no Supabase, no network.

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
// hashPin, not a hand-written string. Every fixture below used pin_hash
// "scrypt$x", which verifyPin rejects on sight (it wants 6 dollar-separated
// fields), so the step-5b cross-check would have failed on EVERY recoverable
// fixture and the guard could never have been exercised. A placeholder that
// cannot pass the real function is not a fixture, it is a blind spot.
import { hashPin } from "@/lib/onboarding/pin";

// ---------------------------------------------------------------------------
// CHILD MODE, for the one fault that cannot be injected in-process.
//
// server.ts captures its config at MODULE SCOPE:
//     const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
// so deleting the variable after the module has been imported changes nothing,
// and the first import happens in section 1. The fault is real but it is a
// COLD-START fault: it needs a process that never had the variable. Deleting it
// mid-suite produced a passing reveal, which is exactly the false negative that
// would have let this go unnoticed.
//
// So section 5e re-runs THIS FILE as a child with the variable absent from the
// start. One assertion, one real process, no mocking of the thing under test.
if (process.env.PIN_ROUTE_D2_CHILD === "1") {
  (async () => {
    const lines: string[] = [];
    const origError = console.error;
    console.error = ((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }) as typeof console.error;
    globalThis.fetch = (async () =>
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    let out: Record<string, unknown> = {};
    try {
      const { POST } = await import("./route");
      const res = await POST(
        new Request("http://localhost/api/admin/onboarding/pin", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${process.env.SHARED_INTEGRATION_BEARER_TOKEN}`,
          },
          body: JSON.stringify({
            sessionId: "3f6b1a2c-0000-4000-8000-000000000001",
            actingUserEmail: "johan@clixsy.com",
          }),
        }) as unknown as Parameters<typeof import("./route").POST>[0],
      );
      out = { threw: false, status: res.status, json: await res.json() };
    } catch (err) {
      // An unhandled throw here IS the defect, so it is reported rather than
      // crashing the child: the parent asserts on threw === false.
      out = { threw: true, message: String(err instanceof Error ? err.message : err) };
    }
    console.error = origError;
    out.lines = lines;
    process.stdout.write("__D2__" + JSON.stringify(out) + "__D2__");
  })();
} else {

let checks = 0;
function assert(cond: boolean, label: string) {
  checks++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
}

const VALID_KEY = Buffer.alloc(32, 0xfb).toString("base64");
const BEARER = "test-bearer-token-not-a-real-credential";
const SESSION_ID = "3f6b1a2c-0000-4000-8000-000000000001";
const CLIENT_ID = "a1c4e9d2-0000-4000-8000-000000000002";
const ACTOR = "johan@clixsy.com";

const saved = {
  key: process.env.PIN_ENCRYPTION_KEY,
  bearer: process.env.SHARED_INTEGRATION_BEARER_TOKEN,
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  role: process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetch: globalThis.fetch,
};

/** What the stub answers for the session SELECT and the audit INSERT. */
type Wire = {
  sessionRow?: Record<string, unknown> | null;
  sessionError?: { status: number; body: string };
  auditResponse?: { status: number; body: string };
};

function installStub(wire: Wire) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as Request).url);
    if (/onboarding_audit_events/.test(url)) {
      const r = wire.auditResponse ?? { status: 201, body: "[]" };
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (/onboarding_sessions/.test(url)) {
      if (wire.sessionError) {
        return new Response(wire.sessionError.body, {
          status: wire.sessionError.status,
          headers: { "content-type": "application/json" },
        });
      }
      const rows = wire.sessionRow ? [wire.sessionRow] : [];
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Capture console.error so the owned log line can be asserted on. */
function withCapture<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const grab = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = grab as typeof console.error;
  console.warn = grab as typeof console.warn;
  return run()
    .then((result) => ({ result, lines }))
    .finally(() => {
      console.error = orig.error;
      console.warn = orig.warn;
      console.log = orig.log;
    });
}

function req(body: unknown, opts: { bearer?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const b = opts.bearer === undefined ? BEARER : opts.bearer;
  if (b !== null) headers.Authorization = `Bearer ${b}`;
  return new Request("http://localhost/api/admin/onboarding/pin", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as Parameters<typeof import("./route").POST>[0];
}

async function callPost(body: unknown, opts: { bearer?: string | null } = {}) {
  const { POST } = await import("./route");
  const res = await POST(req(body, opts));
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* non-json */ }
  return { status: res.status, json };
}

function envelopeFor(pin: string) {
  const key = Buffer.from(VALID_KEY, "base64");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(pin, "utf8"), c.final()]);
  return `aes-256-gcm$1$${iv.toString("hex")}$${c.getAuthTag().toString("hex")}$${ct.toString("hex")}`;
}

async function main() {
  process.env.PIN_ENCRYPTION_KEY = VALID_KEY;
  process.env.SHARED_INTEGRATION_BEARER_TOKEN = BEARER;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9/";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-role-key";

  // The real scrypt hash of the fixture PIN, so `recoverable` fixtures satisfy
  // the gate cross-check the same way a live row does.
  const REAL_HASH = await hashPin("428913");
  const OTHER_HASH = await hashPin("999111");

  try {
    // -----------------------------------------------------------------
    console.log("\n1. AUTH fails closed, and 503 is not 401.");
    // -----------------------------------------------------------------
    installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelopeFor("428913") } });
    {
      delete process.env.SHARED_INTEGRATION_BEARER_TOKEN;
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 503, "no bearer token CONFIGURED -> 503, not 401");
      assert(r.json.reason === "bearer_token_not_configured",
        "and the reason names the deployment, not the caller's token");
      process.env.SHARED_INTEGRATION_BEARER_TOKEN = BEARER;
    }
    {
      process.env.SHARED_INTEGRATION_BEARER_TOKEN = "   ";
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 503, "a whitespace-only bearer token is unconfigured, not configured");
      process.env.SHARED_INTEGRATION_BEARER_TOKEN = BEARER;
    }
    {
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }, { bearer: null });
      assert(r.status === 401, "missing Authorization header -> 401");
      assert(r.json.reason === "missing_authorization_header", "and says the header is missing");
    }
    {
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }, { bearer: "wrong" });
      assert(r.status === 401, "wrong bearer token -> 401");
      assert(r.json.reason === "invalid_bearer_token", "and says the token is invalid");
    }
    {
      // A prefix of the real token is rejected. AND THAT IS ALL THIS PROVES: it
      // does NOT establish the comparison is timing-safe, which is what the
      // previous version of this comment implied by invoking "a length-blind
      // compare". Plain `===` on strings is not length-blind either, so `!==`
      // satisfies this assertion exactly as well as timingSafeEqual does;
      // measured, swapping in `===` leaves the whole suite green. Timing safety
      // is not assertable from this suite and require-bearer-token.ts now says so
      // in its own header. Keep this test, drop the claim it was carrying.
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }, { bearer: BEARER.slice(0, 10) });
      assert(r.status === 401, "a PREFIX of the real token -> 401");
    }

    // -----------------------------------------------------------------
    console.log("\n2. THE CONFIGURATION GATE. 503 must never read as unrecoverable.");
    // -----------------------------------------------------------------
    {
      delete process.env.PIN_ENCRYPTION_KEY;
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 503, "no PIN_ENCRYPTION_KEY -> 503");
      assert(r.json.reason === "pin_encryption_not_configured", "with a configuration reason");
      assert(r.json.state === undefined,
        "and NO state field: outcome 4 must not be reported as a state of the session");
      assert(!("pin" in r.json), "and no pin key at all");
      // THE SENTENCE THAT STOPS THE DESTRUCTIVE ACTION. Outcome 2's equivalent
      // warning is asserted and its removal is caught; this one was not asserted
      // at all, so emptying it stayed green. It is the more dangerous of the two:
      // a 503 misread as "no PIN stored" is what sends someone to regenerate a
      // PIN the client is currently using.
      assert(
        typeof r.json.detail === "string" &&
          /regenerating will not help/i.test(String(r.json.detail)),
        "outcome 4 says explicitly that regenerating will NOT help",
      );
      process.env.PIN_ENCRYPTION_KEY = VALID_KEY;
    }
    {
      // A present-but-unusable key is also unconfigured, not a row problem.
      process.env.PIN_ENCRYPTION_KEY = VALID_KEY.replace(/\+/g, "-").replace(/\//g, "_");
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 503, "a base64url (unusable) key -> 503, not a session state");
      process.env.PIN_ENCRYPTION_KEY = VALID_KEY;
    }
    {
      // The gate must run BEFORE the row is read, or a keyless deployment can
      // answer "unrecoverable" about a session whose envelope is fine.
      let touchedSessions = false;
      const inner = globalThis.fetch;
      globalThis.fetch = (async (i: RequestInfo | URL) => {
        const u = typeof i === "string" ? i : String((i as Request).url ?? i);
        if (/onboarding_sessions/.test(u)) touchedSessions = true;
        return inner(i as RequestInfo);
      }) as typeof fetch;
      delete process.env.PIN_ENCRYPTION_KEY;
      await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      process.env.PIN_ENCRYPTION_KEY = VALID_KEY;
      globalThis.fetch = inner;
      assert(!touchedSessions, "with no key, the session row is never read at all");
    }

    // -----------------------------------------------------------------
    console.log("\n3. ZOD, including the acting user's email.");
    // -----------------------------------------------------------------
    for (const [label, body] of [
      ["a missing actingUserEmail", { sessionId: SESSION_ID }],
      ["a non-email actor", { sessionId: SESSION_ID, actingUserEmail: "not-an-email" }],
      ["an empty actor", { sessionId: SESSION_ID, actingUserEmail: "" }],
      ["a missing sessionId", { actingUserEmail: ACTOR }],
      ["a non-uuid sessionId", { sessionId: "abc", actingUserEmail: ACTOR }],
      ["an over-long actor (>320)", { sessionId: SESSION_ID, actingUserEmail: "a".repeat(310) + "@example.com" }],
    ] as Array<[string, unknown]>) {
      const r = await callPost(body);
      assert(r.status === 400, `${label} -> 400`);
      assert(r.json.reason === "invalid_payload", `${label} names the payload`);
    }
    {
      const r = await callPost("{not json");
      assert(r.status === 400 && r.json.reason === "invalid_json", "a non-JSON body -> 400 invalid_json");
    }

    // -----------------------------------------------------------------
    console.log("\n4. THE FOUR OUTCOMES, distinguishable.");
    // -----------------------------------------------------------------
    {
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelopeFor("428913") } });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 200 && r.json.state === "recoverable", "outcome 1: recoverable -> 200");
      assert(r.json.pin === "428913", "outcome 1 returns the actual PIN");
    }
    {
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: null } });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 200 && r.json.state === "unrecoverable", "outcome 2: gated, no envelope -> 200 unrecoverable");
      assert(r.json.pin === null, "outcome 2 returns pin: null");
      assert(typeof r.json.detail === "string" && /CHANGE the PIN/.test(String(r.json.detail)),
        "outcome 2 warns that regenerating CHANGES the client's PIN");
    }
    {
      // The unmigrated-database shape: the column is absent, so undefined.
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH } });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 200 && r.json.state === "unrecoverable",
        "an ABSENT pin_envelope column classifies as unrecoverable, not recoverable");
    }
    {
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: null, pin_envelope: null } });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 200 && r.json.state === "no_gate", "outcome 3: no PIN gate -> 200 no_gate");
      assert(r.json.pin === null, "outcome 3 returns pin: null");
    }
    {
      installStub({ sessionRow: null });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 404 && r.json.reason === "session_not_found",
        "an unknown session is 404, distinct from every outcome above");
    }
    {
      installStub({ sessionError: { status: 500, body: JSON.stringify({ message: "boom", code: "XX000" }) } });
      const { result, lines } = await withCapture(() => callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }));
      assert(result.status === 500 && result.json.reason === "session_read_failed",
        "a row READ failure is 500, never 404 and never a state");
      assert(lines.some((l) => l.includes("[pin-reveal][READ-FAILURE]")),
        "and it emits a greppable READ-FAILURE line");
    }
    {
      // A broken envelope is NOT outcome 2. It is a data fault worth investigating.
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: "aes-256-gcm$1$" + "aa".repeat(12) + "$" + "bb".repeat(16) + "$aabb" } });
      const { result, lines } = await withCapture(() => callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }));
      assert(result.status === 500 && result.json.reason === "pin_envelope_unreadable",
        "a parseable-but-undecryptable envelope is 500, distinct from unrecoverable");
      assert(result.json.pin === undefined, "and returns no pin");
      assert(lines.some((l) => l.includes("[pin-reveal][DECRYPT-FAILURE]")),
        "and emits a greppable DECRYPT-FAILURE line");
    }

    // -----------------------------------------------------------------
    console.log("\n5. THE AUDIT PATH FAILS CLOSED, and says why. Driven with real faults.");
    // -----------------------------------------------------------------
    const goodRow = { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelopeFor("428913") };
    const auditFaults: Array<[string, { status: number; body: string }]> = [
      ["an RLS refusal (42501)", { status: 403, body: JSON.stringify({ message: 'new row violates row-level security policy for table "onboarding_audit_events"', code: "42501" }) }],
      // The two faults the audit branch documents as Known limitations.
      ["a NON-STRING message (array)", { status: 400, body: JSON.stringify({ message: ["a", "b"], code: "22P02" }) }],
      ["a NON-STRING message (number)", { status: 400, body: JSON.stringify({ message: 42, code: "22P02" }) }],
      ["a NON-STRING message (object)", { status: 400, body: JSON.stringify({ message: { a: 1 }, code: "22P02" }) }],
      ["an HTML body, not JSON", { status: 502, body: "<html><body>502 Bad Gateway</body></html>" }],
      ["an unknown column (PGRST204)", { status: 400, body: JSON.stringify({ message: "Could not find the 'x' column", code: "PGRST204" }) }],
    ];
    for (const [label, auditResponse] of auditFaults) {
      installStub({ sessionRow: goodRow, auditResponse });
      const { result, lines } = await withCapture(() => callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }));
      assert(result.status === 500, `audit failure via ${label} -> 500`);
      assert(result.json.reason === "audit_write_failed", `${label} names the audit as the cause`);
      assert(!("pin" in result.json), `${label} returns NO pin field at all`);
      const tagged = lines.filter((l) => l.includes("[pin-reveal][AUDIT-FAILURE]"));
      assert(tagged.length === 1,
        `${label} emits EXACTLY ONE greppable [pin-reveal][AUDIT-FAILURE] line (saw ${tagged.length})`);
      // The line must be actionable without a second query, and must not carry the PIN.
      assert(tagged[0]?.includes(SESSION_ID) && tagged[0]?.includes(ACTOR),
        `${label}: the line names the session and the actor`);
      // NOT `!tagged[0]?.includes(...)`. With `tagged` empty that is
      // `!undefined`, which PASSES while no line exists at all: under a mutation
      // that deletes the log line its three siblings went red and this one stayed
      // green. The nullish default makes the empty case a real failure.
      assert(tagged.length === 1 && !(tagged[0] ?? "").includes("428913"),
        `${label}: the line does NOT contain the PIN`);
      assert(tagged.length === 1 && tagged[0].split("\n").length === 1,
        `${label}: the line is a single physical line, so it stays greppable`);
    }
    {
      // The control: with the audit succeeding, the PIN does come back. Without
      // this, every assertion above would pass on an endpoint that never works.
      installStub({ sessionRow: goodRow, auditResponse: { status: 201, body: "[]" } });
      const { result, lines } = await withCapture(() => callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }));
      assert(result.status === 200 && result.json.pin === "428913",
        "CONTROL: with the audit succeeding, the PIN is returned");
      assert(!lines.some((l) => l.includes("AUDIT-FAILURE")),
        "CONTROL: and no audit-failure line is emitted on the happy path");
    }

    // -----------------------------------------------------------------
    console.log("\n5b. THE AUDIT PAYLOAD IS PIN-FREE. Re-verified under the new shape.");
    // -----------------------------------------------------------------
    // An earlier critic verified this payload was provably PIN-free BY TYPE: six
    // string literals and a boolean, no free-text field for a PIN to reach even
    // by accident. `actor` is the first free-text value, so that guarantee is now
    // VALIDATED rather than STRUCTURAL. This section is what replaces it, and it
    // asserts the property under the shape that actually ships rather than
    // assuming it carried over.
    {
      const captured: Array<{ url: string; body: string }> = [];
      const goodEnv = envelopeFor("428913");
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (/onboarding_audit_events/.test(url)) {
          captured.push({ url, body: String(init?.body ?? "") });
          return new Response("[]", { status: 201, headers: { "content-type": "application/json" } });
        }
        return new Response(
          JSON.stringify([{ id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: goodEnv }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;

      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 200 && r.json.pin === "428913", "the reveal succeeded, so a row was written");
      assert(captured.length === 1, "exactly one audit row was written");

      const wire = captured[0]?.body ?? "";
      assert(!wire.includes("428913"), "the audit row does NOT contain the PIN");
      assert(!wire.includes(goodEnv), "the audit row does NOT contain the envelope");
      assert(!wire.includes(VALID_KEY), "the audit row does NOT contain the key");

      // The exact key set, so a future field cannot be added without this failing.
      // postgrest-js sends a single insert as an OBJECT, not a one-element
      // array. Both shapes are handled so this does not silently read {} and
      // pass a key-set assertion against nothing, which is what it did first.
      const parsedWire = JSON.parse(wire) as
        | { payload?: Record<string, unknown> }
        | Array<{ payload?: Record<string, unknown> }>;
      const first = Array.isArray(parsedWire) ? parsedWire[0] : parsedWire;
      const payload = first?.payload ?? {};
      assert(
        Object.keys(payload).length > 0,
        "the captured payload is non-empty, so the assertions below are reading something",
      );
      const keys = Object.keys(payload).sort();
      assert(
        JSON.stringify(keys) === JSON.stringify(["actor", "pin_returned", "state"]),
        `the payload has EXACTLY actor, pin_returned, state (got ${JSON.stringify(keys)})`,
      );
      // THE ROW'S IDENTITY, not just its payload. A row written against the
      // wrong session id, or with a mistyped event_type, is worse than no row:
      // it looks like a complete audit trail and attributes the reveal to the
      // wrong session. Both mutations previously survived green.
      const rowTop = (first ?? {}) as Record<string, unknown>;
      assert(rowTop.session_id === SESSION_ID,
        "the audit row is written against THIS session id");
      assert(rowTop.event_type === "pin_revealed",
        "the audit row's event_type is exactly pin_revealed");

      assert(payload.actor === ACTOR, "actor is the validated email");
      assert(payload.pin_returned === true, "pin_returned is a boolean, not the PIN");
      assert(
        typeof payload.state === "string" &&
          ["recoverable", "unrecoverable", "no_gate"].includes(payload.state as string),
        "state is one of the three literals",
      );
      // Only ONE free-text value, and it is the email. Anything else non-boolean
      // and not in the three-literal set would be a second one.
      const freeText = Object.entries(payload).filter(
        ([k, v]) => typeof v === "string" && k !== "state",
      );
      assert(
        freeText.length === 1 && freeText[0][0] === "actor",
        `exactly ONE free-text field, and it is actor (got ${JSON.stringify(freeText.map((f) => f[0]))})`,
      );
    }
    {
      // And the cap is a REJECTION, not a truncation: a truncated actor in an
      // audit row looks like a real answer.
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelopeFor("428913") } });
      const long = "a".repeat(310) + "@example.com"; // > 320
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: long });
      assert(r.status === 400, "an over-long actor is REJECTED, not truncated");
      assert(r.json.reason === "invalid_payload", "and it is a payload error");
    }
    {
      // A `reason` field was dropped from the first draft. If someone re-adds a
      // second free-text field, Zod's default strip means it silently vanishes
      // rather than erroring, so this pins that it does NOT reach the row.
      const captured: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (/onboarding_audit_events/.test(url)) {
          captured.push(String(init?.body ?? ""));
          return new Response("[]", { status: 201, headers: { "content-type": "application/json" } });
        }
        return new Response(
          JSON.stringify([{ id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelopeFor("428913") }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR, reason: "SECRET-428913-LEAK" });
      assert(
        captured.length === 1 && !captured[0].includes("SECRET-428913-LEAK"),
        "an unexpected free-text field in the request does NOT reach the audit row",
      );
    }

    // -----------------------------------------------------------------
    console.log("\n5c. A STORED VALUE THAT IS NOT AN ENVELOPE is not outcome 2.");
    // -----------------------------------------------------------------
    // THE DEFECT THIS SECTION EXISTS FOR. Every row below used to come back
    // 200 "unrecoverable" with the response telling the operator the session
    // "predates this feature" and inviting a regeneration that CHANGES the
    // client's PIN. Both stated causes were false for a corrupt row, and the
    // advice was the destructive one. The sharpest way in is a rolling deploy
    // after an ENVELOPE_VERSION bump: old instances would say that about every
    // row the new instances minted, silently and at scale.
    {
      const corrupt: Array<[string, unknown]> = [
        ["a bumped version prefix", "aes-256-gcm$2$" + "0".repeat(24) + "$" + "0".repeat(32) + "$" + "0".repeat(32)],
        ["a 4-byte auth tag", "aes-256-gcm$1$" + "0".repeat(24) + "$" + "0".repeat(8) + "$" + "0".repeat(32)],
        ["a wrong-length IV", "aes-256-gcm$1$" + "0".repeat(10) + "$" + "0".repeat(32) + "$" + "0".repeat(32)],
        ["non-hex fields", "aes-256-gcm$1$" + "z".repeat(24) + "$" + "z".repeat(32) + "$" + "z".repeat(32)],
        ["the string 'hello'", "hello"],
        ["a number", 12345],
        ["an object", {}],
      ];
      for (const [label, envelope] of corrupt) {
        installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelope as string } });
        const { result, lines } = await withCapture(() =>
          callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }),
        );
        assert(result.status === 500 && result.json.reason === "pin_envelope_unreadable",
          `${label} -> 500 pin_envelope_unreadable, NOT 200 unrecoverable`);
        assert(result.json.state === undefined,
          `${label}: no state field, so no UI can render the regenerate copy`);
        assert(!("pin" in result.json), `${label}: no pin field at all`);
        assert(/do not regenerate yet/i.test(String(result.json.detail ?? "")),
          `${label}: the response says NOT to regenerate`);
        assert(lines.some((l) => l.includes("[pin-reveal][ENVELOPE-MALFORMED]")),
          `${label}: emits a greppable ENVELOPE-MALFORMED line (it emitted NOTHING before)`);
      }
    }
    {
      // The boundary: genuinely absent stays outcome 2, so the split above did
      // not simply move every row into the 500. Without this the section could
      // pass on an endpoint that 500s for everything.
      for (const [label, envelope] of [["null", null], ["empty string", ""], ["whitespace", "   "]] as Array<[string, unknown]>) {
        installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelope as string | null } });
        const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
        assert(r.status === 200 && r.json.state === "unrecoverable",
          `CONTROL: an envelope that is ${label} IS outcome 2`);
      }
    }

    // -----------------------------------------------------------------
    console.log("\n5d. THE DECRYPTED PIN MUST MATCH THE GATE.");
    // -----------------------------------------------------------------
    // encryptPin binds no AAD and no session id, so an envelope minted for
    // another session decrypts perfectly here. Before the cross-check that
    // produced 200 recoverable with a PIN belonging to a different client: the
    // wrong six digits, full confidence, no warning, read out over the phone.
    {
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: OTHER_HASH, pin_envelope: envelopeFor("428913") } });
      const { result, lines } = await withCapture(() =>
        callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }),
      );
      assert(result.status === 500 && result.json.reason === "pin_envelope_mismatch",
        "an envelope that does not match pin_hash is 500, not a confident 200");
      assert(!("pin" in result.json), "and the wrong PIN is NOT returned");
      assert(lines.some((l) => l.includes("[pin-reveal][PIN-HASH-MISMATCH]")),
        "and it emits a greppable PIN-HASH-MISMATCH line");
      assert(!lines.some((l) => l.includes("428913")),
        "and the withheld PIN does not appear in the log either");
    }
    {
      // The control that makes the assertion above mean something: with the
      // hash matching, the same envelope IS revealed. If this failed, 5d would
      // pass on an endpoint that rejects every reveal.
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelopeFor("428913") } });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 200 && r.json.pin === "428913",
        "CONTROL: a matching hash still reveals the PIN");
    }

    // -----------------------------------------------------------------
    console.log("\n5e. THE DEPLOYMENT FAULTS THAT USED TO BE A BARE 500.");
    // -----------------------------------------------------------------
    {
      // D2: createServiceRoleClient throws on missing env. Unwrapped, the
      // handler rejected: Next's generic 500, no reason, no state, and NOTHING
      // logged. Same fault class as outcome 4, so it must be as legible.
      //
      // Run as a CHILD with the variable absent from the start, because server.ts
      // captures it at module scope. Deleting it in-process here produced a
      // successful reveal, so the in-process version of this test would have been
      // a false negative dressed as coverage. See the child block at the top.
      // Cast because spreading process.env DROPS its index signature, so the
      // result type has only the explicitly declared keys and `delete env.X`
      // does not compile for anything else. Reading process.env.X still works,
      // which is why this only bites here.
      const env = { ...process.env, PIN_ROUTE_D2_CHILD: "1" } as Record<
        string,
        string | undefined
      >;
      delete env.NEXT_PUBLIC_SUPABASE_URL;
      // execArgv AND argv, not argv alone. Under tsx, argv[1] is this .ts file
      // and the loader lives entirely in execArgv (--require preflight.cjs,
      // --import loader.mjs), so `node <argv.slice(1)>` spawns a plain Node with
      // no TypeScript support and dies before reaching the child block. Measured:
      // the child produced no output at all until execArgv was included.
      // Also not require.resolve("tsx/cli") or __filename: this file runs as ESM,
      // where neither exists.
      const child = spawnSync(
        process.execPath,
        [...process.execArgv, ...process.argv.slice(1)],
        {
          // Cast back on the way in: this project declares NODE_ENV as required
          // on ProcessEnv, and the widened record above has lost that.
          env: env as unknown as NodeJS.ProcessEnv,
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      const raw = child.stdout ?? "";
      const m = raw.match(/__D2__([\s\S]*?)__D2__/);
      assert(m !== null, "the cold-start child produced a result at all");
      const got = m ? (JSON.parse(m[1]) as Record<string, unknown>) : {};
      const childJson = (got.json ?? {}) as Record<string, unknown>;
      const childLines = (got.lines ?? []) as string[];
      assert(got.threw === false,
        "a cold start with no Supabase config does NOT throw out of the handler");
      assert(got.status === 500 && childJson.reason === "supabase_client_unavailable",
        "missing Supabase config is a NAMED 500, not a bare unhandled rejection");
      assert(childJson.state === undefined, "and carries no state");
      assert(!("pin" in childJson), "and no pin");
      assert(childLines.some((l) => l.includes("[pin-reveal][CLIENT-UNAVAILABLE]")),
        "and emits a greppable line, where it previously emitted none");
      assert(/regenerating will not help/i.test(String(childJson.detail ?? "")),
        "and says regenerating will not help, because this is not the row's fault");
    }
    {
      // D3: the session read was unbounded. A call that never settles has no
      // .error to read, which is the sibling audit branch's rule verbatim. The
      // stub IGNORES the abort signal on purpose: that is the harder case, and
      // it proves the deadline holds even against a callee that will not stop.
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (/onboarding_sessions/.test(url)) {
          return await new Promise<Response>(() => { /* never settles, never aborts */ });
        }
        return new Response("[]", { status: 201, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      // A REF'D KEEP-ALIVE, and it is load-bearing. withDeadline calls .unref()
      // on its timer (server.ts "Detail 2"), so an unref'd timer plus a promise
      // that never settles leaves NOTHING keeping the event loop alive: Node
      // exits, cleanly, with code 0, before the deadline can fire. Measured: the
      // suite silently stopped here and sections 5f and 6 never ran, and because
      // the process exited rather than failing, the run reported exit 0 and even
      // the ran-N denominator check was skipped. A denominator cannot catch a
      // process that leaves early.
      //
      // Under a real request there is always a live handle (the HTTP socket), so
      // .unref() is correct in production. It is only a test artefact, but the
      // artefact hides tests rather than failing them, which is worse.
      const keepAlive = setInterval(() => {}, 250);
      const started = process.hrtime.bigint();
      const { result, lines } = await withCapture(() =>
        callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }),
      );
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      clearInterval(keepAlive);
      assert(result.status === 504 && result.json.reason === "session_read_timeout",
        "a session read that never settles is a bounded 504, not a platform hang");
      assert(!("pin" in result.json), "and returns no pin");
      assert(lines.some((l) => l.includes("[pin-reveal][READ-TIMEOUT]")),
        "and emits a greppable READ-TIMEOUT line");
      // The bound is real rather than an accident of the stub resolving fast.
      assert(elapsedMs >= 4000 && elapsedMs < 20000,
        `and it returned on the deadline rather than hanging (${Math.round(elapsedMs)}ms)`);
    }

    // -----------------------------------------------------------------
    console.log("\n5f. THE BEARER GUARD'S CONFIGURATION EDGES.");
    // -----------------------------------------------------------------
    // WHAT A REAL REQUEST CANNOT DO, established before asserting anything.
    // undici refuses to build a Request whose header value holds a character
    // above U+00FF: "Cannot convert argument to a ByteString because the
    // character at index 7 has a value of 8203 which is greater than 255."
    //
    // That matters because it CORRECTS the finding this section came from. The
    // report said an env token of U+200B was read as configured and then ALLOWED
    // "a request presenting Bearer + U+200B". No such request can exist. The
    // allow is real, but only for the FUNCTION called with a synthetic headers
    // object; through the HTTP layer the same misconfiguration produced a
    // permanent 401 instead, blaming the integrator for the server's fault.
    //
    // Both outcomes are wrong and 503 fixes both, so the fix stands. The claim
    // did not, so both layers are asserted separately below rather than one
    // being described as the other.
    {
      const savedBearer = process.env.SHARED_INTEGRATION_BEARER_TOKEN;
      const ZWSP = String.fromCharCode(0x200b);

      // Layer 1: the HTTP layer cannot even carry it. Asserted, not assumed,
      // because it is the reason layer 2 is tested the way it is.
      let headerConstructionFailed = false;
      try {
        new Request("http://localhost/x", { headers: { Authorization: `Bearer ${ZWSP}` } });
      } catch {
        headerConstructionFailed = true;
      }
      assert(headerConstructionFailed,
        "a header value holding U+200B cannot be constructed at all, so no real caller can present one");

      // Layer 2: the function, driven with a synthetic headers object, which is
      // the only way that path is reachable. This is where the old code allowed.
      const { requireBearerToken } = await import("@/lib/onboarding/require-bearer-token");
      const fakeReq = (value: string | null) =>
        ({ headers: { get: (n: string) => (n.toLowerCase() === "authorization" ? value : null) } }) as unknown as Parameters<typeof requireBearerToken>[0];

      process.env.SHARED_INTEGRATION_BEARER_TOKEN = ZWSP;
      const zw = requireBearerToken(fakeReq(`Bearer ${ZWSP}`));
      assert(zw.ok === false && zw.status === 503,
        "a zero-width-only token is UNCONFIGURED (503), where it previously ALLOWED");

      // And the same misconfiguration through the route, with a header a real
      // caller could actually send: still 503, never a 401 blaming the caller.
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelopeFor("428913") } });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }, { bearer: "anything-ascii" });
      assert(r.status === 503 && r.json.reason === "bearer_token_not_configured",
        "and through the route it is 503, not the 401 it used to be");
      assert(!("pin" in r.json), "and no PIN is revealed");

      process.env.SHARED_INTEGRATION_BEARER_TOKEN = savedBearer;
    }
    {
      // The neighbours, so the fix is not just the one character. U+00A0 and
      // U+FEFF were already handled by .trim(); keeping them here means a future
      // change to the normaliser has to keep all of them.
      const savedBearer = process.env.SHARED_INTEGRATION_BEARER_TOKEN;
      const { requireBearerToken } = await import("@/lib/onboarding/require-bearer-token");
      const fakeReq = (value: string | null) =>
        ({ headers: { get: (n: string) => (n.toLowerCase() === "authorization" ? value : null) } }) as unknown as Parameters<typeof requireBearerToken>[0];
      const edges: Array<[string, number]> = [
        ["U+00A0 NBSP", 0x00a0],
        ["U+FEFF BOM", 0xfeff],
        ["U+2060 WORD JOINER", 0x2060],
        ["U+200C ZWNJ", 0x200c],
        ["U+200D ZWJ", 0x200d],
      ];
      for (const [label, cp] of edges) {
        const ch = String.fromCharCode(cp);
        process.env.SHARED_INTEGRATION_BEARER_TOKEN = ch;
        const out = requireBearerToken(fakeReq(`Bearer ${ch}`));
        assert(out.ok === false && out.status === 503,
          `a token of only ${label} is also 503, not a usable credential`);
      }

      // AN EMBEDDED zero-width, which is the case that distinguishes REFUSING
      // from SILENTLY CLEANING. An earlier version filtered these characters out
      // of the value, so this token was accepted and matched against "abcdef":
      // the environment variable and the token that actually worked were then
      // invisibly different strings. Mutation testing showed no test could tell
      // the two designs apart, which is what surfaced the choice. Refusing is
      // right, so this asserts the refusal rather than the repair.
      process.env.SHARED_INTEGRATION_BEARER_TOKEN =
        "abc" + String.fromCharCode(0x200b) + "def";
      const embedded = requireBearerToken(fakeReq("Bearer abcdef"));
      assert(embedded.ok === false && embedded.status === 503,
        "a token with an embedded zero-width is REFUSED, not silently cleaned and accepted");

      process.env.SHARED_INTEGRATION_BEARER_TOKEN = savedBearer;
    }
    {
      // D11: a non-ASCII token can never match any header, so EVERY request
      // 401s including the correct one. Reported as 401 that blames the
      // integrator for the server's misconfiguration, which is the exact
      // misdiagnosis this module exists to prevent.
      const savedBearer = process.env.SHARED_INTEGRATION_BEARER_TOKEN;
      const NON_ASCII = "tok-caf" + String.fromCharCode(0x00e9) + "-123";
      process.env.SHARED_INTEGRATION_BEARER_TOKEN = NON_ASCII;
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelopeFor("428913") } });
      const { result, lines } = await withCapture(() =>
        // A header a real caller CAN send. U+00E9 is inside latin-1 so this one
        // would construct, but the point is the server side: the env value is
        // unusable regardless of what arrives.
        callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR }, { bearer: "tok-cafe-123" }),
      );
      assert(result.status === 503 && result.json.reason === "bearer_token_not_configured",
        "a non-ASCII token is a 503 deployment fault, not a 401 blaming the caller");
      assert(lines.some((l) => l.includes("[bearer-auth][TOKEN-NOT-USABLE]")),
        "and it names the real cause in a greppable line");
      assert(!lines.some((l) => l.includes(NON_ASCII)),
        "and no token material is logged");
      process.env.SHARED_INTEGRATION_BEARER_TOKEN = savedBearer;
    }
    {
      // The control: the ordinary token still works after all of the above, so
      // 5f cannot pass by having broken the guard into refusing everything.
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: REAL_HASH, pin_envelope: envelopeFor("428913") } });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 200 && r.json.pin === "428913",
        "CONTROL: the ordinary bearer token still authenticates");
    }

    // -----------------------------------------------------------------
    console.log("\n6. GET is refused, so a PIN cannot end up in a URL.");
    // -----------------------------------------------------------------
    {
      const { GET } = await import("./route");
      const res = await GET();
      assert(res.status === 405, "GET -> 405");
    }

    const total = checks;
    assert(total === 171, `all 171 checks ran, none skipped (ran ${total})`);
  } finally {
    process.env.PIN_ENCRYPTION_KEY = saved.key;
    if (saved.bearer === undefined) delete process.env.SHARED_INTEGRATION_BEARER_TOKEN;
    else process.env.SHARED_INTEGRATION_BEARER_TOKEN = saved.bearer;
    process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved.role;
    globalThis.fetch = saved.fetch;
  }

  console.log("\n=========================================");
  console.log(`  ${process.exitCode !== 1 ? "ALL TESTS PASS" : "ONE OR MORE TESTS FAILED"}`);
  console.log("=========================================");
}

main();

} // end of the non-child branch
