// TEMPORARY VERIFICATION PROBE - deleted immediately after. Touches no other file.
/* eslint-disable */
import crypto from "node:crypto";

const KEY = Buffer.alloc(32, 0xfb).toString("base64");
const BEARER = "test-bearer-token-not-a-real-credential";
const SESSION_ID = "3f6b1a2c-0000-4000-8000-000000000001";
const CLIENT_ID = "a1c4e9d2-0000-4000-8000-000000000002";

function env(pin: string) {
  const key = Buffer.from(KEY, "base64");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(pin, "utf8"), c.final()]);
  return `aes-256-gcm$1$${iv.toString("hex")}$${c.getAuthTag().toString("hex")}$${ct.toString("hex")}`;
}

function row(over: Record<string, unknown> = {}) {
  return { id: SESSION_ID, client_id: CLIENT_ID, pin_hash: "scrypt$x", pin_envelope: env("428913"), ...over };
}

async function call() {
  const lines: string[] = [];
  const orig = console.error;
  console.error = ((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }) as typeof console.error;
  const { POST } = await import("./route");
  const req = new Request("http://localhost/api/admin/onboarding/pin", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${BEARER}` },
    body: JSON.stringify({ sessionId: SESSION_ID, actingUserEmail: "a@b.co" }),
  });
  try {
    const res = await POST(req as never);
    let json: Record<string, unknown> = {};
    try { json = (await res.json()) as Record<string, unknown>; } catch { /* non-json */ }
    return { status: res.status, json, lines, threw: null as string | null };
  } catch (e) {
    return { status: -1, json: {} as Record<string, unknown>, lines, threw: e instanceof Error ? e.message : String(e) };
  } finally { console.error = orig; }
}

function stub(r: unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : String((input as Request).url ?? input);
    if (/onboarding_audit_events/.test(u)) return new Response("[]", { status: 201 });
    return new Response(JSON.stringify(r === null ? [] : [r]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function show(label: string, r: Awaited<ReturnType<typeof call>>) {
  const tags = r.lines.filter((l) => l.includes("[pin-reveal]")).map((l) => (l.match(/\[pin-reveal\]\[[A-Z-]+\]/) ?? ["?"])[0]);
  console.log(
    `   st=${String(r.status).padEnd(4)} reason=${String(r.json.reason ?? "-").padEnd(28)} ` +
    `state=${String(r.json.state ?? "—").padEnd(14)} pin=${JSON.stringify(r.json.pin ?? null).padEnd(9)} ` +
    `logs=${(tags.join(",") || "NONE").padEnd(26)}${r.threw ? " THREW=" + r.threw : ""} :: ${label}`,
  );
}

async function main() {
  process.env.PIN_ENCRYPTION_KEY = KEY;
  process.env.SHARED_INTEGRATION_BEARER_TOKEN = BEARER;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9/";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-role-key";

  console.log("=== D1 RE-TEST: is a NON-NULL, UNPARSEABLE envelope still outcome 2? ===");
  const cases: Array<[string, unknown]> = [
    ["version bumped to $2$", "aes-256-gcm$2$" + "aa".repeat(12) + "$" + "bb".repeat(16) + "$aabb"],
    ["4-byte auth tag", "aes-256-gcm$1$" + "aa".repeat(12) + "$" + "bb".repeat(4) + "$aabb"],
    ["1-byte IV", "aes-256-gcm$1$aa$" + "bb".repeat(16) + "$aabb"],
    ["non-hex field", "aes-256-gcm$1$zzzz$" + "bb".repeat(16) + "$aabb"],
    ["wrong algorithm", "aes-128-gcm$1$" + "aa".repeat(12) + "$" + "bb".repeat(16) + "$aabb"],
    ['the string "hello"', "hello"],
    ['the string "   "', "   "],
    ["a NUMBER", 12345],
    ["an OBJECT", { a: 1 }],
    ["parseable but bad ciphertext", "aes-256-gcm$1$" + "aa".repeat(12) + "$" + "bb".repeat(16) + "$aabb"],
    ["CONTROL genuinely NULL = real outcome 2", null],
    ["CONTROL good envelope = outcome 1", env("428913")],
  ];
  for (const [label, e] of cases) {
    stub(row({ pin_envelope: e }));
    show(label, await call());
  }
  console.log("   -> outcome 2 must now be reserved for a genuinely NULL envelope.");
  console.log("\nDONE");
}
main().then(() => process.exit(0));
