# Tech Debt & Runbook

Running log of known issues that are not blocking, plus short runbook
entries for the operator-facing recovery procedures. New entries land
at the top.

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
