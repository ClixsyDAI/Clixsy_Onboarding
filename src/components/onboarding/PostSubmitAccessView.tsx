'use client';

import { useState } from 'react';
import Link from 'next/link';
import AccessChecklistStep from './AccessChecklistStep';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

interface PostSubmitAccessViewProps {
  token: string;
  /** Bypass signature from the URL, sent as the x-am-bypass header. */
  amToken?: string | null;
  isAmBypass?: boolean;
  flowVersion: 'v1' | 'v2';
  /**
   * The full persisted access_checklist answers for this session. Seeds
   * local state so the nine fields (the seven rendered status selects plus
   * has_google_analytics / has_youtube, which this component preserves but
   * does not render) survive the round-trip — the update-access route
   * REPLACES the whole answers object, so anything not sent back is lost.
   */
  initialAccessAnswers: Record<string, unknown>;
}

/**
 * Post-submit "Update account access" view (Step 3). Reached at
 * /onboarding/[token]?view=access after a session is submitted. Reuses
 * AccessChecklistStep so the dropdowns and tutorials match the in-form
 * step exactly, and POSTs to /api/public/onboarding/update-access, which
 * writes answers without reopening the submitted session.
 *
 * v2 only renders the editable checklist. v1 (legacy) sessions use a
 * different, multi-step access structure that this single view cannot
 * safely edit, so they get a contact-your-AM message instead. The
 * ThankYou entry button is already gated to v2; this guard is defensive
 * for anyone who hits the URL directly on a v1 session.
 */
export default function PostSubmitAccessView({
  token,
  amToken = null,
  isAmBypass = false,
  flowVersion,
  initialAccessAnswers,
}: PostSubmitAccessViewProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initialAccessAnswers }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const backHref = `/onboarding/${encodeURIComponent(token)}${amToken ? `?am=${encodeURIComponent(amToken)}` : ''}`;

  const handleChange = (name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch('/api/public/onboarding/update-access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isAmBypass && amToken ? { 'x-am-bypass': amToken } : {}),
        },
        body: JSON.stringify({ token, answers: values }),
      });
      if (resp.ok) {
        setSaved(true);
      } else {
        const body = await resp.json().catch(() => ({}));
        setError(body?.error || 'Could not save your changes. Please try again.');
      }
    } catch {
      setError('Could not reach the onboarding service. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <header className="bg-[var(--side)]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
          <div className="px-4 py-2 bg-[var(--card2)] text-[var(--text)] text-sm font-semibold rounded-lg">
            Clixsy Onboarding Portal
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-10">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] transition-colors mb-6"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to confirmation
        </Link>

        <h1 className="text-2xl font-extrabold text-[var(--text)] mb-2">Update account access</h1>
        <p className="text-[var(--muted)] mb-8">
          You can update the status of any access item below at any time. Your account manager
          will see the changes right away.
        </p>

        {flowVersion === 'v2' ? (
          <>
            <AccessChecklistStep values={values} errors={{}} onChange={handleChange} />

            <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-6 py-3 bg-[var(--green-fill)] text-[var(--on-green)] rounded-lg font-semibold hover:bg-[var(--green-dim)] transition-colors disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save access updates'}
              </button>
              {saved && (
                <span className="text-sm text-[var(--green)] font-medium" aria-live="polite">
                  Your updates have been saved.
                </span>
              )}
              {error && (
                <span className="text-sm text-[var(--red)]" role="alert">
                  {error}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="border border-[var(--border2)] rounded-xl p-6 bg-[var(--card)]">
            <p className="text-sm text-[var(--muted)]">
              To update your access details, please reply to the email from your Clixsy account
              manager or reach out to them directly. They will get everything set up for you.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
