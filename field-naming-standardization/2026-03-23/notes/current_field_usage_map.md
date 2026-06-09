# Current Field Usage Map

## Where Field Definitions Are Declared

| File | Purpose |
|------|---------|
| `src/lib/onboarding/steps-v2.ts` | V2 onboarding step + field definitions (12 steps, ~69 fields) |
| `src/lib/onboarding/steps.ts` | V1 step definitions (30 steps, 82 fields — legacy) |
| `src/lib/onboarding/flow-version.ts` | Selects V1 or V2 steps based on session flow_version |

## Where Validation Happens

| File | Type | Details |
|------|------|---------|
| `src/lib/onboarding/steps-v2.ts` | Server + Client | Zod schemas per step_key (e.g., `primary_contact`, `business_overview`) |
| `src/app/api/public/onboarding/save-step/route.ts` | Server | Calls `validateStepDataForVersion()` before saving |
| `src/components/onboarding/Wizard.tsx` | Client | Calls `validateStepDataForVersion()` on "Next" click |

## How Answers Are Stored

| Table | Key Structure | Details |
|-------|--------------|---------|
| `onboarding_answers` | `session_id` + `step_key` (unique) | `answers` column is JSONB: `{ field_name: value }` |
| Storage format | Flat keys within step | e.g., `{ "business_name": "Smith Law", "website_url": "https://..." }` |
| No canonical keys used | Legacy flat names | All current sessions use legacy field names |

## How Answers Are Read

| File | Details |
|------|---------|
| `src/app/api/public/onboarding/session/route.ts` | Fetches all answers, formats as `{ step_key: { answers, completed } }` |
| `src/app/onboarding/[token]/page.tsx` | SSR page that fetches session data |
| `src/components/onboarding/Wizard.tsx` | Client-side, receives answers as prop |
| `src/components/onboarding/StepRenderer.tsx` | Renders fields, reads values by `field.name` |

## How Exports Are Built

| File | Format | Details |
|------|--------|---------|
| `src/app/admin/onboarding/sessions/[id]/page.tsx` | JSON export | `handleExportJSON()` — dumps raw session + answers |
| `src/app/admin/onboarding/sessions/[id]/page.tsx` | Text summary | `handleCopySummary()` — copies human-readable text |
| No CSV export exists | — | Would need to be built |
| No CRM integration exists | — | `src/lib/crm/buildOnboardingPayload.ts` now provides this |

## CRM / Integration Code Paths

**None found.** No references to `hubspot`, `salesforce`, `zapier`, `webhook`, `crm`, or `sync` in the codebase (outside the newly created `src/lib/crm/` module).

## Site Intelligence Field References

| File | Details |
|------|---------|
| `src/lib/siteIntelligence/field-mapping.ts` | Maps SI insights to legacy field names (e.g., `business_name`, `website_platform`) |
| `src/lib/siteIntelligence/question-overrides.ts` | References legacy field names for question personalization |

These modules use legacy keys and will benefit from the alias map for forward compatibility.
