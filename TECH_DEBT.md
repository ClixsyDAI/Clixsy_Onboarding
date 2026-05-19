# Tech Debt & Runbook

Running log of known issues that are not blocking, plus short runbook
entries for the operator-facing recovery procedures. New entries land
at the top.

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
