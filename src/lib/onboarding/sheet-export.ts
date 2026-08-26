// =============================================================
// sheet-export — append the submitted onboarding to the roster Sheet
// =============================================================
//
// On a successful onboarding submit (status='submitted'), write one row
// (columns A–O) to the client-roster Google Sheet. Fired from the submit
// route's after() alongside fireDashboardClientBridge — same contract:
//   - NEVER throws into the submit path; every failure is caught, logged
//     as `[sheet-export] failed`, and recorded as a `sheet_export_failed`
//     audit event (mirrors the bridge's dashboard_sync_failed pattern).
//   - When GOOGLE_SHEETS_CLIENT_EMAIL is unset (local/dev), it is a
//     logged no-op so dev/preview never error.
//
// One row per client, keyed on the workbook id (clients.workbook_id —
// the GHL opportunity id, the same stable key the dashboard bridge
// reconciles on), written to column O. Existing row with this workbook
// id → update in place; none → append. Submissions with no workbook_id
// (the bridge's deferred case) fall back to append-only with an empty
// column O and a `[sheet-export] warn no-workbook-id` log line.
//
// NO J-number is minted here anymore. Per the approve-and-push design
// (R8) the J is minted at dashboard approval, so column B (Client Code)
// is written BLANK — the roster is now purely a continuity/append log.
// This function ALSO seeds public.pm_tracker_pushes (keyed on
// workbook_id, status='pending', j_number=null) with the onboarding-
// derived fields the dashboard approval UI needs.
//
// Values are written RAW (never formulas). Enumerated answers
// (radio/select/multiselect with static options) are written as their
// human labels, resolved generically from onboardingStepsV2; free-text
// answers pass through; missing answers write an empty cell.

import { JWT } from 'google-auth-library';
import {
  createServiceRoleClient,
  recordAuditEvent,
  getSessionAnswers,
  logSupabaseFailure,
  logUpstreamFailure,
  normaliseAuditFault,
  normaliseThrownFault,
  SUPABASE_READ_FAILURE_TAG,
  SUPABASE_WRITE_FAILURE_TAG,
  SUPABASE_READ_TIMEOUT_MS_AFTER,
  UPSTREAM_HTTP_FAILURE_TAG,
  BOUNDED_STAGE_FAILURE_TAG,
  type OnboardingSession,
} from '@/lib/supabase/server';
import { onboardingStepsV2 } from './steps-v2';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

const HEADER = [
  'Status',
  'Client Code',
  'Business Name',
  'Primary Contact',
  'Title/Role',
  'Email',
  'Phone',
  'Website URL',
  'Physical Address',
  'Service Area',
  'Primary Services',
  '#1 Goal',
  'Website Platform',
  'Submitted Date',
  'Workbook ID',
];

type AnswersByStep = Record<string, Record<string, unknown>>;

// ── Generic value→label resolution from the steps definition ────
// Only fields with STATIC options get label mapping; cascading fields
// (optionsFromField, e.g. home-services service_categories) fall back
// to their raw stored values.
interface LooseField {
  name: string;
  options?: Array<{ value: string; label: string }>;
}
interface LooseStep {
  key: string;
  fields?: LooseField[];
}

const FIELD_OPTIONS: Map<string, Map<string, string>> = (() => {
  const map = new Map<string, Map<string, string>>();
  for (const step of onboardingStepsV2 as unknown as LooseStep[]) {
    for (const field of step.fields ?? []) {
      if (Array.isArray(field.options) && field.options.length > 0) {
        map.set(
          `${step.key}.${field.name}`,
          new Map(field.options.map((o) => [o.value, o.label])),
        );
      }
    }
  }
  return map;
})();

function display(
  answers: AnswersByStep,
  stepKey: string,
  fieldName: string,
): string {
  const raw = answers[stepKey]?.[fieldName];
  if (raw === null || raw === undefined) return '';
  const opts = FIELD_OPTIONS.get(`${stepKey}.${fieldName}`);
  if (Array.isArray(raw)) {
    return raw
      .map((v) => opts?.get(String(v)) ?? String(v))
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .join(', ');
  }
  const s = String(raw).trim();
  if (!s) return '';
  return opts?.get(s) ?? s;
}

// ===========================================================================
// BOUNDING THE GOOGLE CALLS — the same gap, one dependency further out
// ===========================================================================
//
// THE GAP. Every Google HTTP call on this path was UNBOUNDED, and all four of
// them sit UPSTREAM of this file's own `sheet_export_failed` audit write, on
// the same after() callback. `jwt.request()` goes google-auth-library →
// gaxios 7.1.6 → node-fetch 3.3.2 → `node:https.request`, passing no timeout
// at any layer, and gaxios arms an abort signal ONLY under `if (opts.timeout)`
// (gaxios.js:432, `#appendTimeoutToSignal`). `node:http.ClientRequest` has NO
// default timeout, so there is not even undici's 300s floor that motivated
// bounding the Supabase calls — a socket that is accepted and never answered
// waits forever.
//
// MEASURED, on the previous revision, with the token mint answering normally
// and only `GET /v4/spreadsheets/{id}/values/A1:O1` accepted-but-never-
// answered: `exportSubmissionToSheet` NEVER SETTLED (20,017ms and counting),
// the audit POST was never issued, and the operator saw one success line and
// nothing else. The submit's 200 had shipped long before.
//
// THE BOUND, and why it is placed in two places rather than one:
//
//   `transporterOptions` is handed to `new Gaxios(...)` as its DEFAULTS
//   (authclient.js:68), and `#prepareRequest` merges defaults under every
//   request (gaxios.js:300) before arming the signal. That reaches the ONE
//   call this module cannot pass options to: the OAuth2 token mint, whose
//   gaxios options are built inside google-auth-library
//   (gtoken/getToken.js:27-39, `GOOGLE_TOKEN_URL`) and carry no timeout of
//   their own. It travels through `JWT.createGToken()`, which hands the
//   client's own transporter to GoogleToken (jwtclient.js:213).
//
//   The per-call `timeout` is then ALSO set at each call site, so the bound is
//   visible where the request is written and survives a future refactor that
//   builds the JWT somewhere else.
//
// VERIFIED EMPIRICALLY against the installed stack, not inferred: with a
// loopback stub that accepts and never answers, a token-mint stall, a
// values-read stall, a values-PUT stall and a values-append stall each
// rejected at the bound (1,514 / 1,506 / 1,508 / 1,519ms against a 1,500ms
// setting) and the stub saw exactly ONE request per call — gaxios does NOT
// retry an abort, because `shouldRetryRequest` returns false while
// `err.config.signal.aborted` is true and the code is not 'TimeoutError'
// (retry.js:92-95). Without the bound the same stall was still pending at 3s.
// The rejection is a plain Error named 'Error', message 'The operation was
// aborted.', `code === undefined` — which is why `normaliseThrownFault`
// matches on the message as well as the name.
//
/**
 * 8s. Generous against a healthy Sheets API (single-digit to low-hundreds of
 * ms for these ranges) and small enough that the four calls together cannot
 * dominate the submit route's after() budget, which already carries a 5s bound
 * on each of four Supabase calls on the same callback.
 */
const GOOGLE_HTTP_TIMEOUT_MS = 8_000;

function makeJwt(): JWT {
  return new JWT({
    email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    key: (process.env.GOOGLE_SHEETS_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    // Reaches the token mint, which takes no options from this file.
    transporterOptions: { timeout: GOOGLE_HTTP_TIMEOUT_MS },
  });
}

/**
 * Every Google call goes through here, so no site can be added later without
 * one. Three things happen that a bare `jwt.request` does not do:
 *
 *   1. the bound is applied (gaxios's own supported knob);
 *   2. a failure is REPORTED as one tagged, structured line naming WHICH call
 *      stalled — the raw rejection says only 'The operation was aborted.',
 *      which tells an operator nothing about which of the four it was;
 *   3. the rethrown error carries that label, so the existing
 *      `[sheet-export] failed` line and the `sheet_export_failed` audit
 *      payload downstream name the stalled call too.
 */
async function googleRequest<T>(
  jwt: JWT,
  ctx: { sessionId: string; clientId: string | null },
  label: string,
  opts: { url: string; method?: 'GET' | 'PUT' | 'POST'; data?: unknown },
): Promise<T> {
  try {
    const res = await jwt.request<T>({
      url: opts.url,
      ...(opts.method ? { method: opts.method } : {}),
      ...(opts.data === undefined ? {} : { data: opts.data }),
      timeout: GOOGLE_HTTP_TIMEOUT_MS,
    });
    return res.data;
  } catch (err) {
    const fault = normaliseThrownFault(err);
    logUpstreamFailure(
      UPSTREAM_HTTP_FAILURE_TAG,
      {
        route: SHEET_EXPORT_ROUTE,
        target: `google:${label}`,
        eventType: 'sheet_export_google_call',
        sessionId: ctx.sessionId,
        clientId: ctx.clientId,
        succeeded: GOOGLE_CALL_SUCCEEDED,
      },
      fault,
    );
    // The rethrown message is the NORMALISED one, not the raw rejection.
    // It flows into the outer catch's tagged line and into the
    // sheet_export_failed audit payload, both of which are downstream of this
    // frame — so a Google error body arrives there already length-bounded
    // rather than pasted in whole. (D5: the `[sheet-export] failed` line that
    // used to CONCATENATE it — named here and left alone in the previous
    // revision — now goes through `logUpstreamFailure` like everything else,
    // so the text is escaped as well as bounded. See the outer catch.)
    throw new Error(`google ${label}: ${fault.message}`, { cause: err });
  }
}

/**
 * Mint the access token as its OWN labelled, bounded step rather than letting
 * it happen implicitly inside the first `valuesGet`. Otherwise a token-mint
 * stall is reported against whichever Sheets call happened to trigger it, and
 * an operator is sent to look at the spreadsheet when the problem is the
 * service account's credentials or `oauth2.googleapis.com`.
 *
 * The subsequent `jwt.request` calls reuse the credentials cached here, so
 * this is one extra label, not one extra round trip.
 */
async function authorizeJwt(
  jwt: JWT,
  ctx: { sessionId: string; clientId: string | null },
): Promise<void> {
  try {
    await jwt.authorize();
  } catch (err) {
    const fault = normaliseThrownFault(err);
    logUpstreamFailure(
      UPSTREAM_HTTP_FAILURE_TAG,
      {
        route: SHEET_EXPORT_ROUTE,
        target: 'google:oauth2 token mint',
        eventType: 'sheet_export_google_call',
        sessionId: ctx.sessionId,
        clientId: ctx.clientId,
        succeeded: GOOGLE_CALL_SUCCEEDED,
      },
      fault,
    );
    throw new Error(`google oauth2 token mint: ${fault.message}`, { cause: err });
  }
}

async function valuesGet(
  jwt: JWT,
  ctx: { sessionId: string; clientId: string | null },
  sheetId: string,
  range: string,
): Promise<string[][]> {
  const data = await googleRequest<{ values?: string[][] }>(jwt, ctx, `values.get ${range}`, {
    url: `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`,
  });
  return data?.values ?? [];
}

async function valuesUpdate(
  jwt: JWT,
  ctx: { sessionId: string; clientId: string | null },
  sheetId: string,
  range: string,
  rows: string[][],
): Promise<void> {
  await googleRequest(jwt, ctx, `values.update ${range}`, {
    url: `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    method: 'PUT',
    data: { values: rows },
  });
}

async function valuesAppend(
  jwt: JWT,
  ctx: { sessionId: string; clientId: string | null },
  sheetId: string,
  rows: string[][],
): Promise<void> {
  await googleRequest(jwt, ctx, 'values.append A1:O', {
    url: `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent('A1:O')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    method: 'POST',
    data: { values: rows },
  });
}

// The `safeAudit` wrapper that used to live here is GONE, for the same reason
// as the bridge's twin: its inner catch was reachable ONLY via
// createServiceRoleClient() throwing on missing env (which is also what would
// have got us into the outer catch below in the first place), and it was the
// wrong shape for the fault that actually happens — postgrest-js RESOLVES both
// an RLS refusal and a transport failure, so the common case never reached it.
// `recordAuditEvent` is total AND loud, so the wrapper has nothing to add.
//
// The OUTER catch at the bottom of exportSubmissionToSheet STAYS. It is live
// on its own merits: the google-auth-library JWT sign and every jwt.request()
// genuinely reject.

/** Where a sheet-export audit write came from, for the failure log line. */
const SHEET_EXPORT_ROUTE =
  'after(POST /api/public/onboarding/submit) → sheet-export';

/**
 * What survived a failed Google call. Stated once so all four calls say the
 * same true thing: the submission is committed and the pm_tracker seed above
 * has already run by the time any of these fire.
 */
const GOOGLE_CALL_SUCCEEDED =
  'the submission itself is committed and the pm_tracker seed already ran; only the roster sheet row is missing, so re-run the export for this session';

export async function exportSubmissionToSheet(
  session: OnboardingSession,
): Promise<void> {
  try {
    if (!process.env.GOOGLE_SHEETS_CLIENT_EMAIL) {
      console.warn(
        '[sheet-export] GOOGLE_SHEETS_CLIENT_EMAIL unset — skipping (dev/preview)',
      );
      return;
    }
    const sheetId = process.env.EXPORT_SHEET_ID;
    if (!sheetId || !process.env.GOOGLE_SHEETS_PRIVATE_KEY) {
      console.warn(
        '[sheet-export] EXPORT_SHEET_ID or GOOGLE_SHEETS_PRIVATE_KEY unset — skipping',
      );
      return;
    }

    // ── Gather the submission data ──────────────────────────────
    //
    // EVERY Supabase call below is BOUNDED and every `.error` is READ. Both
    // halves are required and neither is sufficient on its own:
    //
    //   - `.error` was DISCARDED here and on the submitted_at re-read below,
    //     so a refusal degraded the row silently — a blank Business Name and
    //     a blank Workbook ID in the roster, with nothing said.
    //   - and a call that NEVER SETTLES has no `.error` to read. These calls
    //     sit UPSTREAM of the audit write in the same after() callback, so an
    //     unbounded stall froze the callback here: no sheet row, no
    //     pm_tracker seed, no audit event, no log line, and the submit's 200
    //     already shipped. That is the shape the whole bounding exercise
    //     exists to remove, and bounding only the write left it wide open.
    //
    // `.abortSignal` precedes `.maybeSingle()` because maybeSingle returns a
    // PostgrestBuilder, which does not carry it.
    const supabase = createServiceRoleClient();
    const SHEET_EXPORT_SUCCEEDED =
      'the submission itself is committed; the roster row and the pm_tracker seed may be missing or incomplete, so re-run the export for this session';
    const {
      data: client,
      error: clientErr,
      status: clientStatus,
    } = await supabase
      .from('clients')
      .select('client_name, website_url, workbook_id')
      .eq('id', session.client_id)
      .abortSignal(AbortSignal.timeout(SUPABASE_READ_TIMEOUT_MS_AFTER))
      .maybeSingle();
    if (clientErr) {
      logSupabaseFailure(
        SUPABASE_READ_FAILURE_TAG,
        {
          route: SHEET_EXPORT_ROUTE,
          table: 'clients',
          eventType: 'client_lookup',
          sessionId: session.id,
          clientId: session.client_id,
          succeeded: SHEET_EXPORT_SUCCEEDED,
        },
        normaliseAuditFault(clientStatus, clientErr, 'the client lookup was refused with no error body'),
      );
    }
    const workbookId =
      client?.workbook_id !== null && client?.workbook_id !== undefined
        ? String(client.workbook_id).trim()
        : '';

    // Bounded and reported for the same reason as its siblings: this helper is
    // shared with two request-path callers, so the bound is passed in here
    // rather than baked into it.
    const answerRows = await getSessionAnswers(session.id, {
      timeoutMs: SUPABASE_READ_TIMEOUT_MS_AFTER,
      readFailure: {
        tag: SUPABASE_READ_FAILURE_TAG,
        route: SHEET_EXPORT_ROUTE,
        eventType: 'answers_lookup',
        clientId: session.client_id,
        succeeded: SHEET_EXPORT_SUCCEEDED,
      },
    });
    const answers: AnswersByStep = {};
    for (const r of answerRows) {
      answers[r.step_key] = (r.answers as Record<string, unknown>) ?? {};
    }

    // The session object in scope was fetched BEFORE updateSessionStep
    // stamped submitted_at — re-read it for the real timestamp.
    const {
      data: fresh,
      error: freshErr,
      status: freshStatus,
    } = await supabase
      .from('onboarding_sessions')
      .select('submitted_at')
      .eq('id', session.id)
      .abortSignal(AbortSignal.timeout(SUPABASE_READ_TIMEOUT_MS_AFTER))
      .maybeSingle();
    if (freshErr) {
      logSupabaseFailure(
        SUPABASE_READ_FAILURE_TAG,
        {
          route: SHEET_EXPORT_ROUTE,
          table: 'onboarding_sessions',
          eventType: 'submitted_at_reread',
          sessionId: session.id,
          clientId: session.client_id,
          succeeded: SHEET_EXPORT_SUCCEEDED,
        },
        normaliseAuditFault(
          freshStatus,
          freshErr,
          'the submitted_at re-read was refused with no error body',
        ),
      );
    }
    const submittedDate = String(
      fresh?.submitted_at ?? session.submitted_at ?? new Date().toISOString(),
    ).slice(0, 10);

    const businessName =
      display(answers, 'business_overview', 'business_name') ||
      client?.client_name ||
      '';
    const websiteUrl =
      display(answers, 'primary_contact', 'website_url') ||
      // Legacy pre-Phase-3 sessions stored the URL on business_overview.
      display(answers, 'business_overview', 'website_url') ||
      client?.website_url ||
      '';
    // Law-firm sessions answer primary_case_types_keywords; home-services
    // sessions answer service_categories (labels unavailable for the
    // cascade — raw values pass through).
    const primaryServices =
      display(answers, 'seo_targeting', 'primary_case_types_keywords') ||
      display(answers, 'seo_targeting', 'service_categories');

    // Contact + address + meta, computed once and reused by BOTH the
    // roster row and the pm_tracker_pushes seed below.
    const mainContactName = display(answers, 'primary_contact', 'main_contact_name');
    const mainContactTitle = display(answers, 'primary_contact', 'main_contact_title');
    const mainContactEmail = display(answers, 'primary_contact', 'main_contact_email');
    const mainContactPhone = display(answers, 'primary_contact', 'main_contact_phone');
    const physicalAddress = display(answers, 'business_overview', 'physical_address');
    const serviceAreaType = display(answers, 'seo_targeting', 'service_area_type');
    const primaryGoal = display(answers, 'goals_strategy', 'primary_goal');
    const websitePlatform = display(answers, 'technical_setup', 'website_platform');
    // Bare registrable host from the website URL, for the pending record.
    const domain = websiteUrl
      ? websiteUrl.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim()
      : '';
    const rawVertical = (session as { vertical?: string }).vertical;
    const vertical =
      rawVertical === 'law_firm' || rawVertical === 'home_services'
        ? rawVertical
        : 'other';

    // ── Seed the approve-and-push pending record (Supabase) ─────
    // One row per client keyed on workbook_id. NO J-number is minted here
    // (R8: minted at dashboard approval). We upsert ONLY the onboarding-
    // derived columns; on insert status defaults 'pending' and j_number is
    // null, and because the AM-entered fields / j_number / push bookkeeping
    // are NOT in the payload, a re-submit never clobbers them or a
    // completed push. Fire-and-forget: a seed failure is logged, never
    // thrown (same contract as the roster write below).
    if (workbookId) {
      try {
        const seedClient = createServiceRoleClient();
        // BOUNDED. This one ALREADY read `.error` and logged, and that was
        // still not enough: unbounded, a stall here hung the callback AFTER
        // the roster data was gathered and BEFORE the sheet write, with
        // nothing emitted — the `.error` branch below cannot run for a call
        // that never settles. Reading `.error` is necessary, not sufficient.
        const { error: seedError, status: seedStatus } = await seedClient
          .from('pm_tracker_pushes')
          .upsert(
            {
              workbook_id: workbookId,
              vertical,
              company_name: businessName || null,
              domain: domain || null,
              website_url: websiteUrl || null,
              contact_name: mainContactName || null,
              contact_title: mainContactTitle || null,
              contact_phone: mainContactPhone || null,
              contact_email: mainContactEmail || null,
              physical_address: physicalAddress || null,
            },
            { onConflict: 'workbook_id' },
          )
          .abortSignal(AbortSignal.timeout(SUPABASE_READ_TIMEOUT_MS_AFTER));
        if (seedError) {
          logSupabaseFailure(
            SUPABASE_WRITE_FAILURE_TAG,
            {
              route: SHEET_EXPORT_ROUTE,
              table: 'pm_tracker_pushes',
              eventType: 'pending_seed',
              sessionId: session.id,
              clientId: session.client_id,
              succeeded:
                'the submission itself is committed and the roster row is still written below; only the approve-and-push pending record is missing, so re-run the export for this session',
            },
            normaliseAuditFault(
              seedStatus,
              seedError,
              'the pm_tracker_pushes seed was refused with no error body',
            ),
          );
        } else {
          console.log(
            `[sheet-export] pending seeded workbook_id=${workbookId} vertical=${vertical} session=${session.id}`,
          );
        }
      } catch (seedErr) {
        // D5 (1 of 2). This was one of the two untagged emitters left in the
        // file whose OWN comment at `googleRequest` admits the hazard: it
        // CONCATENATED `seedErr.message` — text that reaches here from
        // postgrest-js, i.e. from a remote — straight into a template, so a
        // newline in it split the record and stranded the prefix on the half
        // without the news. Same emitter as everything else now: escaped,
        // bounded, classified, and carrying what DID survive.
        //
        // `logSupabaseFailure`, not `logUpstreamFailure`, because the subject
        // really is one table — which is the documented rule for choosing
        // between the two shapes.
        logSupabaseFailure(
          SUPABASE_WRITE_FAILURE_TAG,
          {
            route: SHEET_EXPORT_ROUTE,
            table: 'pm_tracker_pushes',
            eventType: 'pending_seed',
            sessionId: session.id,
            clientId: session.client_id,
            succeeded:
              'the submission itself is committed and the roster row is still written below; only the approve-and-push pending record is missing, so re-run the export for this session',
          },
          normaliseThrownFault(seedErr),
        );
      }
    }

    // Columns A–O for the continuity roster. Column B (Client Code) is now
    // ALWAYS blank — J minting moved to the dashboard approve-push (R8).
    // Column J is the service-area SCOPE (Local/Regional/Statewide/National),
    // not the target-cities free text.
    const row: string[] = [
      'Active',
      '', // B (Client Code) — intentionally blank; J is minted at approval push
      businessName,
      mainContactName,
      mainContactTitle,
      mainContactEmail,
      mainContactPhone,
      websiteUrl,
      physicalAddress,
      serviceAreaType,
      primaryServices,
      primaryGoal,
      websitePlatform,
      submittedDate,
      workbookId,
    ];

    // ── Sheet state: header + existing rows (for idempotency) ───
    //
    // EVERY call below is BOUNDED and every failure is REPORTED, for exactly
    // the reason the Supabase calls above are: they sit UPSTREAM of this
    // file's own `sheet_export_failed` audit write, on the same after()
    // callback, so an unbounded stall here froze the callback with the audit
    // write never issued and nothing said. See the bounding note at
    // GOOGLE_HTTP_TIMEOUT_MS for the measurement and the two placements.
    const jwt = makeJwt();
    const googleCtx = { sessionId: session.id, clientId: session.client_id };

    await authorizeJwt(jwt, googleCtx);

    const headerRow = await valuesGet(jwt, googleCtx, sheetId, 'A1:O1');
    const headerPresent =
      headerRow.length > 0 &&
      (headerRow[0] ?? []).some((c) => String(c).trim() !== '');
    if (!headerPresent) {
      await valuesUpdate(jwt, googleCtx, sheetId, 'A1:O1', [HEADER]);
    }

    const dataRows = await valuesGet(jwt, googleCtx, sheetId, 'A2:O');

    // One row per client, keyed on Workbook ID (column O, index 14).
    let matchIdx = -1;
    if (workbookId) {
      matchIdx = dataRows.findIndex(
        (r) => String(r[14] ?? '').trim() === workbookId,
      );
    } else {
      console.warn(
        `[sheet-export] warn no-workbook-id session=${session.id} — append-only, no idempotency key`,
      );
    }

    if (matchIdx >= 0) {
      const rowNum = matchIdx + 2; // +1 header, +1 one-based
      await valuesUpdate(jwt, googleCtx, sheetId, `A${rowNum}:O${rowNum}`, [row]);
      console.log(
        `[sheet-export] ok action=updated row=${rowNum} session=${session.id}`,
      );
    } else {
      await valuesAppend(jwt, googleCtx, sheetId, [row]);
      console.log(
        `[sheet-export] ok action=created session=${session.id}`,
      );
    }
  } catch (err) {
    // D5 (2 of 2). THE LINE `googleRequest`'s COMMENT NAMED AND LEFT ALONE.
    //
    // It CONCATENATED `message` — which, on the common path, is the string
    // `googleRequest` rethrows, i.e. a normalised Google error body — into a
    // bare template. Bounded, yes, because googleRequest bounds what it
    // rethrows; ESCAPED, no. A newline anywhere in it (an HTML error page from
    // a proxy in front of sheets.googleapis.com is the realistic one) split
    // the record and left `[sheet-export] failed session=…` on the half
    // without the reason. And it carried no fault kind, no status and no
    // `succeeded`, so an operator could not tell a credential problem from a
    // stall from a 404 spreadsheet id.
    //
    // Routed through the shared emitter. `normaliseThrownFault` classifies it,
    // the message is escaped and bounded, and the sentence says plainly that
    // the submission itself is safe — which is the fact that stops someone
    // chasing data loss that did not happen.
    const fault = normaliseThrownFault(err);
    const message = fault.message;
    logUpstreamFailure(
      BOUNDED_STAGE_FAILURE_TAG,
      {
        route: SHEET_EXPORT_ROUTE,
        target: 'sheet_export (google sheets roster)',
        eventType: 'sheet_export_failed',
        sessionId: session.id,
        clientId: session.client_id,
        succeeded:
          'the submission itself is committed and the dashboard bridge is unaffected; only the roster sheet row is missing, so re-run the export for this session',
      },
      fault,
    );
    await recordAuditEvent(
      session.id,
      'sheet_export_failed',
      { error: message },
      {
        clientId: session.client_id,
        route: SHEET_EXPORT_ROUTE,
        succeeded:
          'the submission itself is committed and the roster sheet failure on the line above is logged; only the audit row recording it was lost',
      },
    );
  }
}
