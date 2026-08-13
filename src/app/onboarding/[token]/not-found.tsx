import Link from 'next/link';

/**
 * Client-facing 404 for an onboarding link that does not resolve.
 *
 * Rethemed onto the workbook tokens. Three things were wrong here beyond the
 * palette, and are recorded rather than left to be rediscovered:
 *
 * 1. It was the only file in the repo carrying `dark:` variants, seven of them.
 *    globals.css sets no dark strategy, so Tailwind v4's default
 *    prefers-color-scheme behaviour meant they activated for any visitor whose
 *    OS was in dark mode: an untested second rendering of a client-facing page
 *    that nobody had ever looked at. Now that the app is dark throughout they
 *    are not just untested but contradictory, so they are gone.
 *
 * 2. It was blue and indigo (`from-blue-50 to-indigo-100`, `bg-blue-600`),
 *    which is not a Clixsy colour and appears nowhere else in the product.
 *
 * 3. COPY MISMATCH, flagged not fixed. This page says "Session Not Found" and
 *    "contact your agency". The other invalid-link surface, the one actually
 *    served at /onboarding/<bad-token> today, says "Onboarding link not found"
 *    and "contact your Clixsy account manager". Two client-facing dead ends
 *    with different names for the same thing, and only one of them uses the
 *    right word for Clixsy. Which wording wins is a product call, so the text
 *    is untouched here.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10" style={{ background: 'var(--bg)' }}>
      <div
        className="max-w-md mx-auto p-8 rounded-2xl text-center"
        style={{ background: 'var(--card)', border: '1px solid var(--border2)' }}
      >
        <div
          className="w-16 h-16 mx-auto mb-6 rounded-full flex items-center justify-center"
          style={{ background: 'var(--red-soft)' }}
        >
          <svg className="w-8 h-8" style={{ color: 'var(--red)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold mb-4" style={{ color: 'var(--text)' }}>
          Session Not Found
        </h1>
        <p className="mb-6" style={{ color: 'var(--muted)' }}>
          This onboarding link is invalid or has expired. Please contact your agency for a new link.
        </p>
        <Link
          href="/"
          className="inline-block px-6 py-3 rounded-lg font-medium transition-colors"
          style={{ background: 'var(--green-fill)', color: 'var(--on-green)' }}
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
