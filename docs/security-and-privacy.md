# Security & Privacy

## Data Collection Principles

1. **Public sources only** — Site intelligence only crawls publicly accessible pages
2. **Robots.txt respected** — Firecrawl respects robots.txt directives
3. **No authenticated crawling** — We never crawl behind logins or paywalls
4. **Minimal data storage** — Only structured insights and short evidence excerpts are stored, not full page bodies

## What We Collect

### From the client's website (via Firecrawl)
- Business name, summary, services, locations
- Contact info (phone, email, address) — only if publicly displayed
- Social media links — only public profile URLs
- Brand colors, fonts, logo — visual identity from CSS/metadata
- CMS/platform detection — technology fingerprinting
- Homepage screenshot — visual reference only

### What we DO NOT collect or infer
- Revenue, profit, or financial data
- Staff size or headcount
- Rankings, conversions, or ad spend
- Any data behind authentication
- Private business information not on public pages

## Data Storage

- **Site intelligence records** — Stored in Supabase with RLS enabled
- **Evidence excerpts** — Max 500 characters per excerpt
- **Screenshots** — Stored as URLs (Firecrawl-hosted), not downloaded
- **Snapshots** — Frozen at send-time to prevent data drift

## Access Control

- **Service Role Key** — All database operations use the Supabase service role key (server-side only)
- **Token-based access** — Clients access their session via a unique 64-character hex token
- **No client authentication required** — Token is the bearer of access
- **Admin routes** — No auth layer (tool-level access, not multi-tenant)

## API Keys

| Key | Scope | Required |
|-----|-------|----------|
| `FIRECRAWL_API_KEY` | Website crawling/extraction | Yes (for analysis) |
| `WAPPALYZER_API_KEY` | Tech stack detection | Optional |
| `BUILTWITH_API_KEY` | Tech stack detection | Optional |
| `PAGESPEED_API_KEY` | Performance metrics | Optional |
| `SUPABASE_SERVICE_ROLE_KEY` | Database access | Yes |

All API keys are stored as Vercel environment variables (encrypted at rest).

## Feature Flags

- `ENABLE_SITE_INTELLIGENCE=false` — Disables all crawling and analysis
- `ENABLE_SOP_ROUTING=false` — Disables SOP routing and work order generation

When disabled, the app functions identically to the pre-feature state.

## Confidence Gating

All inferred values include a confidence score:
- **>= 0.80** — Auto-filled (but always editable)
- **0.55–0.79** — Shown as suggestion only (client must click to accept)
- **< 0.55** — Not shown to client

This prevents low-quality inferences from polluting the onboarding experience.
