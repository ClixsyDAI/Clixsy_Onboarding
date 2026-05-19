# Tech Debt & Runbook

Running log of known issues that are not blocking, plus short runbook
entries for the operator-facing recovery procedures. New entries land
at the top.

---

## Thank-you headline: business_name vs client_name fallback order

**Belred Stage 9 walkthrough, 2026-05-19.** The thank-you screen's
company-name interpolation reads from `business_overview.business_name`
first and only falls back to `client_name` (from the session row) if
that's empty. Wizard.tsx:

```ts
const businessName = useMemo(() => {
  const fromV1 = answers['business_basics']?.business_name as string | undefined;
  const fromV2 = answers['business_overview']?.business_name as string | undefined;
  return fromV1 || fromV2 || clientName || '';
}, [answers, clientName]);

if (isSubmitted) {
  const companyName = businessName || clientName || '';
  return <ThankYou companyName={companyName} … />;
}
```

When Firecrawl populates `business_name`, the value is typically a
meta-title-style sentence rather than the brand name itself — Belred
came back as:

  "BelRed Heating, Cooling, Plumbing & Electrical Services in Seattle, WA"

…which makes the thank-you headline read awkwardly:

  "We've got all your onboarding details, thank you, BelRed Heating,
   Cooling, Plumbing & Electrical Services in Seattle, WA!"

The cleaner `client_name` from `onboarding_sessions` ("Vertical PR
Handoff Belred" in the smoke case, but for real clients it's whatever
the AM typed during admin Create — usually a short brand name like
"Jungle Law", "ARCO Comfort Air") only gets used if the business_name
field is empty.

Fix shapes (separate PR, not done):

- **(a)** Tighten the LLM prompt for `brand_name` extraction so it
  returns a short brand label, not the page meta-title. Adjacent to
  the existing TECH_DEBT entry on Firecrawl `business_summary`
  extraction quality — same prompt-quality cluster. Example negative:
  the goarco scrape returned `brand_name = "HVAC, Plumbing & Electrical
  Services in Ohio"` — same shape, also meta-title-style.
- **(b)** Reverse the fallback order: prefer `client_name` (operator-
  entered, deliberate, short) and fall back to `business_overview.
  business_name` only when client_name is empty. Mechanical change in
  `Wizard.tsx`. Lower risk than (a) — doesn't depend on the LLM behaving.
- **(c)** Both — (b) immediately for the visible-fix, (a) later when
  the scraper prompts get a broader pass.

The interpolation is also used inside the wizard for transition-message
copy ("Nice to meet {businessName}!" on the business_overview → goals
transition). Same trade-off applies there but the awkwardness is less
visible mid-flow than on the final headline.

**Not blocking Stage 9.** Existing law-firm thank-yous have been fine
because law-firm site scrapes tend to return cleaner brand_name values
(firm names are typically short and quotable). Surfaces more visibly
on home-services sites where the meta-title patterns are longer.

---

## Home-services prefill: mean-confidence aggregation + no multiselect suggestion UX

**Belred preview smoke, 2026-05-19.** Stage 9 added scraper-driven
prefill rules for the new home_services fields (`service_trades`,
`service_categories`, `service_priority`). A real Firecrawl run
against `belred.com` produced the right matches structurally — HVAC
+ Plumbing + Electrical were all identified, 21 sub-services taxonomy-
mapped — but **nothing pre-ticked in the wizard**. Two reasons:

1. **Mean-confidence aggregation drags strong matches below the
   autofill threshold.** The new rules in `field-mapping.ts` compute
   confidence as the mean across all matching scraped services. Belred
   came back at **0.75 mean** despite per-service confidences of
   0.78–0.92. `getPolicy` in `schemas.ts` maps `< 0.85` → `suggest_only`,
   so the entries are stored but not auto-applied (the Wizard's
   mount-time prefill effect in `Wizard.tsx` skips anything that
   isn't `autofill`).

2. **`SuggestionChip` doesn't render for multiselect fields.** Even
   though the data is sitting in `prefill_map` at `suggest_only`
   policy, `StepRenderer`'s suggestion-chip code only fires for
   `text` / `email` / `url` / `tel` / `textarea`. The `multiselect`
   branch (and the new trade-grouped renderer for `service_categories`)
   has no fallback. So a borderline-confidence home-services scrape
   leaves the user staring at six empty trade checkboxes even though
   the system already knows three of them apply.

Net effect: the conservative "no pre-tick on borderline confidence"
behaviour is technically correct, just invisible — Belred-sized real
scrapes consistently land in the 0.75–0.80 band, so the pre-tick UX
Stage 9 advertises rarely fires in practice.

Fix shapes (separate PR, not done):

- **(a)** Revisit the per-rule confidence aggregation function for
  the home-services rules. Mean may be wrong across heterogeneous
  matches — alternatives: top-N max, weighted by per-service
  confidence rank, or a separate "matched-fraction" component. The
  goal is "if 8 of 8 services taxonomy-matched at 0.78+, that's a
  strong signal, treat it as autofill".
- **(b)** Add a multiselect suggestion UX. Probably an inline "We
  think you offer these — tap to apply" chip group rendered above
  the checkboxes when `prefill_map[fieldName].policy === 'suggest_only'`
  and the field is empty. Mirrors the existing single-value
  `SuggestionChip` pattern but for arrays.

**Not blocking Stage 9.** Conservative no-pretick on borderline
confidence is acceptable behaviour — the user fills the form
themselves, the data flow is unchanged. Worth fixing properly later
so the scraper-driven UX advertised in the PR actually fires for
typical real-world client sites.

---

## Scrape-quality: secondary-page service bleed-in

**Belred preview smoke, 2026-05-19.** The same Belred scrape that
surfaced the threshold finding above also included **Roofing** in
the matched `service_trades` set — Belred doesn't actually offer
roofing services. The bleed-in came from the Firecrawl fallback
markdown parser reading 4 priority pages:

  testimonials, core-values, in-the-community, greener

The community / testimonials pages reference roofing in passing (a
roofing-partner story, or a customer mentioning a roof repair) and
those mentions hit the markdown service-extraction parser at full
weight, alongside the real homepage and service-page content.

Fix shape (separate PR, not done):

- Weight per-trade match confidence by source-page authority:
  `homepage > /services/* > /about/* > /testimonials,/community,/blog`.
  Trade signals only from low-authority pages should down-weight,
  not absent (Belred's "in the community" really is operationally
  signal-free for the trade question).
- Tie this into the same change as the aggregation fix above so the
  rules in `field-mapping.ts` can score "8 strong matches on
  service-pages + 1 weak match on testimonials" as autofill HVAC +
  no roofing, rather than the current "suggest_only on everything
  the parser found".

**Not blocking Stage 9.** The user can untick Roofing; the cascade
purge wipes its (zero) sub-services correctly. Worth fixing because
"see, the scraper read your site and got it right" is a stronger
sell when the scraper actually got it right.

---

## Vertical content branching not implemented

**Goarco production smoke, 2026-05-19.** Stage 1 / P1 introduced a
`vertical` column on `onboarding_sessions` with values `law_firm` and
`home_services`. The doc said *"We'll branch some of the form content
off this later."* That "later" hasn't happened — the v2 step
definitions in `steps-v2.ts` are identical regardless of the vertical.

Most visible symptom on a `home_services` session:

- **Step 7 (SEO & Targeting), `primary_case_types_keywords`** renders
  the law-firm case-type checklist (Personal Injury, Car Accidents,
  Slip and Fall, Wrongful Death, Medical Malpractice, …) with an
  "Other" free-text reveal. There's no Home-Services-appropriate
  alternative (Cooling, Heating, Plumbing, Electrical, Drains, etc.).

The override / prefill layer DOES capture the right categories from
the scrape — on `goarco.com` the confirmation override reads *"We
noticed you focus on Cooling, A/C Repair, A/C Install, A/C
Maintenance, Mini-Split Service. Is that accurate?"* — but the edit
field underneath offers none of those options. The user clicks "No,
let me edit" and is dropped onto the wrong list.

Fix shape (not done):

1. Add a per-vertical option set in `steps-v2.ts` (or accept a
   `verticalOptions` map on the multi-select field type).
2. Plumb `session.vertical` down to `Wizard` → `StepRenderer` so the
   right option set renders.
3. Mirror the same branching for `case_priority` (cascade source) and
   anywhere else that's law-firm-flavoured today (the field labels
   themselves use "case types" wording which doesn't fit home services
   either — *"What are your primary case types or services?"*).

Not blocking ship of the feedback-doc PR. Law-firm clients work fine.
Home-services clients see a noticeably-wrong question on Step 7.

---

## Wizard crashes on `current_step` out of bounds

**Goarco production smoke, 2026-05-19.** The Wizard does not guard
against `currentStepIndex >= steps.length`. Stack trace:

  TypeError: Cannot read properties of undefined (reading 'title')

Repro on production:

1. Submit a session through the form. `current_step` is set to
   `steps.length` (12) by the submit handler.
2. Roll the row back from `submitted` → `in_progress` (admin tool,
   manual DB edit, or a future status-rollback feature).
3. Revisit the URL. Wizard mounts with `initialStep = 12`,
   `steps[12]` is `undefined`, the first access to
   `currentStep.title` (in transition messages or interstitial copy)
   throws and the page renders the white "Application error: a
   client-side exception has occurred" screen.

Fix shape (not done):

- Clamp `initialStep` to `[0, steps.length - 1]` at the top of
  `Wizard.tsx`.
- Same clamp anywhere `setCurrentStepIndex` is called from outside
  the bounded path (Almost There jumps, autosave restores, etc.)
- Defensive `if (!currentStep) return <Loading/>` short-circuit so a
  transient bad state degrades to a spinner rather than a crash.

Cannot fire from the happy-path flow today (no UI lets a client set
their own current_step beyond `steps.length`), but fires the moment
admin tooling can roll status backwards — which is plausible as the
admin surface grows.

---

## Firecrawl `business_summary` extraction quality

**Goarco production smoke, 2026-05-19.** Firecrawl `/extract`
populated `business_summary` with the marketing-consent boilerplate
from goarco.com's site:

  "By checking this box, I consent to receive marketing and
   promotional texts, calls, and emails from or on behalf of ARCO
   Comfort Air and its affiliates using an automated system or auto
   dialer for any purpose, including HVAC, plumbing, and electrical
   products and services. Consent is not a conditi…"

The Stage 6 / S1.1 renderer-side sanitiser (cleanProseForDisplay
strips markdown/URL noise) is doing its job — the output is plain
text with no `![]()`, no Wix URLs. The issue is upstream: the LLM
picked the wrong paragraph. The fallback parser in
`firecrawl.ts` has the same risk — it just takes the first
medium-length paragraph that doesn't start with `!`, `[`, `|`, or a
list marker, and consent-boilerplate paragraphs pass that filter.

Adjacent issues from the same scrape:

- `brand_name` came back as *"HVAC, Plumbing & Electrical Services
  in Ohio"* (the meta-title), not *"ARCO"* or *"ARCO Comfort Air"*.
- `primary_locations` includes *"Northeast Ohio since"* — the LLM
  mis-parsed "serving Northeast Ohio since [date]" as a place name.
- `primary_case_types_keywords` prefill is a 2000+ character
  comma-separated catalog of every HVAC service goarco offers (plus
  menu items and "Back" links), tagged `suggest_only`. Because the
  field is now a multi-select (Stage 3 / S7.1), the free-text
  suggestion can't auto-fill any checkboxes.

Fix shapes (not done):

- Tighter prompt: ask the LLM for a *2-sentence* summary describing
  *what the business does for customers*, with a few explicit
  negative examples ("not a marketing-consent paragraph", "not a
  privacy policy excerpt").
- Filter out paragraphs starting with first-person consent /
  privacy / disclaimer phrasing in the markdown-fallback parser.
- Validate `primary_case_types_keywords` LLM output against the
  multi-select's canonical option keys before writing it into the
  prefill map — if 0 keys match, drop the prefill rather than ship
  a junk string.

Not blocking. The renderer-side sanitisation in the WHAT WE FOUND
panel (Stage 6 / S1.1) means users see clean prose, just not always
*useful* prose, on sites the LLM mis-extracts.

---

## Phase 1 carry-over items (operator-owned)

Surfaced during the Phase 1 (pre-feedback-doc) infrastructure work
and not addressed by the Stage 1–8 PR. Listed here so they don't get
forgotten now that the feedback-doc punch list is closed.

- **Supabase PITR add-on.** Production project `lawwsutjxopiekjzupef`
  is on the default 7-day backup window. Enabling the PITR add-on
  extends point-in-time recovery to 28 days. Cost trade-off; decide
  before the first paying customer ships through onboarding.
- **`DEPLOYMENT.md` JWT documentation.** Operator owns rotation /
  storage of the JWT secrets used for Supabase service-role access
  and the `PIN_COOKIE_SECRET` (Stage 7). No live deployment runbook
  documents the rotation procedure yet — needs a short section
  alongside the other env vars in `DEPLOYMENT.md`.
- **Gemini API key IP / referer restriction.** The Google AI / Gemini
  key (used by the AI-interpreter path on the parked WIP branch, not
  the main scraper) is currently unrestricted in the Google Cloud
  console. Lock it down to the Vercel egress IP range or to the
  production domain via the Google API restrictions before that
  branch ever ships.
- **Leaked credential password sweep.** Any DB / service credentials
  that were ever committed (even briefly, even since rotated) should
  be enumerated and confirmed-rotated. Pair with a `gitleaks` or
  TruffleHog scan over the full history before pushing this branch
  to a public remote, if applicable.

These four were flagged in Phase 1 and remain operator-owned. Not in
scope for the Stage 1–8 feedback-doc PR.

---

## Runbook: client locked themselves out of the PIN gate

**Stage 7, 2026-05-18.** Applies whenever a client hits the permanent
PIN lock (10 cumulative wrong attempts) or just can't remember their
PIN. The Stage 1 + Stage 7 work ships both an Unlock and a Regenerate
PIN admin action; this is the order to use them and why.

Recovery path:

1. Open the admin Session Detail page for that client at
   `/admin/onboarding/sessions/<id>`. The PIN Access card shows the
   current state — "Active" (green), "Rate-limited" (yellow), or
   "Locked" (red), plus failed-attempts count and any lockout-until
   timestamp.
2. If the client still knows their PIN and you just want to give them
   another try, click **Unlock**. That zeros `pin_attempts`,
   `pin_lockout_until`, and `pin_locked_at` without rotating the hash.
   Tell the client to retry.
3. If the client has forgotten the PIN or you suspect someone else has
   been guessing it, click **Regenerate PIN**. That mints a fresh PIN,
   re-hashes, clears all the failure state, and surfaces the plaintext
   PIN once in a yellow card with a Copy button. Send it to the client
   via your usual channel (email is fine; the PIN alone is useless
   without the onboarding token URL).

Order matters: Unlock keeps the existing PIN active, Regenerate
invalidates it. If you're unsure which to use, default to Regenerate —
it covers more failure modes and the client only ever sees one PIN at
a time, so there's no confusion. The plaintext is shown ONCE in the
admin UI after Regenerate; if you close the page before copying it,
you have to Regenerate again.

---

## Firecrawl returns 403 on some sites (e.g., jimadler.com)

**Stage 5, 2026-05-18.**

Firecrawl returns `HTTP 403 Forbidden` on jimadler.com's homepage. The
scrape completes successfully on Firecrawl's side — the response body
just contains the 403 error page, so `<title>` comes back as literally
`"403 Forbidden"` and downstream extractors (deterministic + LLM) see
no brand content. Anti-bot blocking is a Firecrawl-side concern.

Options for later:
- Investigate Firecrawl stealth / proxy settings (their docs list
  `mobile`, `actions`, and other modes that may bypass the WAF).
- Fall back to a second scraper for blocked domains — e.g. retry with a
  different provider, residential proxy, or a headless-browser provider
  on 403 responses.
- Accept the gap: surface a clearer error to the account manager
  ("couldn't reach the site automatically — fill in manually") so they
  know the form's manual-entry path is the only option for that client.

Not blocking. Scraping silently fails open: the public form's
manual-entry fields work fine, and the gated "couldn't extract" fallback
introduced in Stage 4 already handles this case for the colors/fonts
swatch UI.
