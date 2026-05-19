# Onboarding form: feedback-doc implementation (Stages 1–8)

## Summary

This PR implements every item in `onboarding-form-feedback.md` — the
twelve-step v2 onboarding flow gets a PIN gate, a first-login welcome
modal, conditional rendering polish, structured-field conversions,
scraper-output cleanup with deterministic color/font/phone extractors,
the welcome-gift relocation, and a rebuilt post-submit screen with
confetti, copy rewrite, and an optional star rating. Three Supabase
migrations (005–007) land alongside; all have been applied to the live
DB and verified against the existing 14 customer sessions.

15 functional commits + 1 PR-prep lint cleanup. 4753 lines added,
288 removed, 43 files touched. No new dependencies beyond
`canvas-confetti` (Stage 8).

---

## What changed

### Stage 1 — Admin Create surface + PIN scaffolding (`8d0cf13`)
- Adds `Account Manager` (text, required) and `Vertical` (radio:
  Law Firm / Home Services) to the admin "Create New Onboarding
  Session" form (P1).
- Generates a 6-digit PIN at creation time, scrypt-hashes it, stores
  on the session, returns plaintext once in the success state with a
  copy button + "won't be shown again" warning (P2).
- Pure-function `pin.ts` module: `generatePin`, `hashPin`, `verifyPin`,
  `gateDecision`, `nextStateAfterAttempt`, `adminUnlockUpdate`.
  Threshold constants: 5 attempts → 15-min rate limit, 10 attempts →
  permanent lock.
- Admin Session Detail page gains a PIN Access card with status badge,
  Regenerate PIN and Unlock actions.
- Migration 005: `account_manager`, `vertical`, `pin_hash`,
  `pin_attempts`, `pin_lockout_until`, `pin_locked_at`.

### Stage 2 — Step nav G1 + G2 (`7c91fa1`)
- **G1**: thin green underline pill below the active step icon in the
  top icon nav, in addition to the existing ring.
- **G2**: root cause of "wrong step / off-by-one" was a race in
  `navigateToStep` — it `await`ed `saveStep` *before*
  `setCurrentStepIndex`, so two rapid clicks raced their save
  promises and either could win. Rewrote to navigate the UI
  synchronously and fire the save in the background; added
  `isNavigating` guard + 150 ms click debounce; skeleton fallback in
  the form card so the user always sees content or a skeleton, never
  an empty white card.

### Stage 3 — Gift relocation + 5 structured field conversions (`f2bdad2`)
- **S2.2 / S10.2**: welcome-gift block moved from step 10 (Transition
  & Wrap-up) to the bottom of step 2 (Other Contacts), with section
  header "Your welcome gift" / "Let us show our appreciation".
- **S6.1**: `form_submission_destinations` (textarea) → multi-select
  `form_submission_methods` (email / crm / other) with conditional
  email input, CRM dropdown (Salesforce / HubSpot / Zoho / Pipedrive
  / Clio / Lawmatics / MyCase / Litify / Filevine / Other), and free-
  text "other" field.
- **S6.3**: website manager radio reveals 3 conditional contact fields
  when "Another agency" or "Freelancer" is selected.
- **S7.1**: `primary_case_types_keywords` (textarea) → multi-select
  with 18 canonical case-type values + Other-reveal text.
- **S7.2**: `case_priority` (text) → cascade radio whose options come
  from S7.1 selections at render time. Disabled-state helper copy
  when source is empty.
- **S10.1**: `previous_agency_contact` (textarea) → 3 structured
  fields (name / contact / email).
- **S2.1 (incidental)**: tech_contact_* fields now stay visible for
  both "Yes, dedicated IT" and "Yes, external IT company". Free fix
  with the new `dependsOn.valueIn` extension introduced for S6.3.
- Type-system extensions on `OnboardingField`: `dependsOn` gains
  `valueIn` / `includes`, plus new `optionsFromField` (cascade
  options) and `sectionHeader` (visual grouping within a step).
- v2 schema: `primary_case_types_keywords` flipped from `z.string()`
  to `z.array(z.string()).min(1)`.

### Stage 4 part 1 — Pure-UI conditional polish (`24f396b`)
- **S7.3**: "View GBP profile" inline button next to the Google
  Business Profile URL field. `<a target="_blank" rel="noopener
  noreferrer">` when the value parses as a URL, disabled `<button>`
  otherwise. Auto-prepends `https://` to protocol-less values.
- **S6.2**: call-tracking redundancy. Detector for CallRail / CTM /
  Marchex / WhatConverts / Invoca in `tech_stack.other`. When found,
  emits a `confirmation` question-override on `call_tracking_provider`
  with prefilled autofill, and `ConfirmationField` was updated to hide
  the underlying input until the user clicks "No, let me edit".

### Stage 4 part 2 — S5.1 / S5.2 surface scraped colors + fonts (`8281bbb`)
- `primary_color`, `secondary_color`, `typography_fonts` gain
  `previewMode: 'color-swatch' | 'font-sample'` and an optional
  `gatePreviewOn` (used by S5.1 to gate the swatch UI to the "No,
  pull from website" path).
- New `ScrapedValuePreview` component: preview / edit / confirmed
  lifecycle. Color swatch + hex code, font-sample rendered in the
  font itself, evidence excerpt, Confirm/Edit buttons.
- Gated-no-prefill fallback message ("We couldn't extract this from
  your website automatically. Enter it manually above.") so the user
  isn't left with an empty input when the scraper produced nothing.

### Stage 5 — Deterministic brand extractor (`dfee1c3` + `2a00719`)
- New module `src/lib/siteIntelligence/branding-extractor.ts` —
  `extractColorsFromHtml` and `extractFontsFromHtml` pure functions.
  Colors: theme-color meta (conf 0.95) + CSS frequency analysis with
  near-white / near-black / greyscale / transparent filters
  (conf 0.85). Fonts: Google Fonts `<link>` (conf 0.90) + Bunny
  Fonts (conf 0.90) + inline `<style>` / style="…" font-family
  declarations (conf 0.80), with var() / calc() / `--custom-prop`
  leak filter, plus CJK system-font filter (Meiryo / Yu Gothic /
  Hiragino / MS Gothic / SimSun).
- Firecrawl provider now requests `rawHtml` alongside markdown /
  screenshot with `onlyMainContent: false`, runs the deterministic
  extractor on the homepage HTML, and merges results: deterministic
  hits unshift to the front of `branding.colors` / `branding.fonts`,
  LLM-only hits preserved at the tail.
- `branding` schema gains parallel `color_sources` / `font_sources`
  arrays so `field-mapping.ts` can read per-entry confidence + source
  labels for the prefill evidence excerpts.
- 28 unit tests in `branding-extractor.test.ts`.
- Empirical: junglelaw.com fixture yields `["#2b5672", "#f2780c"]` at
  conf 0.85 and `Madefor` at conf 0.80 — the S5.1/S5.2 swatch UI
  activates as designed. jimadler.com still returns empty branding
  because Firecrawl hits a 403 on the homepage (logged separately
  in TECH_DEBT.md).

### Stage 6 — Scraper output cleanup (`cf17ccf`, `38a42a6`, `f2ca0ad`)
- **S3.2**: every wizard textarea now auto-grows to fit content
  between 3 and 6 rows via a shared `AutoGrowTextarea` wrapper.
  Fix at the root in `StepRenderer.tsx`'s `case 'textarea'` so the
  prefilled-address read-back picks it up automatically through
  `ConfirmationField.renderField()`.
- **S1.1**: WHAT WE FOUND panel was rendering raw `![](https://
  static.wixstatic.com/…)` strings as visible text because the
  Firecrawl fallback paragraph parser stripped link syntax but not
  image syntax. Fixed two layers: the provider sanitises summaries
  on the way in (`cleanProseForDisplay` strips markdown images,
  links, bare URLs, collapses whitespace), and the `WebsiteSnapshot`
  renderer has a backstop `cleanBusinessSummary` plus a
  `buildFallbackSummary` that composes a tidy "X focuses on Y serving
  Z." sentence from structured insights when the sanitised summary
  is empty.
- **S3.1**: new precedence-aware phone extractor — `<header>` /
  `[role="banner"]` / .top-bar (conf 0.95) > hero/above-fold
  (conf 0.85) > tel: links anywhere (conf 0.80) > `<footer>` (conf
  0.70). Within each region tel: links beat free-text matches; text
  matches require at least one separator character so Wix's
  obfuscated CSS digit runs don't match as phones. NANP area-code
  filter (no leading 0 or 1). Deterministic top result overrides the
  LLM phone in the prefill. 26 unit tests in `phone-extractor.test.ts`.

### Stage 7 — PIN gate + Welcome Wizard + returning copy (`1484311`)
- POST `/api/public/onboarding/verify-pin` — runs
  `gateDecision` + `verifyPin` + `nextStateAfterAttempt` and sets an
  HMAC-signed cookie on success. 401 generic, 429 rate-limited with
  retryAfter, 423 permanent. Legacy `pin_hash IS NULL` sessions get
  a cookie issued through the no-PIN-required branch.
- `cob_pin` cookie: `<sessionId>.<issuedAtMillis>.<hmacB64url>`,
  HttpOnly, SameSite=Lax, Secure in production, 30-day max-age.
  HMAC key from `PIN_COOKIE_SECRET` or
  `SUPABASE_SERVICE_ROLE_KEY` fallback.
- Page route gutted to a server-component shell; new
  `OnboardingShell` client component branches on the gate kind
  (`needs_pin` → `<PinEntry />`, `locked.permanent` → locked-screen,
  `ok` → `<Wizard />`).
- `<PinEntry />` — 6-slot UX with auto-advance, paste support,
  generic error copy, persistent lock-state banner.
- Session GET / save-step / submit / mark-welcome-seen / submit-
  feedback all gated by the same `checkSessionGuard`.
- **P3**: `<WelcomeModal />` — two-step modal "Hey there, {{Client
  company name}}!" → "Let's get to know you" / "Start onboarding".
  `POST /mark-welcome-seen` flips `welcome_wizard_seen=true`
  server-side BEFORE dismissing so a network drop doesn't lose the
  state.
- **P4**: returning-user greeting now uses the COMPANY NAME (not the
  personal contact name) and only renders when `welcome_wizard_seen`
  is true — first-login is handled by the P3 modal.
- Migration 006: `welcome_wizard_seen boolean not null default false`.

### Stage 8 — Thank-you screen rebuild (`bdde136`)
- **S12.1**: `canvas-confetti` brand-green burst on landing (two side
  shots at x=0.15 / 0.85, centre follow-up at +220ms). Card pops in
  via CSS keyframe `clixsy-pop-in` (scale 0.7 → 1.05 → 1.0 in 400ms
  with `cubic-bezier(0.34, 1.56, 0.64, 1)`).
- **S12.2**: new copy with `{{Company name}}` (Step 3 business_name
  → clients.client_name fallback) and `{{Account manager name}}`
  (server-sourced from `account_manager` → "your account manager"
  fallback).
- **S12.3**: "You can close this window now" line deleted entirely.
- **S12.4**: 5 stars (`role="radio"` inside `role="radiogroup"`),
  hover fills left-to-right, click locks + POSTs to
  `/api/public/onboarding/submit-feedback`. "Thanks for the
  feedback!" toast under the stars. "Finish onboarding" CTA always
  enabled regardless of rating. Click → in-page final state
  ("Thanks again — see you soon.") rather than `window.close()` or
  external redirect (window.close fails silently for tabs not opened
  via window.open; no guaranteed brand-home URL).
- Migration 007: `feedback_rating int check between 1 and 5`,
  `feedback_submitted_at timestamptz` (both nullable, NULL distinguishes
  "didn't rate" from "rated 0").

### Housekeeping commits (`2a00719`, `5df73fb`, `17864bb`, `78336e4`)
- CJK system-font filter (Stage 5 follow-up — Meiryo, Yu Gothic etc.)
- TECH_DEBT.md created and populated with the Firecrawl 403 issue
- TECH_DEBT.md gains the PIN-lockout admin recovery runbook section
- PR-prep lint cleanup: 2 `prefer-const` + 1 unused import in
  `analyze.ts` (pre-existing, surfaced by Stage 4 work)

---

## Schema migrations

| File | Purpose | Applied | Rollback |
|---|---|---|---|
| `005_p1_p2_admin_session_fields.sql` | `account_manager`, `vertical`, `pin_hash`, `pin_attempts`, `pin_lockout_until`, `pin_locked_at` | ✅ Live | `alter table onboarding_sessions drop column …` per column; 14 existing rows backfilled `vertical='law_firm'` via column default. |
| `006_welcome_wizard_seen.sql` | `welcome_wizard_seen boolean not null default false` | ✅ Live | `alter table onboarding_sessions drop column welcome_wizard_seen` |
| `007_feedback_fields.sql` | `feedback_rating int check between 1 and 5`, `feedback_submitted_at timestamptz` | ✅ Live | `alter table onboarding_sessions drop column feedback_rating, drop column feedback_submitted_at` |

All three migrations are idempotent on re-run (`add column if not exists`
where applicable, no `INSERT`s, no data mutations beyond default
backfills).

---

## Operator actions completed

| Action | Status |
|---|---|
| Migration 005 applied via Supabase MCP | ✅ Stage 1 |
| Migration 006 applied via Supabase MCP | ✅ Stage 7 (14 rows backfilled `false`) |
| Migration 007 applied via Supabase MCP | ✅ Stage 8 |
| Housekeeping 1: flip `welcome_wizard_seen=true` for sessions with answer rows | ✅ Pre-PR (13 rows flipped, 1 stays `false` — matches operator's expected distribution) |
| Legacy session bypass verification (`pin_hash IS NULL` → wizard renders without PIN) | ✅ Stage 7 smoke 7 |
| Stale fixture-scrape rows in `onboarding_site_intelligence` cleaned up | ✅ Stage 5 + 6 teardowns; baseline 14/14/44/0-leftover preserved end-of-every-stage |

---

## Out of scope / explicitly deferred

| Item | Status | Where it lives |
|---|---|---|
| Firecrawl 403 on anti-bot-blocked sites (jimadler.com) | Deferred | `TECH_DEBT.md` — proposes Firecrawl stealth/proxy settings or a fallback provider |
| CRM management layer build (Phase 2) | Indefinitely parked | Was abandoned at commit `ddb3b48` before this feedback-doc work began |
| AI-tells suppression / GTM tagging tool polish items | Out of scope | Different doc, different repo (clixsy-dashboard) |
| Email notifications to the AM on submission | Out of scope per operator | Stage 8 prompt explicitly excluded |
| In-app AM notifications | Out of scope | Could be a future stage |
| Edit-after-submit / customer-facing read-only view | Out of scope | Stage 8 prompt explicitly excluded; clients still have token + cookie to revisit |

---

## Test coverage

| Suite | Tests | Status |
|---|---|---|
| `branding-extractor.test.ts` | 28 (Stage 5 base + Stage 5 CJK regression) | ✅ all green |
| `phone-extractor.test.ts` | 26 (Stage 6 — all 4 precedence layers + Wix-obfuscated-digit regression) | ✅ all green |
| `site-intelligence.test.ts` | 52 (pre-existing, untouched) | ✅ all green |
| **Total** | **106** | **106/106** |

Run with `npx tsx src/__tests__/<file>.test.ts`. The repo doesn't have
a vitest/jest harness; tests are imperative TS scripts using a tiny
inline `assert` helper, matching the existing `site-intelligence.test
.ts` convention.

Build: `npm run build` clean — 17 routes prerendered, no TS errors.

Lint: 1 pre-existing error in `StepTransition.tsx` (react-hooks/set-
state-in-effect at line 17) — verified on `main` pre-branch, not
introduced by this PR. The 26 warnings are mostly `<img>` lint hints
on existing logo / screenshot images and one `react-hooks/exhaustive
-deps` in the Wizard's run-once-on-mount effects, also pre-existing.

Live-DB smoke fixtures: `jimadler.com`, `junglelaw.com` (per the
feedback doc's test fixtures section). Each scrape was deleted post-
test; baseline customer rows untouched.

---

## Risks

| Risk | Mitigation in this PR |
|---|---|
| **PIN brute-force surface** | scrypt N=16,384 / r=8 / p=1 (libsodium "interactive" preset, ~25ms verify); rate limit at 5 attempts → 15-min cooldown; permanent lock at 10 cumulative attempts; admin Unlock + Regenerate PIN actions on session-detail page. Generic error copy on wrong PIN (no info leak on whether token exists). |
| **Cookie forgery** | HMAC-SHA256 signed value with `PIN_COOKIE_SECRET` (or `SUPABASE_SERVICE_ROLE_KEY` fallback). 30-day expiry built into the signed payload. Constant-time HMAC compare. Cookie bound to a specific session ID so a cookie from one session can't unlock another. |
| **Cookie missing → user locked out** | Stage 7 PIN screen offers re-verify path; admin Regenerate PIN if the original PIN was lost. Legacy sessions with `pin_hash IS NULL` bypass the gate entirely (no regression for the 14 pre-Stage-1 customer rows). |
| **Welcome wizard double-fire across browsers** | Server-tracked `welcome_wizard_seen` flag flipped in `mark-welcome-seen` endpoint BEFORE modal dismisses, so a network drop on the last click is recoverable. |
| **Star rating injection / SQL** | Endpoint validates `Number.isInteger(rating) && rating in [1,5]`, then uses parameterised Supabase update. DB CHECK constraint enforces the range as well. |
| **Site-intelligence cookie scope cross-session leakage** | Cookie is bound to a single session ID; verifying the cookie against a different session's row returns `needs_pin`. Re-verify required if the user opens a different session token in the same browser. |
| **Migration backout** | Rollback recipes in the Schema migrations table above. All three migrations drop cleanly with `alter table … drop column`. No data dependencies on the new columns from other tables. |
| **Firecrawl downstream sites change shape** | Deterministic extractors handle their happy paths; LLM extraction is preserved as a tail-of-list fallback. Both color/font/phone extractions degrade to "no result" rather than crash on unparseable HTML — covered by the empty-case fixtures in the test suites. |

---

## Operator post-merge checklist

1. **Vercel env vars** — confirm both are present on Production:
   - `SUPABASE_SERVICE_ROLE_KEY` (existing — used by the PIN-cookie
     HMAC fallback; if you set `PIN_COOKIE_SECRET` explicitly, that
     wins)
   - `FIRECRAWL_API_KEY` (existing)
   - Optionally `PIN_COOKIE_SECRET` if you want cookie-signing key
     rotation decoupled from Supabase. Not required to ship — the
     fallback works fine.
2. **Smoke the deployed URL** — create one throwaway session through
   `/admin/onboarding/new`, copy the URL + PIN, hit the URL in an
   incognito window. Expect:
   - PIN entry screen with "Welcome, <ClientName>"
   - Wrong PIN 4x → generic error each time; 5th → 15-min rate limit
     banner
   - Correct PIN → P3 modal "Hey there, <ClientName>!" → Start
     onboarding → form
3. **Verify the housekeeping-1 distribution is still 13 true / 1
   false** before mailing customers their links. (The one `false`
   session is the one that's never been logged into; that client
   should see the welcome modal on their first visit, which is
   correct.)
4. **Spot-check one of the legacy sessions** (`pin_hash IS NULL`) —
   open its `/onboarding/<token>` URL, confirm it goes straight to
   the form without prompting for a PIN. None of the legacy rows
   were mutated by any stage's smoke.
5. **Delete this PR_DESCRIPTION.md** from the repo after the GitHub
   PR is created if you don't want it living in the tree long-term.
   It's currently committed so the operator has a single source
   of truth to copy-paste from. (Or keep it — it doubles as a
   change log.)
