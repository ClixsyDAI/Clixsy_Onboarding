# Playwright harness — onboarding wizard end-to-end tests

**Status:** Plan only. No code, no devDeps installed.
**Trigger to start build:** operator approval after the bug-#1 follow-up lands.

## Goal

Replace the manual operator e2e walkthrough (PIN, fill URL, click Analyze, watch panel transitions, verify prefill on step 2) with a Playwright test that asserts on DOM state at the UI layer. Data-layer curl verification already exists (`AppData/Local/Temp/reanalyze-verify.mjs` shape) but it can't catch wizard-side regressions like:
- Analyze button rendered but unclickable because the URL field's value isn't reflected in form state
- Panel transitions firing but text/colors not actually changing (a render bug)
- Prefill data landing in `siteIntelligence` state but the `useEffect` not propagating to field DOM values
- Re-analyze flow visibly losing its state on URL change but technically still polling

The data-layer check verifies the BACKEND contract; the Playwright harness verifies the USER experience.

## SSO bypass on Vercel previews

Vercel deployment-protection (the `_vercel_share` → `_vercel_jwt` handshake we've been using) is the only auth boundary above the app. Inside the test:

```ts
// playwright config: persist a storageState file that has the _vercel_jwt cookie.
// Before tests, a single warm-up calls the share URL with redirect:'manual'
// and stores the resulting cookie.

const SHARE_TOKEN = process.env.PLAYWRIGHT_VERCEL_SHARE_TOKEN; // never committed
await page.goto(`${PREVIEW_BASE}/?_vercel_share=${SHARE_TOKEN}`);
// Vercel redirects; the cookie is set automatically when Playwright follows.
await context.storageState({ path: 'playwright/.auth/vercel-sso.json' });
```

Then each test file reuses that storageState. The SSO cookie has a 23-hour TTL per the share URL — the warm-up needs to re-run if a previous run aged out, easy CI-friendly heuristic: skip warm-up if the storageState file is younger than 20 hours.

**Bypass token supply:** `PLAYWRIGHT_VERCEL_SHARE_TOKEN` env var. Operator generates a fresh share URL via the Vercel MCP `get_access_to_vercel_url` tool (the same flow we've used manually all session), copies the token out, sets the env var locally OR in CI. **Never committed.** A `.env.test.example` documents the variable; `.env.test` is gitignored.

## PIN handling

PIN gate is below SSO. Two options:

1. **Bypass via cross-repo PIN regen, then UI-enter the PIN** — same flow as `reanalyze-verify.mjs`:
   - Test-fixture step calls the workbook's `/api/onboarding/regenerate-pin` cross-repo facade with `SHARED_INTEGRATION_BEARER_TOKEN` to get a known plaintext PIN for the test session.
   - Then drives the PIN-entry page in Playwright: 6 digit-cell inputs, fill them, submit.
   - Captures the resulting PIN cookie in storageState alongside the SSO cookie.

2. **Set `pin_hash = NULL` on the test session as a teardown-only short-circuit** — `checkSessionGuard` returns 'ok' immediately when `pin_hash IS NULL`. Faster, less code. But it permanently mutates the test session row and the rest of the suite needs to be aware. **Not recommended** — option 1 is closer to a real client experience.

Option 1 is the spec. Adds ~20s per suite (PIN regen + 6 digit-cell fills), acceptable.

## Test architecture

```
client-onboarding-tool/
├── playwright.config.ts                # base URL = preview alias from env
├── playwright/
│   ├── .auth/                         # gitignored, stores authed storageState
│   ├── fixtures/
│   │   ├── pin-regen.ts               # cross-repo PIN regen, returns plaintext
│   │   ├── sso-warm.ts                # one-time SSO bypass cookie capture
│   │   └── test-session.ts            # spins up / tears down a test session row
│   ├── helpers/
│   │   ├── analyze-panel.ts           # locator + state-assertion helpers
│   │   └── supabase-direct.ts         # service-role queries for state checks
│   └── e2e/
│       ├── happy-path.spec.ts         # scenario 1: first analyze → prefill lands
│       ├── re-analyze.spec.ts         # scenario 2: bug-#2 regression
│       └── failed-analyze.spec.ts     # scenario 3: failed analyze must not wipe link
```

## devDependencies to add

- `@playwright/test` — the runner. Includes browser binaries; `npx playwright install` downloads Chromium on first run.
- No other new deps. `node-fetch` not needed (use Playwright's `request` context for cross-repo calls).

`package.json` scripts:
```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

## Driving step 1 — locators and actions

The website URL field is now the first field of `primary_contact`. The Analyze panel renders above the form card. Locators:

```ts
// helpers/analyze-panel.ts
export const analyzePanel = (page: Page) => ({
  root: page.locator('[data-testid="analyze-panel"]'),                 // need to add this attr
  analyzeBtn: page.getByRole('button', { name: /Analyze my site/i }),
  retryBtn: page.getByRole('button', { name: /Try again/i }),
  skipBtn: page.getByRole('button', { name: /Continue manually/i }),

  // State assertions by reading the panel's background-color class or
  // an explicit data-state attribute (best to add explicit attr to
  // AnalyzePanel.tsx for test stability — see "DOM additions" below).
  expectState: (state: 'idle' | 'analyzing' | 'completed' | 'failed' | 'timed_out') =>
    expect(this.root).toHaveAttribute('data-state', state),
});

export const urlField = (page: Page) =>
  page.getByLabel('Your Website');
```

Driving actions:

```ts
// happy-path.spec.ts
test('first analysis pre-fills empty fields on later steps', async ({ page }) => {
  await page.goto(`/onboarding/${TEST_TOKEN}`);
  // ... PIN-entry fixture has already authed via storageState ...
  await expect(page).toHaveURL(/\/onboarding\//);          // wizard mounted
  await urlField(page).fill('https://www.junglelaw.com/');
  await analyzePanel(page).expectState('idle');
  await analyzePanel(page).analyzeBtn.click();
  await analyzePanel(page).expectState('analyzing');

  // 90s timeout matches the wizard's own internal cap.
  await analyzePanel(page).expectStateEventually('completed', { timeout: 90_000 });

  // Verify prefill landed: nav to step 2 (Business Overview), assert
  // business_name field has the brand name extracted by the analyzer.
  await page.getByRole('button', { name: /Next/i }).click();
  await page.getByRole('button', { name: /Next/i }).click(); // skip past Other Contacts
  await expect(page.getByLabel('Business Name')).not.toBeEmpty();
});
```

## Scenario 2 — bug-#2 regression

```ts
test('re-analyze with different URL does NOT show instant false-complete', async ({ page }) => {
  // setup: complete analysis with junglelaw (helper from happy-path)
  await completeAnalysis(page, 'https://www.junglelaw.com/');
  await analyzePanel(page).expectState('completed');

  // edit URL to second domain
  await urlField(page).fill('https://dexterlaw.com/');
  // edit should reset panel to idle
  await analyzePanel(page).expectState('idle');

  await analyzePanel(page).analyzeBtn.click();
  await analyzePanel(page).expectState('analyzing');

  // CRITICAL: within 5s of click, panel must still be 'analyzing'.
  // The bug-#2 symptom was an instant 'completed' transition (~1s)
  // because the poll read the prior record's terminal state.
  await page.waitForTimeout(5_000);
  await analyzePanel(page).expectState('analyzing');

  // Then it should genuinely complete on its own timing.
  await analyzePanel(page).expectStateEventually('completed', { timeout: 90_000 });
});
```

## Scenario 3 — failed analyze must not wipe prior link

This one tests SUPABASE state, not just UI. Hybrid:

```ts
test('failed re-analyze preserves prior good link', async ({ page, request }) => {
  await completeAnalysis(page, 'https://dexterlaw.com/');
  // Capture session.site_intelligence_id BEFORE
  const linkBefore = await getSessionLink(TEST_SESSION_ID);
  expect(linkBefore).not.toBeNull();

  await urlField(page).fill('https://invalid-domain-xyz.invalid');
  await analyzePanel(page).analyzeBtn.click();
  await analyzePanel(page).expectStateEventually(
    /(failed|completed)/,                                   // either is possible per bug-#1 status
    { timeout: 120_000 }
  );

  // The actual assertion: regardless of UI state, the session link
  // must NOT have flipped. If it has, the link-only-on-completed
  // guard isn't strong enough — that's the bug-#1-sneaks-through case.
  const linkAfter = await getSessionLink(TEST_SESSION_ID);
  expect(linkAfter).toEqual(linkBefore);
});
```

This is the test that would have caught bug #1 sneaking through the bug #2 fix that today's data-layer run found.

## DOM additions needed in AnalyzePanel.tsx

Tests rely on stable selectors. Two small additions to `src/components/onboarding/AnalyzePanel.tsx`:

1. **Root `data-testid="analyze-panel"`** — single hook for the whole component.
2. **`data-state="{idle|analyzing|completed|failed|timed_out}"` on root** — eliminates color-class brittleness; tests assert on the explicit machine state.

Both are progressive enhancements; no visual change. Worth landing alongside the harness so tests don't have to grep for `bg-[#FFF4E5]` etc.

Also worth: `data-testid="analyze-button"` / `data-testid="retry-button"` / `data-testid="skip-button"` for the three buttons. The current `getByRole('button', { name: ... })` would also work but is text-coupled — copy changes break tests.

## Test-session lifecycle

The three scenarios all need a CLEAN session — pre-existing prefill from prior tests would skew results. Options:

1. **Spin up a fresh session per spec file** — `beforeAll` creates one via the cross-repo create endpoint (Phase 2a), `afterAll` deletes the clients row (FK cascade kills the session). Cleanest per-run isolation; takes ~5s setup.

2. **Reuse a single test-session row, clear answers between specs** — `beforeEach` PATCHes the session to reset `current_step=0`, deletes all `onboarding_answers` for it, and clears `site_intelligence_id`. Faster, but the session row persists in production data forever.

3. **Use J999** — the test bucket on Basecamp already exists. Risk: J999 is shared with the workbook end-to-end test fixture; tests interfere.

**Recommendation:** Option 1. The ~5s setup is worth the isolation. Use a dedicated test client name pattern like `"E2E Test {timestamp}"` so leaked rows are identifiable.

## Open questions before implementation

1. **CI integration?** If yes, where (GitHub Actions on the onboarding repo? Shared with workbook?). Affects env-var supply, browser-binary caching, retry semantics.

2. **Run against preview only, or also production for smoke?** Preview catches the regression we just hit; production smoke would catch deploy-time env-var gaps. Both have value but different cost.

3. **Test data — real client URLs or synthetic?** Junglelaw / dexterlaw / etc. are the canonical "known good" URLs used in `reanalyze-verify.mjs`. Reusing them keeps timing predictable. But hitting Firecrawl + PageSpeed on every test run racks up provider cost. Consider VCR/cassette tape mocking for the analyzer calls, with one daily live-run for the cassette refresh.

4. **Parallel test execution?** Playwright defaults to parallel. The 3 scenarios share the same test session — must run serially OR each spec must spin up its own session (option 1 above). With option 1, parallel works but adds Supabase row count.

## Estimated effort to implement

- Playwright install + config + fixtures + SSO warm-up + PIN-regen + test session lifecycle: half day
- 3 scenario spec files with helpers: half day
- DOM additions to AnalyzePanel + minor wizard-page-level test selectors: 1 hour
- CI integration (if requested): half day
- Mock/VCR strategy for analyzer (if requested): 1 day

Total without CI/VCR: ~1 day. With both: ~2.5 days.

## Files to create when this is greenlit

- `playwright.config.ts` (root)
- `playwright/fixtures/sso-warm.ts`
- `playwright/fixtures/pin-regen.ts`
- `playwright/fixtures/test-session.ts`
- `playwright/helpers/analyze-panel.ts`
- `playwright/helpers/supabase-direct.ts`
- `playwright/e2e/happy-path.spec.ts`
- `playwright/e2e/re-analyze.spec.ts`
- `playwright/e2e/failed-analyze.spec.ts`
- `playwright/.gitignore` (`.auth/`, `.env.test`)
- `package.json` script entries
- `src/components/onboarding/AnalyzePanel.tsx` (add `data-testid` + `data-state` attrs)
