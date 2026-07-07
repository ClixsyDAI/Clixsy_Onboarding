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
// id → update in place and KEEP its Client Code; none → append with the
// next J-code. Submissions with no workbook_id (the bridge's deferred
// case) fall back to append-only with an empty column O and a
// `[sheet-export] warn no-workbook-id` log line.
//
// J-code rule (sheet-max + 1): parse column B of the data rows for
// "J<integer>", take max+1; an empty sheet starts at J450. The header
// row is never parsed. Small race on simultaneous submits is accepted
// by design (no external counter).
//
// Values are written RAW (never formulas). Enumerated answers
// (radio/select/multiselect with static options) are written as their
// human labels, resolved generically from onboardingStepsV2; free-text
// answers pass through; missing answers write an empty cell.

import { JWT } from 'google-auth-library';
import {
  createServiceRoleClient,
  createAuditEvent,
  getSessionAnswers,
  type OnboardingSession,
} from '@/lib/supabase/server';
import { onboardingStepsV2 } from './steps-v2';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const FIRST_JCODE = 450;

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

async function safeAudit(
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await createAuditEvent(sessionId, 'sheet_export_failed', payload);
  } catch (err) {
    // The export must never throw into the submit path, even if
    // auditing the failure itself fails.
    console.error(
      `[sheet-export] audit write failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

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

    // Columns A–O. B (Client Code) is filled below once the sheet has
    // been consulted. J is the service-area SCOPE (Local/Regional/
    // Statewide/National), not the target-cities free text.
    const row: string[] = [
      'Active',
      '',
      businessName,
      display(answers, 'primary_contact', 'main_contact_name'),
      display(answers, 'primary_contact', 'main_contact_title'),
      display(answers, 'primary_contact', 'main_contact_email'),
      display(answers, 'primary_contact', 'main_contact_phone'),
      websiteUrl,
      display(answers, 'business_overview', 'physical_address'),
      display(answers, 'seo_targeting', 'service_area_type'),
      primaryServices,
      display(answers, 'goals_strategy', 'primary_goal'),
      display(answers, 'technical_setup', 'website_platform'),
      submittedDate,
      workbookId,
    ];

    // ── Sheet state: header, existing rows, J-code max ──────────
    const jwt = makeJwt();

    const headerRow = await valuesGet(jwt, sheetId, 'A1:O1');
    const headerPresent =
      headerRow.length > 0 &&
      (headerRow[0] ?? []).some((c) => String(c).trim() !== '');
    if (!headerPresent) {
      await valuesUpdate(jwt, sheetId, 'A1:O1', [HEADER]);
    }

    const dataRows = await valuesGet(jwt, sheetId, 'A2:O');

    let maxJ = 0;
    for (const r of dataRows) {
      const m = /^J(\d+)$/.exec(String(r[1] ?? '').trim());
      if (m) maxJ = Math.max(maxJ, parseInt(m[1], 10));
    }
    const nextCode = maxJ > 0 ? `J${maxJ + 1}` : `J${FIRST_JCODE}`;

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
      const existingCode = String(dataRows[matchIdx][1] ?? '').trim();
      row[1] = existingCode || nextCode;
      const rowNum = matchIdx + 2; // +1 header, +1 one-based
      await valuesUpdate(jwt, sheetId, `A${rowNum}:O${rowNum}`, [row]);
      console.log(
        `[sheet-export] ok code=${row[1]} action=updated row=${rowNum} session=${session.id}`,
      );
    } else {
      row[1] = nextCode;
      await valuesAppend(jwt, sheetId, [row]);
      console.log(
        `[sheet-export] ok code=${row[1]} action=created session=${session.id}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sheet-export] failed session=${session.id}: ${message}`);
    await safeAudit(session.id, { error: message });
  }
}
