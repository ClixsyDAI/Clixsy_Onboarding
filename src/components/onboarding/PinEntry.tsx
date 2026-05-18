'use client';

import { useEffect, useRef, useState } from 'react';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

type LockState = null | { kind: 'permanent' } | { kind: 'rate_limited'; retryAfter?: string };

interface PinEntryProps {
  token: string;
  clientName: string;
  initialLock: LockState;
  onSuccess: () => void;
}

/**
 * Six-slot PIN entry screen (Stage 7).
 *
 * UX:
 *  - 6 single-character inputs, auto-advance on digit, backspace
 *    steps back. Paste a 6-digit string and it spreads across all
 *    slots in one go.
 *  - Submit fires automatically when the 6th digit lands; an
 *    explicit "Verify" button is also available for keyboard / a11y.
 *  - Errors are generic per spec — "That PIN doesn't match. Please
 *    check with your Clixsy contact."
 *  - 429 / 423 responses surface the lock state above the input, and
 *    the input is disabled when permanently locked.
 *
 * Success → calls onSuccess, which is wired to reload the parent
 * page so the freshly-set cookie carries through the new fetch and
 * the form (or Welcome Wizard) renders.
 */
export default function PinEntry({ token, clientName, initialLock, onSuccess }: PinEntryProps) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lock, setLock] = useState<LockState>(initialLock);
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (!lock) inputsRef.current[0]?.focus();
  }, [lock]);

  const handleChange = (idx: number, raw: string) => {
    setError(null);
    const cleaned = raw.replace(/\D/g, '');
    if (cleaned.length === 0) {
      const next = [...digits];
      next[idx] = '';
      setDigits(next);
      return;
    }
    if (cleaned.length === 1) {
      const next = [...digits];
      next[idx] = cleaned;
      setDigits(next);
      if (idx < 5) inputsRef.current[idx + 1]?.focus();
      else void tryVerify(next.join(''));
      return;
    }
    // Paste case — distribute across remaining slots.
    const next = [...digits];
    for (let i = 0; i < cleaned.length && idx + i < 6; i++) {
      next[idx + i] = cleaned[i];
    }
    setDigits(next);
    const filledTo = Math.min(idx + cleaned.length, 5);
    inputsRef.current[filledTo]?.focus();
    if (next.every((d) => d !== '')) void tryVerify(next.join(''));
  };

  const handleKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
      inputsRef.current[idx - 1]?.focus();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (digits.every((d) => d !== '')) void tryVerify(digits.join(''));
    }
  };

  const tryVerify = async (pin: string) => {
    if (pin.length !== 6 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch('/api/public/onboarding/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, pin }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.success) {
        onSuccess();
        return;
      }
      // Translate locked responses into the persistent lock state.
      if (data.locked === 'permanent') {
        setLock({ kind: 'permanent' });
        setError(null);
      } else if (data.locked === 'rate_limited') {
        setLock({ kind: 'rate_limited', retryAfter: data.retryAfter });
        setError(null);
      } else {
        setError(typeof data.error === 'string' ? data.error : "That PIN doesn't match. Please check with your Clixsy contact.");
        // Clear the input so the user can re-enter cleanly.
        setDigits(['', '', '', '', '', '']);
        inputsRef.current[0]?.focus();
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const disabledByLock = lock?.kind === 'permanent';

  return (
    <div className="min-h-screen bg-[#F4F5F6] flex flex-col">
      <header className="bg-[#0F1A14]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
          <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg">
            Clixsy Onboarding Portal
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8 border border-[#E6E8EA]">
          <div className="text-center mb-6">
            <div className="w-12 h-12 mx-auto mb-4 bg-[#25DC7F]/10 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m0 0v2m0-2h2m-2 0H10m9-9V6a3 3 0 00-6 0v2M5 12h14a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-[#0B0B0B] mb-1">
              {clientName ? `Welcome, ${clientName}` : 'Welcome'}
            </h1>
            <p className="text-sm text-[#6B6B6B]">
              Enter the 6-digit PIN your Clixsy account manager sent you.
            </p>
          </div>

          {lock?.kind === 'permanent' && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-[#E5484D] font-medium">
                This onboarding link is locked after too many incorrect attempts.
              </p>
              <p className="text-xs text-[#6B6B6B] mt-1">
                Please contact your Clixsy account manager to reissue access.
              </p>
            </div>
          )}

          {lock?.kind === 'rate_limited' && (
            <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-[#92400E] font-medium">
                Too many incorrect attempts. Try again in about 15 minutes.
              </p>
              <p className="text-xs text-[#6B6B6B] mt-1">
                Or contact your Clixsy account manager if you can&apos;t wait.
              </p>
            </div>
          )}

          <div className="flex justify-between gap-2 mb-4" role="group" aria-label="PIN entry">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => {
                  inputsRef.current[i] = el;
                }}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={i === 0 ? 6 : 1}
                value={d}
                onChange={(e) => handleChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                disabled={disabledByLock || submitting}
                aria-label={`PIN digit ${i + 1}`}
                className={`w-12 h-14 text-center text-2xl font-semibold rounded-lg border transition-colors ${
                  error
                    ? 'border-[#E5484D] bg-red-50'
                    : 'border-[#E6E8EA] bg-white focus:border-[#25DC7F] focus:ring-2 focus:ring-[#25DC7F]/20'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              />
            ))}
          </div>

          {error && (
            <p className="mb-4 text-sm text-[#E5484D] text-center" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void tryVerify(digits.join(''))}
            disabled={disabledByLock || submitting || digits.some((d) => d === '')}
            className="w-full py-3 bg-[#25DC7F] text-white rounded-lg font-semibold hover:bg-[#1DB96A] transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {submitting ? 'Verifying…' : 'Verify PIN'}
          </button>
        </div>
      </main>
    </div>
  );
}
