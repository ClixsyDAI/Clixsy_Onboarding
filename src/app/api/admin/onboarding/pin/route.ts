import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireBearerToken } from "@/lib/onboarding/require-bearer-token";
import {
  classifyPinState,
  decryptPin,
  isPinEncryptionConfigured,
  isPinEncryptionError,
} from "@/lib/onboarding/pin-encryption";
import {
  createServiceRoleClient,
  insertAuditEventOrThrow,
  AuditWriteError,
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
  actingUserEmail: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .email("actingUserEmail must be an email address"),
  /** Optional free-text reason, surfaced in the audit row. */
  reason: z.string().trim().max(500).optional(),
});

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
  const { sessionId, actingUserEmail, reason } = parsed.data;

  // ---- 4. THE ROW. -------------------------------------------------------
  const supabase = createServiceRoleClient();
  const { data: row, error: readError } = await supabase
    .from("onboarding_sessions")
    .select("id, client_id, pin_hash, pin_envelope")
    .eq("id", sessionId)
    .maybeSingle();

  if (readError) {
    // .error is checked rather than discarded, which is the whole subject of the
    // sibling audit branch. A read failure is NOT "no such session".
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
      return jsonError(500, "pin_envelope_unreadable", { fault: code });
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
      {
        actor: actingUserEmail,
        state,
        pin_returned: pin !== null,
        ...(reason ? { reason } : {}),
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
            "This session is PIN-gated but holds no readable copy, either because it " +
            "predates this feature or because the key was unset when it was minted. " +
            "Regenerating will populate one, and will CHANGE the PIN the client holds.",
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
