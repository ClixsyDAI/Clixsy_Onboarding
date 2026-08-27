// TEMPORARY VERIFICATION PROBE - deleted immediately after. Touches no other file.
// THE HAPPY PATH: with a REAL scrypt pin_hash matching the envelope's PIN, does
// the endpoint still return the PIN? A broken cross-check would mean it NEVER does.
/* eslint-disable */
import crypto from "node:crypto";
import { hashPin } from "@/lib/onboarding/pin";

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
    return { status: res.status, json, lines };
  } finally { console.error = orig; }
}

function stub(r: unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : String((input as Request).url ?? input);
    if (/onboarding_audit_events/.test(u)) return new Response("[]", { status: 201 });
    return new Response(JSON.stringify([r]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function main() {
  process.env.PIN_ENCRYPTION_KEY = KEY;
  process.env.SHARED_INTEGRATION_BEARER_TOKEN = BEARER;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9/";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-role-key";

  console.log("=== THE HAPPY PATH with a CONSISTENT row (real scrypt hash of the PIN) ===");
  const realHash = await hashPin("428913");
  stub({ id: SESSION_ID, client_id: CLIENT_ID, pin_hash: realHash, pin_envelope: env("428913") });
  const r = await call();
  const tags = r.lines.filter((l) => l.includes("[pin-reveal]")).map((l) => (l.match(/\[pin-reveal\]\[[A-Z-]+\]/) ?? ["?"])[0]);
  console.log(`   st=${r.status} state=${r.json.state} pin=${JSON.stringify(r.json.pin)} logs=${JSON.stringify(tags)}`);
  console.log(`   ${r.status === 200 && r.json.pin === "428913" ? "OK: the endpoint still reveals a real PIN." : "*** REGRESSION: a consistent row does NOT yield its PIN ***"}`);

  console.log("\n=== and a row whose envelope holds a DIFFERENT PIN than pin_hash (my D4) ===");
  stub({ id: SESSION_ID, client_id: CLIENT_ID, pin_hash: realHash, pin_envelope: env("999111") });
  const r2 = await call();
  const tags2 = r2.lines.filter((l) => l.includes("[pin-reveal]")).map((l) => (l.match(/\[pin-reveal\]\[[A-Z-]+\]/) ?? ["?"])[0]);
  console.log(`   st=${r2.status} reason=${r2.json.reason} pin=${JSON.stringify(r2.json.pin ?? null)} logs=${JSON.stringify(tags2)}`);
  console.log(`   ${r2.json.pin == null ? "OK: the WRONG PIN is no longer handed out." : "*** still hands out a mismatched PIN ***"}`);
  console.log("\nDONE");
}
main().then(() => process.exit(0));
