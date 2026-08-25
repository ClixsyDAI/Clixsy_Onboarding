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

// ── Minimal Sheets values API over the service-account JWT ──────
function makeJwt(): JWT {
  return new JWT({
    email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    key: (process.env.GOOGLE_SHEETS_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function valuesGet(jwt: JWT, sheetId: string, range: string): Promise<string[][]> {
  const res = await jwt.request<{ values?: string[][] }>({
    url: `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`,
  });
  return res.data.values ?? [];
}

async function valuesUpdate(
  jwt: JWT,
  sheetId: string,
  range: string,
  rows: string[][],
): Promise<void> {
  await jwt.request({
    url: `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    method: 'PUT',
    data: { values: rows },
  });
}

async function valuesAppend(jwt: JWT, sheetId: string, rows: string[][]): Promise<void> {
  await jwt.request({
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
    const supabase = createServiceRoleClient();
    const { data: client } = await supabase
      .from('clients')
      .select('client_name, website_url, workbook_id')
      .eq('id', session.client_id)
      .maybeSingle();
    const workbookId =
      client?.workbook_id !== null && client?.workbook_id !== undefined
        ? String(client.workbook_id).trim()
        : '';

    const answerRows = await getSessionAnswers(session.id);
    const answers: AnswersByStep = {};
    for (const r of answerRows) {
      answers[r.step_key] = (r.answers as Record<string, unknown>) ?? {};
    }

    // The session object in scope was fetched BEFORE updateSessionStep
    // stamped submitted_at — re-read it for the real timestamp.
    const { data: fresh } = await supabase
      .from('onboarding_sessions')
      .select('submitted_at')
      .eq('id', session.id)
      .maybeSingle();
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
        const { error: seedError } = await seedClient
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
          );
        if (seedError) {
          console.error(
            `[sheet-export] pm_tracker_pushes seed failed session=${session.id}: ${seedError.message}`,
          );
        } else {
          console.log(
            `[sheet-export] pending seeded workbook_id=${workbookId} vertical=${vertical} session=${session.id}`,
          );
        }
      } catch (seedErr) {
        console.error(
          `[sheet-export] pm_tracker_pushes seed threw session=${session.id}: ${
            seedErr instanceof Error ? seedErr.message : String(seedErr)
          }`,
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
    const jwt = makeJwt();

    const headerRow = await valuesGet(jwt, sheetId, 'A1:O1');
    const headerPresent =
      headerRow.length > 0 &&
      (headerRow[0] ?? []).some((c) => String(c).trim() !== '');
    if (!headerPresent) {
      await valuesUpdate(jwt, sheetId, 'A1:O1', [HEADER]);
    }

    const dataRows = await valuesGet(jwt, sheetId, 'A2:O');

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
      await valuesUpdate(jwt, sheetId, `A${rowNum}:O${rowNum}`, [row]);
      console.log(
        `[sheet-export] ok action=updated row=${rowNum} session=${session.id}`,
      );
    } else {
      await valuesAppend(jwt, sheetId, [row]);
      console.log(
        `[sheet-export] ok action=created session=${session.id}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sheet-export] failed session=${session.id}: ${message}`);
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
