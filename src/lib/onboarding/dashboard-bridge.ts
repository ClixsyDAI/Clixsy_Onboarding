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
  createAuditEvent,
  type OnboardingSession,
} from "@/lib/supabase/server";

// The dashboard's canonical production origin. Bearer-authed, so it must
// target the canonical domain directly (a cross-origin redirect would
// strip the Authorization header). Env-overridable.
const DASHBOARD_BASE_URL =
  process.env.DASHBOARD_BASE_URL ?? "https://workbooks.clixsy.co";

async function safeAudit(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await createAuditEvent(sessionId, eventType, payload);
  } catch (err) {
    // The bridge must never throw into the submit path, even if auditing fails.
    console.error(
      `[dashboard-bridge] audit write failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

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
    const { data: client, error } = await supabase
      .from("clients")
      .select("client_name, workbook_id, website_url")
      .eq("id", session.client_id)
      .single();

    if (error) {
      console.error(
        `[dashboard-bridge] client lookup failed session=${session.id}: ${error.message}`,
      );
      await safeAudit(session.id, "dashboard_sync_failed", {
        stage: "client_lookup",
        error: error.message,
      });
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
      await safeAudit(session.id, "dashboard_sync_deferred", {
        reason: "no_workbook_id",
      });
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
      await safeAudit(session.id, "dashboard_sync_failed", {
        status: res.status,
        body: body.slice(0, 500),
        workbookId,
      });
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
    await safeAudit(session.id, "dashboard_sync_failed", { error: message });
  }
}
