# Site Intelligence — Architecture & Setup

## Overview

Site Intelligence crawls a client's website before the onboarding link is sent, extracts structured business insights, and uses them to:

1. **Pre-fill** onboarding fields with confidence gating
2. **Personalize** question copy into confirmation-style prompts
3. **Display** a "Website Snapshot" panel on the client's first load

## Architecture

```
Admin creates session
  ↓
Admin enters website URL → "Analyze Website" button
  ↓
POST /api/admin/site-intelligence/analyze
  ↓ (async)
Provider pipeline: Firecrawl → Wappalyzer → BuiltWith → PageSpeed
  ↓
Results merged → prefill_map + question_overrides computed
  ↓
Stored in onboarding_site_intelligence table
  ↓
Admin reviews preview → sends link
  ↓
POST /api/admin/site-intelligence/link
  → Snapshots copied to onboarding_sessions (si_*_snapshot columns)
  ↓
Client opens link
  ↓
GET /api/public/onboarding/session returns siteIntelligence data
  ↓
Wizard applies: prefill (autofill only on mount), question overrides, Website Snapshot
```

## Data Model

### `onboarding_site_intelligence` table

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID PK | Record identifier |
| website_url | TEXT | Full URL analyzed |
| domain | TEXT | Extracted hostname |
| status | TEXT | queued / running / completed / failed |
| started_at | TIMESTAMPTZ | When analysis started |
| completed_at | TIMESTAMPTZ | When analysis finished |
| providers_used | JSONB | Which providers ran |
| branding | JSONB | Logo, colors, fonts, screenshot |
| insights | JSONB | Business summary, services, locations |
| tech_stack | JSONB | CMS, analytics, hosting |
| metrics | JSONB | PageSpeed scores (optional) |
| prefill_map | JSONB | Per-field suggested values + confidence |
| question_overrides | JSONB | Per-field label/help overrides |
| evidence | JSONB | Source URLs + excerpts |
| error | TEXT | Error message if failed |

### Session snapshot columns

Added to `onboarding_sessions`:
- `site_intelligence_id` (FK, nullable)
- `si_prefill_snapshot` (JSONB)
- `si_overrides_snapshot` (JSONB)
- `si_branding_snapshot` (JSONB)
- `si_insights_snapshot` (JSONB)

Snapshots ensure stability — re-analyzing doesn't change an already-sent link.

## Environment Variables

### Required
```
FIRECRAWL_API_KEY=fc-...          # Firecrawl API key (primary provider)
```

### Optional
```
ENABLE_SITE_INTELLIGENCE_PREFILL=true   # Feature flag (default: true)
WAPPALYZER_API_KEY=...                   # Tech stack detection
BUILTWITH_API_KEY=...                    # Tech stack detection
PAGESPEED_API_KEY=...                    # Performance metrics
```

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/site-intelligence/analyze` | POST | Start analysis |
| `/api/admin/site-intelligence/status` | GET | Poll status / get results |
| `/api/admin/site-intelligence/link` | POST | Link results to session |

## Provider Interface

All providers implement `SiteIntelligenceProvider`:

```typescript
interface SiteIntelligenceProvider {
  name: string;
  run(websiteUrl: string): Promise<ProviderResult>;
}
```

Providers are loaded dynamically based on available API keys.

## Testing Locally

1. Set `FIRECRAWL_API_KEY` in `.env.local`
2. `npm run dev`
3. Go to `/admin/onboarding/new`
4. Enter client details + website URL
5. Click "Analyze Website"
6. Wait for completion → review preview
7. Create link → open in new tab
8. Verify Website Snapshot and personalized questions

## Safe Fallback

When `ENABLE_SITE_INTELLIGENCE_PREFILL=false` or no API keys are set:
- Admin create page still works (analysis panel doesn't show)
- Client onboarding works exactly as before
- No prefill, no overrides, no snapshot
