# Prefill accuracy — known follow-ups

**Status:** Known issues. NOT blocking the bug-#1 / bug-#2 integrity fixes shipped in
`feat: client-driven site intelligence on wizard step 1`. To be addressed in a
follow-up PR scoped to extraction-quality / field-mapping.

Both issues surfaced during the browser-verification pass against
`https://www.junglelaw.com/` on the preview deploy. The data-integrity portion
of the feature (analysis gated correctly, no orphaned prefill, no false-complete
on broken URLs) is shipping. The field-mapping accuracy is not.

---

## Issue A — business-name prefill uses URL slug, not the page-extracted brand

### Symptom

On step 2 (Business Overview) the `business_name` question pre-fills with
`"jungle-law"` — a kebab-case derivation of the URL slug `junglelaw` →
`jungle-law`. The real brand on the live site is "Jungle Law" (title case,
no hyphen).

### What we know

Firecrawl IS extracting the real brand. The page's `<title>` includes
"... | Jungle Law", the header logo's alt text reads "Jungle Law", and any
schema.org Organization markup would carry the same.

The analyzer's `insights.brand_name` field, however, gets populated with the
slug-synthesized variant when the site is shallow OR when the slug-derivation
provider runs first in the merge order. The page-extracted brand is somewhere
in the merged data — either lost during the merge, or available in a separate
field the prefill mapping ignores.

### Why this is bug #1's cousin

The bug-#1 fix dropped `brand_name` from the USABLE-CONTENT GATE because
Firecrawl synthesizes it from the URL slug for non-resolving domains. That's
the same synthesis behavior — but for a REAL site where other signals pass
the gate, the slug-derived `brand_name` is still being USED as the prefill
VALUE. The gate is correct now; the value mapping is not.

### Fix direction (next PR — do not implement here)

1. Trace what populates `merged.insights.brand_name` in the merge step
   (`mergeProviderResults` in `src/lib/siteIntelligence/analyze.ts:24-160`).
   Identify which provider supplied "jungle-law" vs which would have
   supplied "Jungle Law".
2. Prefer page-extracted brand sources in the merge:
   - `<title>` parsed for the brand suffix after the page's specific topic
     (e.g., `"How a Car Accident Lawyer Can Help | Jungle Law"` → `"Jungle Law"`)
   - Logo `alt` text on the header element
   - schema.org `Organization.name`
   - `<meta property="og:site_name">`
3. Fall back to the slug ONLY if every page-extracted source returned empty.
4. Or — more conservative — write NULL to `brand_name` when no page-extracted
   source fires, and let the prefill mapping omit the business-name question
   entirely. A blank field the client fills in beats a wrong field they have
   to delete + retype.

### Acceptance test for the next PR

- Re-run analyze against junglelaw.com → `insights.brand_name` is `"Jungle Law"`
  (or null), not `"jungle-law"`.
- The `business_name` prefill on step 2 shows `"Jungle Law"` (or is empty),
  not `"jungle-law"`.
- Re-run against dexterlaw.com → `insights.brand_name` reflects whatever the
  page says (`"Provo Utah Attorney"` per current data, which is also extracted
  from a page element, not a slug).

---

## Issue B — address-confirmation question renders empty

### Symptom

On step 3 (or wherever the address-confirmation question lives in v2's flow),
the wizard renders the question text *"We found this address on your website.
Is it correct?"* — but **the address field below it is blank**. The client
sees a question asking them to confirm something the form claims to have
found, with nothing shown.

### What we know — needs investigation

Two possible causes, each with a different fix:

1. **Extraction missed it.** `insights.contact_public.address` is null for
   junglelaw.com. The "we found this address" question shouldn't render in
   that variant when there's nothing to confirm — it should degrade to a
   plain "What's your address?" input.
2. **Extraction succeeded but the display didn't bind.** `insights.contact_public.address`
   has a value, but the wizard's StepRenderer doesn't surface it as the
   default/displayed value on the question. Probably a missing
   `prefillMap` entry for the address question or a wrong key path.

The fix depends on which one is true. Investigation first:

```sql
SELECT website_url,
       insights -> 'contact_public' AS contact_public,
       prefill_map -> 'address' AS address_prefill,
       prefill_map -> 'physical_address' AS physical_address_prefill
FROM onboarding_site_intelligence
WHERE website_url = 'https://www.junglelaw.com/'
  AND status = 'completed'
ORDER BY started_at DESC
LIMIT 1;
```

### Fix direction (next PR — do not implement here)

- **If contact_public.address is null:** the "we found this address" variant
  of the question must be gated on having a non-empty address. The
  `question_overrides` mechanism is the place — when the address is empty,
  the override should NOT be applied; the question falls back to its
  plain-text default. Look at
  `src/lib/siteIntelligence/question-overrides.ts:buildQuestionOverrides`.
- **If contact_public.address is set but the wizard isn't binding it:**
  the prefill map entry for the address field is missing or mis-keyed.
  Check `src/lib/siteIntelligence/field-mapping.ts:buildPrefillMap` —
  the address field probably has a different name in `steps-v2.ts` than
  the prefill map writes to. Path-aligning would surface the value.

### Acceptance test for the next PR

- Open a session on a site Firecrawl extracts a real address from (e.g.,
  dexterlaw.com, which has phone + address in `contact_public`). The
  address-confirmation question shows the extracted address as the
  default value. The client can edit or confirm.
- Open a session on a site with no extractable address. The question
  renders without the "we found this address" framing — just the plain
  "What's your address?" prompt.

---

## Related deferred items

These two issues join a small queue of follow-up work that the integrity
PR explicitly does NOT cover:

- **Deeper bug-#1 analyzer-quality work.** The five-signal predicate
  (`primary_services` / `primary_locations` / `contact_public.phone` /
  `contact_public.address` / `key_pages`) gates the STATUS write
  correctly — failed URLs now write `failed`, not `completed`. But the
  predicate is OR-based and any ONE signal is enough; a site with only
  `key_pages > 0` and otherwise empty extractions still writes `completed`
  with very thin prefill data. The prefill values for that thin case
  would suffer from the issue A pattern. A future PR could tighten the
  predicate further (e.g., require 2+ signals) once we have data on
  whether legitimately sparse real sites get false-rejected.
- **Playwright UI-layer test harness.** Plan at
  [playwright-harness-plan.md](./playwright-harness-plan.md).
  Would have caught issue A and issue B before they reached operator
  visual inspection — assertions like "step-2 `business_name` field value
  matches a page-extracted form" or "address-confirmation question
  renders with a non-empty value attribute". Out of scope for the
  integrity PR.

---

## Discovered

Both issues found during the operator's browser verification pass on
2026-05-28, against `feat/client-site-intel-wizard-step-1` preview deploy
at commit `a23a573`. Data-layer verification scripts at
`C:\Users\johan\AppData\Local\Temp\reanalyze-verify.mjs` and
`scenario3-verify.mjs` did NOT catch either issue — they assert on
record state (status, prefill_count) but not on the SEMANTIC CORRECTNESS
of the prefill values or on whether the wizard's UI surfaces them
correctly. That's why the Playwright harness matters: the data layer
can be honest while the user-facing surface is wrong.
