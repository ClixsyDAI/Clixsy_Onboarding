// TEMPORARY VERIFICATION PROBE - deleted immediately after. Touches no other file.
// Fresh process with the Supabase env vars DELETED before the first import of
// server.ts, so createServiceRoleClient throws. Measures whether the committed
// fix (500 supabase_client_unavailable) survives the UNCOMMITTED rethrow.
/* eslint-disable */
const BEARER = "test-bearer-token-not-a-real-credential";
const SESSION_ID = "3f6b1a2c-0000-4000-8000-000000000001";

process.env.PIN_ENCRYPTION_KEY = Buffer.alloc(32, 0xfb).toString("base64");
process.env.SHARED_INTEGRATION_BEARER_TOKEN = BEARER;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

globalThis.fetch = (async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

const lines: string[] = [];
const orig = console.error;
console.error = ((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }) as typeof console.error;

async function main() {
  const { POST } = await import("./route");
  const req = new Request("http://localhost/api/admin/onboarding/pin", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${BEARER}` },
    body: JSON.stringify({ sessionId: SESSION_ID, actingUserEmail: "a@b.co" }),
  });
  let outcome: string;
  try {
    const res = await POST(req as never);
    outcome = `RESOLVED status=${res.status} body=${JSON.stringify(await res.json()).slice(0, 130)}`;
  } catch (e) {
    outcome = `*** THREW OUT OF THE HANDLER: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.error = orig;
  console.log("=== D2 RE-TEST with the uncommitted `if (Number(\"1\") === 1) throw err;` present ===");
  console.log(`   outcome : ${outcome}`);
  console.log(`   [pin-reveal] lines: ${lines.filter((l) => l.includes("[pin-reveal]")).length}`);
  console.log(`   tags    : ${JSON.stringify(lines.map((l) => (l.match(/\[pin-reveal\]\[[A-Z-]+\]/) ?? ["?"])[0]))}`);
  console.log("   EXPECTED from commit 3847df9: RESOLVED 500 reason=supabase_client_unavailable");
}
main().then(() => process.exit(0));
