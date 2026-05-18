# Tech Debt

Running log of known issues that are not blocking but worth investigating
later. New entries land at the top.

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
