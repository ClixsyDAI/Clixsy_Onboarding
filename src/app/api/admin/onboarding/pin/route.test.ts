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

  try {
    // -----------------------------------------------------------------
    console.log("\n1. AUTH fails closed, and 503 is not 401.");
    // -----------------------------------------------------------------
    installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: "scrypt$x", pin_envelope: envelopeFor("428913") } });
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
      // A prefix of the real token must not be accepted by a length-blind compare.
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
      ["an over-long reason", { sessionId: SESSION_ID, actingUserEmail: ACTOR, reason: "x".repeat(501) }],
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
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: "scrypt$x", pin_envelope: envelopeFor("428913") } });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 200 && r.json.state === "recoverable", "outcome 1: recoverable -> 200");
      assert(r.json.pin === "428913", "outcome 1 returns the actual PIN");
    }
    {
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: "scrypt$x", pin_envelope: null } });
      const r = await callPost({ sessionId: SESSION_ID, actingUserEmail: ACTOR });
      assert(r.status === 200 && r.json.state === "unrecoverable", "outcome 2: gated, no envelope -> 200 unrecoverable");
      assert(r.json.pin === null, "outcome 2 returns pin: null");
      assert(typeof r.json.detail === "string" && /CHANGE the PIN/.test(String(r.json.detail)),
        "outcome 2 warns that regenerating CHANGES the client's PIN");
    }
    {
      // The unmigrated-database shape: the column is absent, so undefined.
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: "scrypt$x" } });
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
      installStub({ sessionRow: { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: "scrypt$x", pin_envelope: "aes-256-gcm$1$" + "aa".repeat(12) + "$" + "bb".repeat(16) + "$aabb" } });
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
    const goodRow = { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: "scrypt$x", pin_envelope: envelopeFor("428913") };
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
      assert(!tagged[0]?.includes("428913"),
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
    console.log("\n6. GET is refused, so a PIN cannot end up in a URL.");
    // -----------------------------------------------------------------
    {
      const { GET } = await import("./route");
      const res = await GET();
      assert(res.status === 405, "GET -> 405");
    }

    const total = checks;
    assert(total === 86, `all 86 checks ran, none skipped (ran ${total})`);
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
