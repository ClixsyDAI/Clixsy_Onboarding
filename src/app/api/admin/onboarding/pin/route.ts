import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBearerToken } from "@/lib/onboarding/require-bearer-token";
import {
  classifyPinState,
  decryptPin,
  isPinEncryptionConfigured,
  isPinEncryptionError,
} from "@/lib/onboarding/pin-encryption";
// verifyPin is imported, never reimplemented. It is the SAME function the gate
// uses, which is the entire value of the cross-check at step 5b: a local
// reimplementation could agree with the envelope and disagree with the gate,
// which is the failure it exists to catch. pin.ts is unchanged by this branch.
import { verifyPin } from "@/lib/onboarding/pin";
import {
  createServiceRoleClient,
  insertAuditEventOrThrow,
  AuditWriteError,
  withDeadline,
  SUPABASE_READ_TIMEOUT_MS_AFTER,
} from "@/lib/supabase/server";

/**
 * POST /api/admin/onboarding/pin
 *
 * Reveal an existing onboarding PIN in plaintext, so an admin can read it to a
 * client instead of rotating it. Round 1 feedback item 16.
 *
 * Rotating is the alternative and it is destructive: it invalidates the PIN the
 * client is already holding. This route exists so "what is their PIN" stops
 * being a question you can only answer by changing the answer.
 *
 * FAILS CLOSED IN EVERY DIRECTION.
 *
 * POST rather than GET, despite being a read, for two reasons: the acting user's
 * email belongs in a body rather than a URL, and a session id in a query string
 * ends up in access logs and browser history next to the response that carried a
 * credential.
 *
 * THE FOUR OUTCOMES, and keeping them distinct is the whole design:
 *
 *   1. 200 { state: "recoverable",   pin: "428913" }
 *   2. 200 { state: "unrecoverable", pin: null }   PIN exists, no readable copy.
 *                                                 Remedy: regenerate, which
 *                                                 CHANGES the client's PIN.
 *   3. 200 { state: "no_gate",       pin: null }   No PIN protects this session.
 *                                                 Nothing to reveal, nothing
 *                                                 wrong.
 *   4. 503 { reason: "pin_encryption_not_configured" }  This DEPLOYMENT cannot
 *                                                 decrypt anything. Says nothing
 *                                                 about the session.
 *
 * Outcome 4 must never be reported as outcome 2. They look identical to a user
 * ("no PIN came back") and have opposite causes: one is a property of the row,
 * the other of the deployment, and only one is fixed by regenerating. A
 * regeneration performed because of a misread 503 destroys a working PIN for
 * nothing. That confusion is guarded twice, deliberately:
 *
 *   - HERE, by gating on isPinEncryptionConfigured() BEFORE the row is read.
 *   - IN decryptPin, which loads the key before parsing the envelope, so a
 *     configuration fault outranks any row-level fault for every caller.
 *
 * Two independent checks, not redundancy. This one guarantees the endpoint never
 * touches a row it cannot read; the module's guarantees the fault CODE is right
 * if the environment changes between this gate and the decrypt.
 */

const BodySchema = z.object({
  /** The onboarding session whose PIN is being revealed. */
  sessionId: z.string().uuid("sessionId must be a UUID"),
  /**
   * The signed-in admin who asked. REQUIRED, and it is required because it is
   * the point: revealing a live client credential with no attributable actor is
   * not an audit trail, it is a log line. The caller is bearer-authed, so the
   * bearer token proves WHICH SERVICE is asking and this proves WHO asked it to.
   * The bearer token alone cannot distinguish two admins sharing one dashboard.
   */
  //
  // CONSTRAINED, AND REJECTED RATHER THAN TRUNCATED. Validated as an email with
  // a hard 320-char cap (the RFC 5321 maximum), and a value that fails is a 400,
  // never a silently shortened string in an audit row. A truncated actor is worse
  // than a rejected one: it looks like a real answer.
  actingUserEmail: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .email("actingUserEmail must be an email address"),
});

// NO OTHER FREE-TEXT FIELD. A `reason` field was in the first draft of this
// schema and was removed deliberately. See the audit-payload note below: one
// validated free-text field is a downgrade that has to be argued for, and a
// second one with no format at all would not survive the same argument.

function jsonError(status: number, reason: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, reason, ...extra }, { status });
}

export async function POST(request: NextRequest) {
  // ---- 1. AUTH, before anything else touches the database. -----------------
  const auth = requireBearerToken(request);
  if (!auth.ok) {
    // 503 and 401 are deliberately different here. See require-bearer-token.ts:
    // telling an integrator "invalid token" when the SERVER has no token
    // configured sends them to rotate a working credential.
    return jsonError(auth.status, auth.reason);
  }

  // ---- 2. THE CONFIGURATION GATE, before the row is read. ------------------
  // Deliberately ahead of the session lookup. Reading the row first would mean a
  // deployment with no key could still answer "unrecoverable" for a session
  // whose envelope is perfectly good, which is outcome 4 masquerading as
  // outcome 2 and invites a destructive regeneration.
  if (!isPinEncryptionConfigured()) {
    return jsonError(503, "pin_encryption_not_configured", {
      detail:
        "This deployment cannot decrypt PINs. PIN_ENCRYPTION_KEY is unset or not " +
        "usable. This says nothing about the session and regenerating will not help.",
    });
  }

  // ---- 3. PAYLOAD. --------------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, "invalid_payload", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const { sessionId, actingUserEmail } = parsed.data;

  // ---- 4. THE ROW. -------------------------------------------------------
  // createServiceRoleClient THROWS on missing Supabase env vars (server.ts:10).
  // Unwrapped, that was a fifth outcome nobody designed: the handler rejected,
  // Next answered a generic 500 with no `reason` and no `state`, and NOTHING was
  // logged. Measured with both vars unset: 0 fetches, 0 [pin-reveal] lines. It is
  // the same fault class as outcome 4, a deployment that cannot do this job, so
  // it gets the same treatment: named, logged, and explicitly not the session's
  // fault.
  let supabase: ReturnType<typeof createServiceRoleClient>;
  try {
    supabase = createServiceRoleClient();
  } catch (err) {
    console.error(
      `[pin-reveal][CLIENT-UNAVAILABLE] ${JSON.stringify({
        session_id: sessionId,
        actor: actingUserEmail,
        message: String(err instanceof Error ? err.message : err).slice(0, 300),
        succeeded: "nothing was revealed; this deployment cannot reach Supabase",
      })}`,
    );
    return jsonError(500, "supabase_client_unavailable", {
      detail:
        "This deployment is missing its Supabase configuration. This says nothing " +
        "about the session, and regenerating will not help.",
    });
  }

  // BOUNDED. Reading .error is necessary but NOT sufficient, which is the whole
  // subject of the sibling audit branch: a call that never settles has no .error
  // to read, and this route's own comment below used to claim the .error half
  // while skipping the deadline half. An unbounded read against a stalled
  // Supabase yields a platform timeout with no log line and no response contract
  // at all. withDeadline and the budget both come from the audit branch.
  type SessionRow = {
    id: string;
    client_id: string | null;
    pin_hash: string | null;
    pin_envelope?: string | null;
  };
  let row: SessionRow | null;
  let readError: { code?: string; message?: string } | null = null;
  try {
    // The signal is threaded into .abortSignal() rather than only raced against.
    // Racing alone would return control while the request stayed in flight; the
    // signal makes the deadline actually cancel it.
    // `async (signal) => await builder`, not `(signal) => builder`. A
    // PostgrestBuilder is a THENABLE, not a Promise: it has .then but no .catch
    // or .finally, so withDeadline's `Promise<T>` parameter rejects it and its
    // own `work.catch(() => {})` would throw on it. Awaiting inside an async
    // runner converts it to a real promise. tsc caught this, not a test.
    const res = await withDeadline(
      "pin-reveal session read",
      SUPABASE_READ_TIMEOUT_MS_AFTER,
      async (signal) =>
        await supabase
          .from("onboarding_sessions")
          .select("id, client_id, pin_hash, pin_envelope")
          .eq("id", sessionId)
          .abortSignal(signal)
          .maybeSingle(),
    );
    row = (res.data as SessionRow | null) ?? null;
    readError = res.error ?? null;
  } catch (err) {
    // The deadline fired, or the promise rejected outright. Either way there is
    // no row and no .error, so this must not fall through to the checks below.
    console.error(
      `[pin-reveal][READ-TIMEOUT] ${JSON.stringify({
        session_id: sessionId,
        actor: actingUserEmail,
        budget_ms: SUPABASE_READ_TIMEOUT_MS_AFTER,
        message: String(err instanceof Error ? err.message : err).slice(0, 300),
        succeeded: "nothing was revealed; the session read did not settle",
      })}`,
    );
    return jsonError(504, "session_read_timeout", {
      detail: "The database did not answer in time. Nothing was revealed. Retry.",
    });
  }

  if (readError) {
    // .error is checked rather than discarded AND the call above is bounded,
    // which are the two halves of the sibling audit branch's rule. A read
    // failure is NOT "no such session".
    console.error(
      `[pin-reveal][READ-FAILURE] ${JSON.stringify({
        session_id: sessionId,
        actor: actingUserEmail,
        pg_code: readError.code || null,
        message: String(readError.message ?? "").slice(0, 300),
      })}`,
    );
    return jsonError(500, "session_read_failed");
  }
  if (!row) return jsonError(404, "session_not_found");

  const state = classifyPinState(row);

  // ---- 4b. A STORED VALUE THAT IS NOT AN ENVELOPE. ------------------------
  // Same 500 as a decrypt failure, deliberately, because it is the same fact:
  // something is in that column and this endpoint cannot read it.
  //
  // What it must NOT do is fall through to outcome 2. A critic found that it did:
  // a bumped version prefix, a short auth tag, non-hex fields and the string
  // "hello" all came back 200 "unrecoverable" with the response telling the
  // operator the row "predates this feature" and inviting a regeneration that
  // overwrites corrupt data before anyone has looked at it. See PinState.
  if (state === "envelope_unreadable") {
    console.error(
      `[pin-reveal][ENVELOPE-MALFORMED] ${JSON.stringify({
        session_id: sessionId,
        client_id: row.client_id ?? null,
        actor: actingUserEmail,
        fault: "structure",
        envelope_type: typeof row.pin_envelope,
        succeeded:
          "nothing was revealed; the column holds something that is not an envelope",
      })}`,
    );
    return jsonError(500, "pin_envelope_unreadable", {
      detail:
        "This session is PIN-gated and the stored copy is not readable by this " +
        "endpoint. Do NOT regenerate yet: regenerating overwrites what is there " +
        "and changes the PIN the client holds. Investigate the row first.",
    });
  }

  // ---- 5. DECRYPT, only when there is something to decrypt. ---------------
  let pin: string | null = null;
  if (state === "recoverable") {
    try {
      pin = decryptPin(row.pin_envelope);
    } catch (err) {
      // decryptPin orders configuration BEFORE structure, so a `configuration`
      // code here means the environment changed since the gate above. It maps to
      // the same 503 as the gate, or 503 and 500 collapse into each other and
      // outcome 4 becomes indistinguishable from a server error again.
      const code = isPinEncryptionError(err) ? err.code : "unknown";
      if (code === "configuration") {
        // LOGGED, because "the environment changed between the gate and the
        // decrypt" is the kind of thing that leaves no other trace. Without this
        // line the only record was a 503 indistinguishable from the gate's own.
        console.error(
          `[pin-reveal][CONFIG-CHANGED-MID-REQUEST] ${JSON.stringify({
            session_id: sessionId,
            client_id: row.client_id ?? null,
            actor: actingUserEmail,
            succeeded:
              "nothing was revealed; the key stopped being usable after the gate passed",
          })}`,
        );
        return jsonError(503, "pin_encryption_not_configured", {
          detail: "PIN_ENCRYPTION_KEY became unusable between the check and the read.",
        });
      }
      console.error(
        `[pin-reveal][DECRYPT-FAILURE] ${JSON.stringify({
          session_id: sessionId,
          client_id: row.client_id ?? null,
          actor: actingUserEmail,
          fault: code,
          succeeded: "nothing was revealed; the stored envelope is unreadable",
        })}`,
      );
      // NOT outcome 2. The envelope exists and is broken, which is a different
      // fact from "there is no envelope", and only this one warrants
      // investigating the data.
      //
      // `fault` is in the LOG LINE above and deliberately NOT in the body. It is
      // an internal taxonomy (encoding / integrity / decryption / input /
      // unknown) and anything in a response body eventually reaches a screen.
      // The response says what to do; the log says what broke.
      return jsonError(500, "pin_envelope_unreadable", {
        detail:
          "This session is PIN-gated and the stored copy could not be decrypted. " +
          "Do NOT regenerate yet: regenerating changes the PIN the client holds. " +
          "Investigate the row first.",
      });
    }
  }

  // ---- 5b. THE DECRYPTED PIN MUST BE THE PIN THE GATE ACTUALLY ACCEPTS. ---
  // Without this, `recoverable` means only "an envelope decrypted", and the
  // endpoint would hand over a six-digit number with full confidence and no
  // warning even when it is the wrong one. encryptPin binds no AAD and no session
  // id, so an envelope minted for another session decrypts perfectly here:
  // measured, that produced 200 recoverable with a PIN belonging to a different
  // client. pin_hash is already selected, and verifyPin is the same function the
  // gate uses, so checking costs one scrypt and upgrades the claim from "this
  // decrypted" to "this is the PIN the client can log in with".
  //
  // Both writers (rotate-pin.ts and the create route) write pin_hash and
  // pin_envelope in ONE statement, so a mismatch is not reachable through the
  // application today. It is reachable through a partial restore, a hand-edited
  // row, or a future writer that updates one column, and the failure it prevents
  // is an admin reading a wrong PIN aloud to a client.
  if (pin !== null) {
    const matchesGate = await verifyPin(pin, row.pin_hash ?? "");
    if (!matchesGate) {
      console.error(
        `[pin-reveal][PIN-HASH-MISMATCH] ${JSON.stringify({
          session_id: sessionId,
          client_id: row.client_id ?? null,
          actor: actingUserEmail,
          succeeded:
            "nothing was revealed; the envelope decrypted but does not match pin_hash",
        })}`,
      );
      return jsonError(500, "pin_envelope_mismatch", {
        detail:
          "The stored copy decrypted but is NOT the PIN this session's gate " +
          "accepts, so it was withheld rather than read out. The two columns " +
          "disagree. Do NOT regenerate before investigating.",
      });
    }
  }

  // ---- 6. AUDIT, FAIL CLOSED, BEFORE the PIN is returned. -----------------
  // insertAuditEventOrThrow from the audit branch: it throws AuditWriteError on
  // failure and deliberately does NOT log, because the caller owns the log line
  // and the response it becomes. This route is that caller.
  //
  // The audit runs BEFORE the response is built, not in after(). A revealed
  // credential with no durable record of who revealed it is precisely what this
  // row exists to prevent, so the reveal does not happen unless the record does.
  try {
    await insertAuditEventOrThrow(
      sessionId,
      "pin_revealed",
      // THE AUDIT PAYLOAD, AND A GUARANTEE THAT CHANGED KIND.
      //
      // An earlier critic verified this payload was provably PIN-free BY TYPE:
      // every value was one of six string literals or a boolean, so no free-text
      // field existed for a PIN to reach even by mistake. `actor` is the first
      // free-text value here, so that guarantee is now STRUCTURAL NO LONGER. It
      // rests on Zod's email validation and on the dashboard sending what it
      // says it is sending.
      //
      // That is a real downgrade and it is recorded rather than glossed. What
      // replaces the type-level guarantee:
      //   - `actor` is validated as an email, capped at 320, and REJECTED rather
      //     than truncated, so it cannot be arbitrary text.
      //   - No second free-text field. `reason` was dropped from the first draft.
      //   - `state` is one of the PinState literals, `pin_returned` a boolean.
      //   - A test asserts the payload's exact key set and that the PIN appears
      //     nowhere in the serialised row, so the property is checked rather than
      //     merely intended.
      {
        actor: actingUserEmail,
        state,
        pin_returned: pin !== null,
      },
      {
        route: "POST /api/admin/onboarding/pin",
        clientId: row.client_id ?? null,
        succeeded:
          "NOTHING was revealed to the caller: the audit row failed, so the response " +
          "carries no PIN. The client's PIN is unchanged and needs no action.",
      },
    );
  } catch (err) {
    // WHY THIS ROUTE IS CLEAR OF THE AUDIT BRANCH'S TWO KNOWN LIMITATIONS, and
    // it is an enumeration rather than one lucky path.
    //
    // Those limitations are: normaliseAuditFault can throw on an exotic error
    // object, and safeField's catch uses instanceof so a throwing
    // getPrototypeOf trap makes the floor emit nothing. Neither can bite here.
    //
    // First, safeField and logAuditWriteFailure are unreachable: they are called
    // only from recordAuditRow, the DEGRADE entry point. This route uses
    // insertAuditEventOrThrow, which by design does not log at all. The line
    // below is ours.
    //
    // Second, EVERY WAY an error object reaches normaliseAuditFault on this
    // route was enumerated against the installed postgrest-js 2.89.0, not
    // inferred from the one path that was driven:
    //
    //   PostgrestBuilder.ts:161  plain object literal (PGRST116). Only reachable
    //                            for maybeSingle() on a GET; this is an INSERT.
    //   PostgrestBuilder.ts:182  JSON.parse(body). Own data properties only;
    //                            JSON.parse cannot create an accessor, and no
    //                            reviver is passed. A "__proto__" key becomes an
    //                            own property, not a prototype write.
    //   PostgrestBuilder.ts:197  plain object literal { message: body } where
    //                            body is a string from res.text(). This is the
    //                            non-JSON path, exercised with an HTML body.
    //   PostgrestBuilder.ts:251  plain object literal, fetch-layer failure and
    //                            abort/timeout. Message is a template string.
    //
    // All four are plain objects with own data properties. None can carry a
    // throwing getter or an exotic prototype, because none of them is
    // caller-supplied: postgrest-js builds all of them.
    //
    // Third, even if one could, attemptAuditWrite wraps the normalise call in
    // its own try whose catch returns { kind: 'unknown' }. That containment is
    // demonstrated rather than assumed: a wire body with a NUMBER message makes
    // normaliseAuditFault throw, and what comes out here is still a proper
    // AuditWriteError with kind 'unknown'. The route's tests drive it.
    //
    // If a future change makes an error object on this route caller-supplied,
    // this enumeration stops holding and those two limitations stop being
    // follow-ups.

    // OWNED LOG LINE. A fixed literal tag first so it is greppable, then one
    // line of JSON. This is the only record that an attempt happened, so it is
    // emitted before anything else can fail.
    const fault = err instanceof AuditWriteError ? err.fault : undefined;
    console.error(
      `[pin-reveal][AUDIT-FAILURE] ${JSON.stringify({
        session_id: sessionId,
        client_id: row.client_id ?? null,
        actor: actingUserEmail,
        state,
        fault: fault?.kind ?? "unknown",
        status: fault?.status ?? null,
        pg_code: fault?.code ?? null,
        message: String(fault?.message ?? (err instanceof Error ? err.message : err)).slice(0, 300),
        succeeded: "nothing was revealed; no PIN left this endpoint",
      })}`,
    );
    return jsonError(500, "audit_write_failed", {
      detail: "The reveal was not recorded, so no PIN was returned. Retry.",
    });
  }

  // ---- 7. THE ANSWER. ----------------------------------------------------
  return NextResponse.json({
    ok: true,
    sessionId,
    state,
    pin,
    ...(state === "unrecoverable"
      ? {
          detail:
            // DESCRIBES THE STATE, DOES NOT DIAGNOSE A CAUSE, and the tone is
            // deliberate. Every one of the 82 sessions that predate the
            // pin_envelope column reads this, so an operator will see it many
            // times in a row for rows where nothing has gone wrong. An earlier
            // version said the row "predates this feature or the key was unset
            // when it was minted", which guessed at a cause and was false for a
            // corrupt row; the version after that said it stores "NO copy of the
            // PIN at all", which is true but reads like a fault. This one states
            // the fact and the consequence and nothing else.
            //
            // The last sentence stays, in caps, because it is the load-bearing
            // part: this is the one outcome that offers the destructive action,
            // and the client's PIN really does change.
            "No readable copy of this PIN is stored, so it cannot be shown. " +
            "Regenerating will create one, and will CHANGE the PIN the client holds.",
        }
      : {}),
    ...(state === "no_gate"
      ? { detail: "This session is not PIN-gated. There is nothing to reveal." }
      : {}),
  });
}

/** Anything other than POST, so a GET cannot end up with a PIN in a URL. */
export async function GET() {
  return jsonError(405, "method_not_allowed", {
    detail: "Use POST. A session id in a query string ends up in logs and history.",
  });
}

/** Exported for the route test only. */
export const _internal = { BodySchema };
