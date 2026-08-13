import Link from 'next/link';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

export default function Home() {
  return (
    <div className="min-h-screen bg-[var(--bg)] flex flex-col">
      {/* Header */}
      <header className="bg-[var(--side)]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
          <div className="px-4 py-2 bg-[var(--card2)] text-[var(--text)] text-sm font-semibold rounded-lg">
            Clixsy Onboarding Portal
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="text-center max-w-2xl mx-auto">
          {/* Headline */}
          <h1 className="text-4xl md:text-5xl font-extrabold text-[var(--text)] mb-4 leading-tight">
            Client Onboarding
          </h1>
          <p className="text-lg text-[var(--muted)] mb-12 max-w-md mx-auto">
            Streamline your client setup with our comprehensive onboarding portal.
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/admin/onboarding/new"
              className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-[var(--green-fill)] text-[var(--on-green)] rounded-lg font-bold text-lg hover:bg-[var(--green-dim)] transition-all shadow-lg hover:shadow-xl"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create New Onboarding
            </Link>
            <Link
              href="/admin/onboarding/sessions"
              className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-[var(--card)] text-[var(--text)] rounded-lg font-bold text-lg hover:bg-[var(--bg)] transition-all border-2 border-[var(--border2)]"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Admin Dashboard
            </Link>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-6 text-center">
        <p className="text-sm text-[var(--faint)]">
          Powered by Clixsy Digital Marketing
        </p>
      </footer>
    </div>
  );
}
