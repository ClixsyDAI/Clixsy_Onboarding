'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import SiteIntelligencePanel from '@/components/admin/SiteIntelligencePanel';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

type Vertical = 'law_firm' | 'home_services';

export default function NewOnboardingPage() {
  const [clientName, setClientName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [accountManager, setAccountManager] = useState('');
  const [vertical, setVertical] = useState<Vertical>('law_firm');
  const [isLoading, setIsLoading] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [generatedPin, setGeneratedPin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Site intelligence state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [siRecordId, setSiRecordId] = useState<string | null>(null);
  const [siComplete, setSiComplete] = useState(false);
  const [skipAnalysis, setSkipAnalysis] = useState(false);

  // Success state — clipboard feedback
  const [copiedField, setCopiedField] = useState<'url' | 'pin' | null>(null);

  const handleAnalysisComplete = useCallback((recordId: string) => {
    setSiRecordId(recordId);
    setSiComplete(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/onboarding/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientName,
          contactName,
          contactEmail,
          websiteUrl: websiteUrl || undefined,
          siteIntelligenceId: siRecordId || undefined,
          accountManager,
          vertical,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create session');
      }

      // If we have a completed analysis but haven't linked it yet, link now
      if (siRecordId && data.sessionId) {
        try {
          await fetch('/api/admin/site-intelligence/link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: data.sessionId,
              siteIntelligenceId: siRecordId,
            }),
          });
        } catch (linkErr) {
          console.warn('Failed to link site intelligence:', linkErr);
        }
      }

      const baseUrl = window.location.origin;
      setGeneratedUrl(`${baseUrl}/onboarding/${data.token}`);
      setGeneratedPin(data.pin ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = async (text: string, field: 'url' | 'pin') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts; we silently
      // ignore — the value is also selectable in the input field.
    }
  };

  const resetForm = () => {
    setGeneratedUrl(null);
    setGeneratedPin(null);
    setClientName('');
    setContactName('');
    setContactEmail('');
    setWebsiteUrl('');
    setAccountManager('');
    setVertical('law_firm');
    setSiRecordId(null);
    setSiComplete(false);
    setSkipAnalysis(false);
    setSessionId(null);
    setCopiedField(null);
  };

  if (generatedUrl) {
    return (
      <div className="min-h-screen bg-[#F4F5F6]">
        <header className="bg-[#0F1A14]">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/">
              <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
            </Link>
            <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg">
              Clixsy Onboarding Portal
            </div>
          </div>
        </header>

        <div className="flex items-center justify-center py-16 px-4">
          <div className="max-w-2xl w-full mx-auto">
            <div className="bg-white rounded-xl shadow-sm border border-[#E6E8EA] p-8">
              <div className="w-16 h-16 mx-auto mb-6 bg-[#25DC7F]/10 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-2xl font-extrabold text-center text-[#0B0B0B] mb-4">
                Onboarding Link Created!
              </h1>

              {/* Onboarding URL */}
              <p className="text-center text-[#6B6B6B] mb-2">
                Share this link with your client to begin their onboarding:
              </p>
              {siComplete && (
                <p className="text-center text-[#25DC7F] text-sm mb-4 font-medium">
                  Website intelligence is attached — the client will see personalized questions.
                </p>
              )}

              <div className="bg-[#F4F5F6] rounded-lg p-4 mb-6">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={generatedUrl}
                    readOnly
                    aria-label="Onboarding URL"
                    className="flex-1 bg-transparent text-[#0B0B0B] text-sm focus:outline-none"
                  />
                  <button
                    onClick={() => copyToClipboard(generatedUrl, 'url')}
                    className="px-4 py-2 bg-[#25DC7F] text-white rounded-lg text-sm font-semibold hover:bg-[#1DB96A] transition-colors"
                  >
                    {copiedField === 'url' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* PIN */}
              {generatedPin && (
                <div className="border-t border-[#E6E8EA] pt-6 mb-6">
                  <p className="text-center text-[#0B0B0B] font-semibold mb-2">
                    Access PIN
                  </p>
                  <p className="text-center text-[#6B6B6B] text-sm mb-4">
                    Send this 6-digit PIN to your client along with the link.
                    They&apos;ll enter it once to unlock the form.
                  </p>
                  <div className="bg-[#FFF8E1] border border-[#F5A524]/30 rounded-lg p-4 mb-4">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={generatedPin}
                        readOnly
                        aria-label="6-digit PIN"
                        className="flex-1 bg-transparent text-[#0B0B0B] text-2xl font-mono tracking-[0.5em] text-center focus:outline-none"
                      />
                      <button
                        onClick={() => copyToClipboard(generatedPin, 'pin')}
                        className="px-4 py-2 bg-[#25DC7F] text-white rounded-lg text-sm font-semibold hover:bg-[#1DB96A] transition-colors"
                      >
                        {copiedField === 'pin' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  </div>
                  <p className="text-center text-[#E5484D] text-xs">
                    <strong>This PIN won&apos;t be shown again.</strong> Copy it now.
                    If lost, you can regenerate it from the session detail page.
                  </p>
                </div>
              )}

              <div className="flex gap-4">
                <button
                  onClick={resetForm}
                  className="flex-1 px-6 py-3 border border-[#E6E8EA] text-[#0B0B0B] rounded-lg font-semibold hover:bg-[#F4F5F6] transition-colors"
                >
                  Create Another
                </button>
                <Link
                  href="/admin/onboarding/sessions"
                  className="flex-1 px-6 py-3 bg-[#0F1A14] text-white rounded-lg font-semibold text-center hover:bg-[#1A2A1F] transition-colors"
                >
                  View All Sessions
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const canCreateLink =
    clientName.trim() !== '' &&
    accountManager.trim() !== '' &&
    (siComplete || skipAnalysis || !websiteUrl);

  return (
    <div className="min-h-screen bg-[#F4F5F6]">
      <header className="bg-[#0F1A14]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
          </Link>
          <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg">
            Clixsy Onboarding Portal
          </div>
        </div>
      </header>

      <div className="flex items-center justify-center py-16 px-4">
        <div className="max-w-2xl w-full mx-auto space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-[#E6E8EA] p-8">
            <h1 className="text-2xl font-extrabold text-[#0B0B0B] mb-2">
              Create New Onboarding Session
            </h1>
            <p className="text-[#6B6B6B] mb-8">
              Set up a new client onboarding by providing their details below.
            </p>

            {error && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-[#E5484D]">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Client Name */}
              <div>
                <label htmlFor="clientName" className="block text-sm font-semibold text-[#0B0B0B] mb-2">
                  Client Name <span className="text-[#E5484D]">*</span>
                </label>
                <input
                  type="text"
                  id="clientName"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  required
                  placeholder="Acme Corporation"
                  className="w-full px-4 py-3 border border-[#E6E8EA] rounded-lg focus:ring-2 focus:ring-[#25DC7F]/20 focus:border-[#25DC7F] transition-all"
                />
              </div>

              {/* Contact Name */}
              <div>
                <label htmlFor="contactName" className="block text-sm font-semibold text-[#0B0B0B] mb-2">
                  Primary Contact Name
                </label>
                <input
                  type="text"
                  id="contactName"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="John Smith"
                  className="w-full px-4 py-3 border border-[#E6E8EA] rounded-lg focus:ring-2 focus:ring-[#25DC7F]/20 focus:border-[#25DC7F] transition-all"
                />
              </div>

              {/* Contact Email */}
              <div>
                <label htmlFor="contactEmail" className="block text-sm font-semibold text-[#0B0B0B] mb-2">
                  Primary Contact Email
                </label>
                <input
                  type="email"
                  id="contactEmail"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="john@acme.com"
                  className="w-full px-4 py-3 border border-[#E6E8EA] rounded-lg focus:ring-2 focus:ring-[#25DC7F]/20 focus:border-[#25DC7F] transition-all"
                />
              </div>

              {/* Website URL */}
              <div>
                <label htmlFor="websiteUrl" className="block text-sm font-semibold text-[#0B0B0B] mb-2">
                  Client Website URL
                </label>
                <input
                  type="url"
                  id="websiteUrl"
                  value={websiteUrl}
                  onChange={(e) => {
                    setWebsiteUrl(e.target.value);
                    setSiRecordId(null);
                    setSiComplete(false);
                    setSkipAnalysis(false);
                  }}
                  placeholder="https://acme.com"
                  className="w-full px-4 py-3 border border-[#E6E8EA] rounded-lg focus:ring-2 focus:ring-[#25DC7F]/20 focus:border-[#25DC7F] transition-all"
                />
                <p className="mt-1 text-xs text-[#6B6B6B]">
                  Providing a URL enables website analysis to pre-fill onboarding fields.
                </p>
              </div>

              {/* Account Manager (P1) */}
              <div>
                <label htmlFor="accountManager" className="block text-sm font-semibold text-[#0B0B0B] mb-2">
                  Account Manager <span className="text-[#E5484D]">*</span>
                </label>
                <input
                  type="text"
                  id="accountManager"
                  value={accountManager}
                  onChange={(e) => setAccountManager(e.target.value)}
                  required
                  placeholder="Your name"
                  className="w-full px-4 py-3 border border-[#E6E8EA] rounded-lg focus:ring-2 focus:ring-[#25DC7F]/20 focus:border-[#25DC7F] transition-all"
                />
                <p className="mt-1 text-xs text-[#6B6B6B]">
                  The Clixsy person who&apos;ll be this client&apos;s main contact.
                  Surfaces in the thank-you screen.
                </p>
              </div>

              {/* Vertical (P1) */}
              <div>
                <span className="block text-sm font-semibold text-[#0B0B0B] mb-2">
                  Vertical <span className="text-[#E5484D]">*</span>
                </span>
                <div
                  role="radiogroup"
                  aria-label="Vertical"
                  className="grid grid-cols-2 gap-2 p-1 bg-[#F4F5F6] rounded-lg border border-[#E6E8EA]"
                >
                  {([
                    { value: 'law_firm', label: 'Law Firm' },
                    { value: 'home_services', label: 'Home Services' },
                  ] as const).map((opt) => {
                    const selected = vertical === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setVertical(opt.value)}
                        className={
                          'px-4 py-2.5 rounded-md text-sm font-semibold transition-all ' +
                          (selected
                            ? 'bg-white text-[#0B0B0B] shadow-sm border border-[#E6E8EA]'
                            : 'text-[#6B6B6B] hover:text-[#0B0B0B]')
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-xs text-[#6B6B6B]">
                  Used to branch form content downstream. Pick the closest match.
                </p>
              </div>

              {/* Site Intelligence Panel */}
              {websiteUrl && !skipAnalysis && (
                <SiteIntelligencePanel
                  websiteUrl={websiteUrl}
                  sessionId={sessionId || undefined}
                  onAnalysisComplete={handleAnalysisComplete}
                />
              )}

              {websiteUrl && !siComplete && (
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="skipAnalysis"
                    checked={skipAnalysis}
                    onChange={(e) => setSkipAnalysis(e.target.checked)}
                    className="w-4 h-4 text-[#25DC7F] rounded border-[#E6E8EA]"
                  />
                  <label htmlFor="skipAnalysis" className="text-sm text-[#6B6B6B]">
                    Skip website analysis and create link without pre-filled data
                  </label>
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading || !canCreateLink}
                className="w-full px-6 py-3 bg-[#25DC7F] text-white rounded-lg font-semibold hover:bg-[#1DB96A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Creating...' : 'Create Onboarding Link'}
              </button>

              {websiteUrl && !siComplete && !skipAnalysis && (
                <p className="text-xs text-[#F5A524] text-center">
                  Run the website analysis above or skip it to enable the create button.
                </p>
              )}
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
