'use client';

import { useEffect, useMemo, useState } from 'react';
import { ACCESS_ITEMS } from '@/lib/onboarding/accessChecklist';
import { ACCESS_STATUS_OPTIONS, TUTORIAL_VIDEOS } from './AccessChecklistStep';
import { youTubeId } from '@/lib/onboarding/youtube';

/**
 * Sprint 2 / #3: the welcome wizard. Replaces the two-step WelcomeModal
 * for v2 sessions with a three-step flow per the managers' mockup
 * (onboarding-wizard-mockup.html):
 *
 *   1. Welcome — personalised "Hey {client}!"
 *   2. Urgent access — WordPress Admin + Google Search Console status
 *      rows, mirroring the access-checklist step exactly (same option
 *      values, same whatWeNeed copy, same tutorial videos — all imported
 *      from the same constants, so they can never drift)
 *   3. Confirmation — flips welcome_wizard_seen on "Continue to onboarding"
 *
 * Rules (operator-locked):
 *  - NO skip / backdrop dismiss / escape — Continue on step 2 is disabled
 *    until BOTH dropdowns have a selection ("I'll do this later" is the
 *    soft-out). The flag flips only on finishing step 3.
 *  - Selections persist as REAL form data into the access_checklist step
 *    (via onFinish, wired to save-step in Wizard.tsx) so the access step
 *    later shows them pre-filled.
 *  - Never rendered under AM bypass or for v1 sessions (gated in Wizard).
 */

type WizardStatuses = {
  wordpress_access_status: string;
  gsc_access_status: string;
};

interface WelcomeAccessWizardProps {
  companyName: string;
  /** Persist statuses + flip welcome_wizard_seen + close. May reject. */
  onFinish: (statuses: WizardStatuses) => Promise<void>;
}

const STEP_TITLES = ['Welcome aboard', '2 things we need urgently', "You're all set"];

const URGENT_KEYS = ['wordpress', 'gsc'] as const;
type UrgentKey = (typeof URGENT_KEYS)[number];

/** Render whatWeNeed copy with the email styled as a code chip. */
function WhatWeNeed({ text }: { text: string }) {
  const emailMatch = text.match(/\S+@\S+\.\S+/);
  if (!emailMatch) return <>{text}</>;
  const email = emailMatch[0];
  const [before, after] = text.split(email);
  return (
    <>
      {before}
      <code className="px-1.5 py-0.5 bg-[var(--bg)] rounded text-[13px] text-[var(--text)]">{email}</code>
      {after}
    </>
  );
}

export default function WelcomeAccessWizard({ companyName, onFinish }: WelcomeAccessWizardProps) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [statuses, setStatuses] = useState<Record<UrgentKey, string>>({ wordpress: '', gsc: '' });
  const [openTutorial, setOpenTutorial] = useState<UrgentKey | null>(null);
  const [playing, setPlaying] = useState<UrgentKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [visible, setVisible] = useState(false);

  // Mount → fade in (mirrors WelcomeModal).
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 30);
    return () => clearTimeout(t);
  }, []);

  const items = useMemo(
    () =>
      URGENT_KEYS.map((key) => {
        const item = ACCESS_ITEMS.find((i) => i.key === key);
        const tutorial = TUTORIAL_VIDEOS[key];
        return {
          key,
          label: item?.label ?? key,
          whatWeNeed: item?.whatWeNeed ?? '',
          tutorialTitle: tutorial?.title ?? '',
          videoId: tutorial ? youTubeId(tutorial.url) : null,
        };
      }),
    [],
  );

  const bothSelected = URGENT_KEYS.every((k) => statuses[k] !== '');

  const handleFinish = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onFinish({
        wordpress_access_status: statuses.wordpress,
        gsc_access_status: statuses.gsc,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-wizard-headline"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{
        background: 'rgba(15, 26, 20, 0.62)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 240ms ease',
      }}
    >
      <div
        className="relative w-full max-w-[660px] bg-[var(--card)] rounded-2xl shadow-2xl overflow-hidden"
        style={{
          transform: visible ? 'scale(1)' : 'scale(0.96)',
          transition: 'transform 240ms ease',
        }}
      >
        {/* Header — dark bar matching the portal header, title + progress dots */}
        <div className="bg-[var(--side)] px-7 py-5 flex items-center justify-between">
          <span className="text-[var(--text)] text-sm font-extrabold tracking-wide">
            {STEP_TITLES[step]}
          </span>
          <div className="flex gap-1.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`h-2 rounded-full transition-all ${
                  i <= step ? 'bg-[var(--green-fill)]' : 'bg-[var(--cardhi)]'
                } ${i === step ? 'w-5' : 'w-2'}`}
              />
            ))}
          </div>
        </div>

        {/* STEP 1 — Welcome */}
        {step === 0 && (
          <div className="px-9 py-8">
            <h1
              id="welcome-wizard-headline"
              className="text-[26px] leading-tight font-extrabold text-[var(--text)] mb-3"
              style={{ overflowWrap: 'anywhere' }}
            >
              Hey <span className="text-[var(--green)]">{companyName || 'there'}</span>! We&apos;re
              thrilled to be working with you.
            </h1>
            <p className="text-[15px] leading-relaxed text-[var(--muted)]">
              We&apos;ve already done some homework on your site and we&apos;re excited to get
              going. Before we dive into the full onboarding,{' '}
              <span className="text-[var(--green)] font-semibold">
                there are just a couple of things we need from you
              </span>{' '}
              to get the ball rolling.
            </p>
          </div>
        )}

        {/* STEP 2 — Urgent access items */}
        {step === 1 && (
          <div className="px-9 py-7">
            <h1 className="text-[24px] font-extrabold text-[var(--text)] mb-2">
              Everything else can wait.
            </h1>
            <p className="text-[15px] text-[var(--muted)] mb-4">
              To start work immediately, we urgently need access to these two services.
            </p>

            <div className="flex gap-2.5 bg-[var(--amber-soft)] border border-[var(--amber-soft)] text-[var(--amber)] rounded-xl px-4 py-3 text-[13.5px] leading-relaxed mb-5">
              <span>
                <b className="text-[var(--amber)]">Why these two?</b> WordPress lets us optimize, and
                Search Console lets us track your rankings from day one. The rest of your
                onboarding can follow at your own pace.
              </span>
            </div>

            <div className="border border-[var(--border2)] rounded-xl overflow-hidden">
              <div className="hidden sm:grid grid-cols-[1.15fr_1.45fr_170px] gap-4 bg-[var(--bg)] px-4 py-3 text-xs font-bold text-[var(--muted)]">
                <span>Service</span>
                <span>What We Need</span>
                <span>Status</span>
              </div>
              {items.map((item) => (
                <div key={item.key} className="border-t border-[var(--border2)]">
                  <div className="grid grid-cols-1 sm:grid-cols-[1.15fr_1.45fr_170px] gap-3 sm:gap-4 items-center px-4 py-3.5">
                    <div>
                      <div className="font-bold text-[15px] text-[var(--text)]">{item.label}</div>
                      {item.videoId && (
                        <button
                          type="button"
                          onClick={() => {
                            setOpenTutorial(openTutorial === item.key ? null : item.key);
                            setPlaying(null);
                          }}
                          className="inline-flex items-center gap-1.5 mt-1.5 text-[13px] font-bold text-[var(--green)] hover:text-[var(--green)] transition-colors"
                        >
                          <span className="w-[17px] h-[17px] bg-[var(--green-fill)] rounded flex items-center justify-center shrink-0">
                            <span
                              className="block ml-px"
                              style={{
                                borderLeft: '6px solid var(--on-green)',
                                borderTop: '4px solid transparent',
                                borderBottom: '4px solid transparent',
                              }}
                            />
                          </span>
                          {openTutorial === item.key ? 'Hide tutorial' : 'Watch tutorial'}
                        </button>
                      )}
                    </div>
                    <div className="text-sm text-[var(--muted)] leading-snug">
                      <WhatWeNeed text={item.whatWeNeed} />
                    </div>
                    <div>
                      <select
                        value={statuses[item.key]}
                        onChange={(e) =>
                          setStatuses((prev) => ({ ...prev, [item.key]: e.target.value }))
                        }
                        aria-label={`${item.label} status`}
                        className={`w-full border rounded-lg px-3 py-2.5 text-[13px] font-semibold cursor-pointer focus:outline-none focus:ring-2 focus:ring-[var(--green)]/30 ${
                          statuses[item.key] === 'done'
                            ? 'border-[var(--green)] bg-[var(--green-fill)]/10 text-[var(--green)]'
                            : 'border-[var(--border2)] text-[var(--faint)] bg-[var(--card)]'
                        }`}
                      >
                        <option value="" disabled>
                          Select status…
                        </option>
                        {ACCESS_STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {openTutorial === item.key && item.videoId && (
                    <div className="mx-4 mb-4 border border-[var(--border2)] rounded-xl overflow-hidden">
                      <div className="flex items-center gap-2 px-3.5 py-2.5 bg-[var(--card)] border-b border-[var(--border2)]">
                        <span className="w-[18px] h-[18px] bg-[var(--red)] rounded flex items-center justify-center shrink-0">
                          <span
                            className="block ml-px"
                            style={{
                              borderLeft: '7px solid var(--on-green)',
                              borderTop: '4.5px solid transparent',
                              borderBottom: '4.5px solid transparent',
                            }}
                          />
                        </span>
                        <span className="text-[13px] font-bold text-[var(--text)]">
                          {item.tutorialTitle}
                        </span>
                      </div>
                      <div className="relative w-full aspect-video bg-black">
                        {playing === item.key ? (
                          <iframe
                            src={`https://www.youtube.com/embed/${item.videoId}?autoplay=1&rel=0`}
                            title={item.tutorialTitle}
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            allowFullScreen
                            className="absolute inset-0 w-full h-full border-0"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPlaying(item.key)}
                            aria-label={`Play ${item.tutorialTitle}`}
                            className="absolute inset-0 w-full h-full cursor-pointer"
                            style={{
                              backgroundImage: `url(https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg)`,
                              backgroundSize: 'cover',
                              backgroundPosition: 'center',
                            }}
                          >
                            <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[62px] h-[44px] bg-[var(--red)] hover:bg-[var(--red)] rounded-xl flex items-center justify-center shadow-lg transition-colors">
                              <span
                                className="block ml-1"
                                style={{
                                  borderLeft: '18px solid var(--on-green)',
                                  borderTop: '11px solid transparent',
                                  borderBottom: '11px solid transparent',
                                }}
                              />
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* STEP 3 — Confirmation */}
        {step === 2 && (
          <div className="px-9 py-9 text-center">
            <div className="w-16 h-16 mx-auto mb-5 bg-[var(--green-fill)]/10 rounded-full flex items-center justify-center">
              <svg
                className="w-8 h-8 text-[var(--green)]"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-[24px] font-extrabold text-[var(--text)] mb-2">
              That&apos;s everything we need to begin.
            </h1>
            <p className="text-[15px] text-[var(--muted)]">
              Our team will confirm access and get to work right away. You can now continue
              through the rest of your onboarding at your own pace.
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-9 py-4 border-t border-[var(--border2)] bg-[var(--card)]">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((s) => (s === 2 ? 1 : 0))}
              className="text-sm font-semibold text-[var(--muted)] hover:text-[var(--faint)] transition-colors py-2"
            >
              ← Back
            </button>
          ) : (
            <span />
          )}
          {step === 0 && (
            <button
              type="button"
              onClick={() => setStep(1)}
              className="px-6 py-3 bg-[var(--green-fill)] text-[var(--on-green)] rounded-lg text-sm font-extrabold hover:bg-[var(--green-dim)] transition-colors"
            >
              Let&apos;s get started →
            </button>
          )}
          {step === 1 && (
            <button
              type="button"
              disabled={!bothSelected}
              onClick={() => setStep(2)}
              className="px-6 py-3 bg-[var(--green-fill)] text-[var(--on-green)] rounded-lg text-sm font-extrabold hover:bg-[var(--green-dim)] transition-colors disabled:bg-[var(--border2)] disabled:text-[var(--faint)] disabled:cursor-not-allowed"
            >
              Continue →
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              disabled={submitting}
              onClick={handleFinish}
              className="px-6 py-3 bg-[var(--green-fill)] text-[var(--on-green)] rounded-lg text-sm font-extrabold hover:bg-[var(--green-dim)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? 'Just a moment…' : 'Continue to onboarding →'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
