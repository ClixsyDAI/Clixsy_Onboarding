// =============================================================
// dashboard-bridge — fire the onboarding→dashboard client webhook
// =============================================================
//
// On a successful onboarding submit (status='submitted'), reconcile the
// client into the dashboard's app/data/projects.json by calling the
// dashboard's bearer-gated POST /api/clients. This is a SIDE EFFECT:
//   - It runs via `after()` so it never blocks the client's submit
//     response and never changes the submit response shape.
//   - A dashboard-unreachable / non-2xx failure is caught, logged, and
//     recorded as a `dashboard_sync_failed` audit event so it is
//     findable and re-fireable. The dashboard endpoint is idempotent
//     (keyed on workbook_id), so a retry never creates a duplicate.
//   - When the client has no workbook_id yet, we don't fabricate one —
//     we record `dashboard_sync_deferred` and return; a later submit or
//     a workbook_id backfill completes the link.
//
// Auth: the SHARED_INTEGRATION_BEARER_TOKEN already shared by both
// projects (same token the dashboard→onboarding calls use). When unset
// (local/dev), the bridge is a no-op so dev/preview aren't broken.

import {
  createServiceRoleClient,
  recordAuditEvent,
  logSupabaseFailure,
  normaliseAuditFault,
  SUPABASE_READ_FAILURE_TAG,
  SUPABASE_READ_TIMEOUT_MS_AFTER,
  type OnboardingSession,
} from "@/lib/supabase/server";

const BRIDGE_ROUTE = "after(POST /api/public/onboarding/submit) → dashboard-bridge";

// The dashboard's canonical production origin. Bearer-authed, so it must
// target the canonical domain directly (a cross-origin redirect would
// strip the Authorization header). Env-overridable.
const DASHBOARD_BASE_URL =
  process.env.DASHBOARD_BASE_URL ?? "https://workbooks.clixsy.co";

// The `safeAudit` wrapper that used to live here is GONE. Its inner catch was
// not fully dead — createServiceRoleClient() genuinely throws when the env is
// missing, which is why the outer catch at the bottom of this file could reach
// it and it could throw a second time from the same cause — but it was the
// wrong shape for the fault that actually happens: postgrest-js RESOLVES both
// an RLS refusal and a transport failure, so the overwhelmingly common case
// never reached that catch at all. `recordAuditEvent` is total (it absorbs the
// client-init throw as fault kind 'client_init') AND loud, so the wrapper has
// nothing left to add.
//
// The OUTER catch below stays. It is live for reasons that have nothing to do
// with auditing: fetch(), AbortSignal.timeout(15000) and res.json() all
// genuinely reject.

export async function fireDashboardClientBridge(
  session: OnboardingSession,
): Promise<void> {
  try {
    const bearer = process.env.SHARED_INTEGRATION_BEARER_TOKEN;
    if (!bearer) {
      console.warn(
        "[dashboard-bridge] SHARED_INTEGRATION_BEARER_TOKEN unset — skipping (dev/preview)",
      );
      return;
    }

    // workbook_id + website_url live in `clients` columns not declared on
    // the Client TS type — query them directly.
    const supabase = createServiceRoleClient();
    // BOUNDED, and the bound is the point.
    //
    // Reading `.error` is NECESSARY BUT NOT SUFFICIENT: a call that never
    // settles has no `.error` to read. This read sits immediately UPSTREAM of
    // the audit write below, inside the same after() callback, so a Supabase
    // that accepts the connection and never answers used to freeze the
    // callback HERE — the audit write was never issued, logAuditWriteFailure
    // never ran, and the operator got nothing at all, with the submit's 200
    // long since shipped. `.abortSignal` must precede `.single()`, which
    // returns a PostgrestBuilder and no longer carries it.
    const {
      data: client,
      error,
      status,
    } = await supabase
      .from("clients")
      .select("client_name, workbook_id, website_url")
      .eq("id", session.client_id)
      .abortSignal(AbortSignal.timeout(SUPABASE_READ_TIMEOUT_MS_AFTER))
      .single();

    if (error) {
      logSupabaseFailure(
        SUPABASE_READ_FAILURE_TAG,
        {
          route: BRIDGE_ROUTE,
          table: "clients",
          eventType: "client_lookup",
          sessionId: session.id,
          clientId: session.client_id,
          succeeded:
            "the submission itself is committed; the dashboard sync did not run, so re-fire the bridge for this session",
        },
        normaliseAuditFault(
          status,
          error,
          "the client lookup was refused with no error body",
        ),
      );
      await recordAuditEvent(
        session.id,
        "dashboard_sync_failed",
        { stage: "client_lookup", error: error.message },
        {
          clientId: session.client_id,
          route: BRIDGE_ROUTE,
          succeeded:
            "the submission itself is committed; the dashboard sync failure on the line above is now unrecorded too, so re-fire the bridge for this session",
        },
      );
      return;
    }

    const workbookId =
      client?.workbook_id !== null && client?.workbook_id !== undefined
        ? String(client.workbook_id)
        : null;

    if (!workbookId) {
      // No id to key on yet — do not fabricate. Deferred, re-runnable.
      console.warn(
        `[dashboard-bridge] session ${session.id} has no workbook_id — dashboard sync deferred (pending backfill)`,
      );
      await recordAuditEvent(
        session.id,
        "dashboard_sync_deferred",
        { reason: "no_workbook_id" },
        {
          clientId: session.client_id,
          route: BRIDGE_ROUTE,
          succeeded:
            "the submission itself is committed; the deferral on the line above is now unrecorded too, so re-fire the bridge once workbook_id is backfilled",
        },
      );
      return;
    }

    const sessionVertical = (session as { vertical?: string }).vertical;
    const payload = {
      workbookId,
      clientName: client?.client_name ?? "Unknown client",
      vertical:
        sessionVertical === "law_firm" || sessionVertical === "home_services"
          ? sessionVertical
          : "other",
      websiteUrl:
        (client as { website_url?: string | null } | null)?.website_url ?? null,
      sessionId: session.id,
    };

    const res = await fetch(`${DASHBOARD_BASE_URL}/api/clients`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      // Bound the wait so a slow/cold dashboard deploy can't hang the
      // after() budget. The dashboard commits to GitHub (~2-3s), so 15s
      // is generous headroom.
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        /* swallow */
      }
      console.error(
        `[dashboard-bridge] dashboard POST /api/clients failed status=${res.status} session=${session.id} body=${body.slice(0, 500)}`,
      );
      await recordAuditEvent(
        session.id,
        "dashboard_sync_failed",
        { status: res.status, body: body.slice(0, 500), workbookId },
        {
          clientId: session.client_id,
          route: BRIDGE_ROUTE,
          succeeded:
            "the submission itself is committed; the dashboard sync failure on the line above is now unrecorded too, so re-fire the bridge for this session",
        },
      );
      return;
    }

    const json = (await res.json().catch(() => ({}))) as {
      action?: string;
      basecamp?: { linked?: boolean };
    };
    console.log(
      `[dashboard-bridge] ok session=${session.id} workbookId=${workbookId} action=${json.action} basecampLinked=${json.basecamp?.linked}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[dashboard-bridge] error session=${session.id}: ${message}`,
    );
    await recordAuditEvent(
      session.id,
      "dashboard_sync_failed",
      { error: message },
      {
        clientId: session.client_id,
        route: BRIDGE_ROUTE,
        succeeded:
          "the submission itself is committed; the dashboard sync failure on the line above is now unrecorded too, so re-fire the bridge for this session",
      },
    );
  }
}
