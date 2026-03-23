# SOP Routing — Architecture & Rules

## Overview

SOP Routing implements the manager's "Big 5 SOP" decision gates plus migration triggers. Based on the client's answers (and optionally inferred signals from site intelligence), the system determines which Standard Operating Procedures are needed before or during onboarding.

## Big 5 Decision Gates

| # | Question | Field Key | If NO | SOP Triggered |
|---|----------|-----------|-------|---------------|
| 1 | Own Domain? | `owns_domain_confirmed` | Registrar Migration SOP | Transfer domain ownership |
| 2 | Control DNS? | `controls_dns_confirmed` | DNS Migration SOP | Gain DNS control |
| 3 | WordPress? | `is_wordpress` | Website Rebuild SOP | Rebuild on WordPress |
| 4 | Own Content? | `own_written_content` | Written Content Replacement SOP | Replace unlicensed content |
| 5 | Own Images? | `own_license_images` | Image Replacement SOP | Replace unlicensed images |

## Migration Gate

| Question | Field Key | If YES | SOPs Triggered |
|----------|-----------|--------|----------------|
| Need Website Migration? | `needs_website_migration` | DNS Access SOP + Hosting Migration SOP | Migrate hosting |

## CMS Inference

When site intelligence detects the CMS (e.g., via Firecrawl + Wappalyzer), the `is_wordpress` field is:
- **Pre-filled** with `yes` or `no` based on detection (confidence 0.90)
- **Personalized** with a confirmation question: "We detected your site runs on {CMS}..."
- Still requires client confirmation — the prefill is a suggestion, not a final answer

## Routing Logic

Located in `src/lib/sopRouting/computeSops.ts`:

```typescript
computeSops(input) → { required_sops, explanations, big5_summary }
```

Rules:
- `"not_sure"` does **not** trigger any SOP (conservative approach)
- `null` (unanswered) does **not** trigger any SOP
- Only explicit `"no"` triggers the corresponding SOP
- Migration gate: only explicit `"yes"` triggers DNS Access + Hosting Migration

## Data Model

### `onboarding_sop_routing` table

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID PK | Record ID |
| session_id | UUID FK (unique) | Linked session |
| big5 | JSONB | Big 5 answers snapshot |
| migration | JSONB | Migration answer snapshot |
| required_sops | TEXT[] | List of triggered SOP names |
| notes | TEXT | Explanation text |
| created_at, updated_at | TIMESTAMPTZ | Timestamps |

## When Routing Runs

1. **On submit** — Automatically computed and persisted via `after()` in the submit endpoint
2. **On demand** — Admin can trigger via `POST /api/admin/sop-routing`
3. **Client-side preview** — `SOPRoutingSummary` component computes routing live as the client fills in the Big 5 step

## Client UX

After filling in the Pre-Contract Readiness step, clients see a summary:
- If no SOPs needed: "Great news! No additional setup steps are needed."
- If SOPs needed: "Based on your answers, we'll include these additional steps:" followed by a list. Reassuring tone: "Don't worry — our team will handle these."

## Feature Flag

Set `ENABLE_SOP_ROUTING=false` to disable. When disabled:
- The Pre-Contract Readiness step still shows (questions are useful regardless)
- No SOP routing is computed on submit
- No work orders are generated
- Everything else works as before
