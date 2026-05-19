'use client';

import { useEffect, useState } from 'react';

/**
 * P3 (Stage 7): two-step welcome modal that fires once per session on
 * the first PIN-authed load.
 *
 *   Step 1 — "Hey there, {{Client company name}}!"
 *            "We're glad to have you onboard!"   [Thanks, us too!]
 *
 *   Step 2 — "To start optimizing your online presence, we need to
 *            get to know you a little better."  [Start onboarding]
 *
 * Clicking Start onboarding:
 *  - POSTs to /api/public/onboarding/mark-welcome-seen so the flag is
 *    set server-side BEFORE we dismiss the modal (so a network drop
 *    on the very last click doesn't leave us showing the modal twice).
 *  - Calls onDismiss(), which closes the modal and reveals the form.
 *
 * No backdrop dismiss / no escape key — the spec says the wizard
 * gates the form, so dismissing it without progressing back to "step
 * 1 of the form" would be confusing.
 */
interface WelcomeModalProps {
  companyName: string;
  token: string;
  onDismiss: () => void;
}

export default function WelcomeModal({ companyName, token, onDismiss }: WelcomeModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);
  const [visible, setVisible] = useState(false);

  // Mount → fade in (so the modal doesn't pop in jarringly).
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 30);
    return () => clearTimeout(t);
  }, []);

  const handleFinish = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const resp = await fetch('/api/public/onboarding/mark-welcome-seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!resp.ok) {
        // Surface the failure but still let the user proceed locally
        // — the next session load will see welcome_wizard_seen=false
        // and re-fire the modal, which is the right failure mode.
        console.error('mark-welcome-seen failed', await resp.text().catch(() => ''));
      }
    } catch (err) {
      console.error('mark-welcome-seen network error', err);
    } finally {
      setSubmitting(false);
      onDismiss();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-modal-headline"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{
        background: 'rgba(15, 26, 20, 0.55)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 240ms ease',
      }}
    >
      <div
        className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[#E6E8EA] p-8"
        style={{
          transform: visible ? 'scale(1)' : 'scale(0.96)',
          transition: 'transform 240ms ease',
        }}
      >
        {/* Step pip indicator */}
        <div className="flex justify-center gap-2 mb-6">
          <span
            className={`h-1.5 rounded-full transition-all ${step === 1 ? 'w-6 bg-[#25DC7F]' : 'w-1.5 bg-[#E6E8EA]'}`}
            aria-hidden
          />
          <span
            className={`h-1.5 rounded-full transition-all ${step === 2 ? 'w-6 bg-[#25DC7F]' : 'w-1.5 bg-[#E6E8EA]'}`}
            aria-hidden
          />
        </div>

        {step === 1 ? (
          <div className="text-center">
            <div className="w-14 h-14 mx-auto mb-5 bg-[#25DC7F]/10 rounded-full flex items-center justify-center">
              <svg className="w-7 h-7 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h1
              id="welcome-modal-headline"
              className="text-2xl font-extrabold text-[#0B0B0B] mb-2"
              style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
            >
              Hey there, {companyName || 'friend'}!
            </h1>
            <p className="text-base text-[#6B6B6B] mb-6">We&apos;re glad to have you onboard!</p>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="w-full py-3 bg-[#25DC7F] text-white rounded-lg font-semibold hover:bg-[#1DB96A] transition-colors"
            >
              Thanks, us too!
            </button>
          </div>
        ) : (
          <div className="text-center">
            <div className="w-14 h-14 mx-auto mb-5 bg-[#25DC7F]/10 rounded-full flex items-center justify-center">
              <svg className="w-7 h-7 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-[#0B0B0B] mb-2">Let&apos;s get to know you</h2>
            <p className="text-base text-[#6B6B6B] mb-6">
              To start optimizing your online presence, we need to get to know you a little better.
            </p>
            <button
              type="button"
              onClick={handleFinish}
              disabled={submitting}
              className="w-full py-3 bg-[#25DC7F] text-white rounded-lg font-semibold hover:bg-[#1DB96A] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? 'Just a moment…' : 'Start onboarding'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
