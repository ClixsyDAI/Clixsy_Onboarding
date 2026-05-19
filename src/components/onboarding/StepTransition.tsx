'use client';

import { useEffect, useState } from 'react';
import type { TransitionMessage } from '@/lib/onboarding/transition-messages';

interface StepTransitionProps {
  active: boolean;
  message: TransitionMessage | null;
  /**
   * Stage 10 / Fix 4: fires when the splash reaches full opacity and
   * is guaranteed to fully cover the underlying page. The parent should
   * swap the step + reset scroll inside this callback so the swap is
   * invisible to the user. Optional — older call sites that only care
   * about onDone (e.g. the first-load welcome interstitial that has no
   * step to swap) can omit it.
   */
  onCovered?: () => void;
  onDone: () => void;
}

// Splash opacity transition duration. Keep this in sync with the CSS
// `transition: 'opacity 0.4s ease-in-out'` below — onCovered fires at
// FADE_IN_DELAY_MS + FADE_DURATION_MS so the swap is gated on the
// transition finishing, not just on the timer being set.
const FADE_IN_DELAY_MS = 50;
const FADE_DURATION_MS = 400;
const COVERED_AT_MS = FADE_IN_DELAY_MS + FADE_DURATION_MS;
const DWELL_AFTER_COVERED_MS = 1250; // how long to read the cheer line
const FADE_OUT_AT_MS = COVERED_AT_MS + DWELL_AFTER_COVERED_MS;
const DONE_AT_MS = FADE_OUT_AT_MS + FADE_DURATION_MS;

export default function StepTransition({ active, message, onCovered, onDone }: StepTransitionProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active || !message) {
      setVisible(false);
      return;
    }

    // 1. Mount at opacity 0, then transition to 1.
    const fadeIn = setTimeout(() => setVisible(true), FADE_IN_DELAY_MS);

    // 2. Splash now at 100% opacity — fire onCovered. This is the moment
    //    the parent can safely swap the step / scroll to top: the user
    //    cannot see any of the underlying DOM mutating.
    const covered = setTimeout(() => onCovered?.(), COVERED_AT_MS);

    // 3. Begin fade out after the dwell.
    const fadeOut = setTimeout(() => setVisible(false), FADE_OUT_AT_MS);

    // 4. Signal completion after fade-out finishes.
    const done = setTimeout(() => onDone(), DONE_AT_MS);

    return () => {
      clearTimeout(fadeIn);
      clearTimeout(covered);
      clearTimeout(fadeOut);
      clearTimeout(done);
    };
  }, [active, message, onCovered, onDone]);

  if (!active || !message) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#F4F5F6',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.4s ease-in-out',
      }}
    >
      <div style={{ textAlign: 'center', padding: '0 1.5rem' }}>
        <p
          style={{
            fontSize: 'clamp(1.5rem, 4vw, 1.875rem)',
            fontWeight: 700,
            fontStyle: 'italic',
            color: '#25DC7F',
            marginBottom: '0.75rem',
            lineHeight: 1.3,
          }}
        >
          {message.cheerLine}
        </p>
        <p
          style={{
            fontSize: 'clamp(1.25rem, 3.5vw, 1.5rem)',
            fontWeight: 700,
            color: '#1A1D1F',
            lineHeight: 1.3,
          }}
        >
          {message.nextLine}
        </p>
      </div>
    </div>
  );
}
