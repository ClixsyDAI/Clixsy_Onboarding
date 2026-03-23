# Site Intelligence — Field Mapping Rules

## Confidence Gating

| Confidence | Policy | Behavior |
|-----------|--------|----------|
| >= 0.80 | `autofill` | Value populated as default (field still editable) |
| 0.55 — 0.79 | `suggest_only` | Clickable suggestion chip shown below field |
| < 0.55 | `no_prefill` | No action taken |

Every autofill or suggestion includes evidence (source URL + excerpt).

## Field Mapping Table

| Onboarding Field | Step | Insight Source | Notes |
|-----------------|------|---------------|-------|
| `business_name` | business_overview | `insights.brand_name` | Extracted from title/metadata |
| `business_phone` | business_overview | `insights.contact_public.phone` | Phone from website |
| `physical_address` | business_overview | `insights.contact_public.address` | Address from website |
| `main_geographical_areas` | seo_targeting | `insights.primary_locations` + `secondary_locations` | Joined as comma-separated |
| `primary_case_types_keywords` | seo_targeting | `insights.primary_services` + `secondary_services` | Joined as comma-separated |
| `case_priority` | seo_targeting | `insights.primary_services[0]` | Top service, slightly lower confidence |
| `website_platform` | technical_setup | `tech_stack.cms` | Mapped to field option values |
| `primary_color` | brand_design | `branding.colors[0]` | First detected color |
| `secondary_color` | brand_design | `branding.colors[1]` | Second detected color |
| `typography_fonts` | brand_design | `branding.fonts` | Joined as comma-separated |

## Rules

1. **Prefill never overwrites client-entered data.** Only empty fields receive defaults.
2. **Prefill is always editable.** No fields are locked or read-only.
3. **Each prefilled value has evidence.** The source URL and excerpt are stored.
4. **Confidence is conservative.** When in doubt, use `suggest_only` rather than `autofill`.
5. **Mapping is extensible.** Add new rules in `src/lib/siteIntelligence/field-mapping.ts`.
