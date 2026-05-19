'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

// Brand green palette pulled from globals.css `--clix-green*` tokens.
// Hardcoded here because canvas-confetti can't read CSS variables (it
// renders to a canvas overlay, not a styled element).
const BRAND_GREENS = ['#25DC7F', '#1DB96A', '#5be8a8', '#0f6c3c', '#9bf0c2'];

interface ThankYouProps {
  companyName: string;
  accountManagerName: string;
  token: string;
}

/**
 * Rebuilt post-submit screen (Stage 8 / S12.1–S12.4).
 *
 *   S12.1  Brand-green confetti explosion on mount + 400ms pop-in
 *          animation on the message card (CSS keyframe `clixsy-pop-in`
 *          in globals.css).
 *   S12.2  New copy. {{Company name}} from Step 3 (or session client
 *          name fallback). {{Account manager name}} from Stage 1's
 *          `onboarding_sessions.account_manager` (or "your account
 *          manager" fallback). Both interpolated server-side and
 *          passed in as props so they're guaranteed to match the
 *          persisted state.
 *   S12.3  No "close this window" line.
 *   S12.4  5 clickable stars, "Finish onboarding" button. Rating is
 *          optional; Finish never depends on a rating having been
 *          recorded. POST to /api/public/onboarding/submit-feedback
 *          when stars are clicked or when Finish is clicked with a
 *          set rating.
 *
 * Final state per S12.4: clicking Finish swaps the card to a calm
 * "thanks, see you soon" state. We avoid `window.close()` because
 * browsers reject it for tabs not opened via `window.open()`, and
 * we avoid an external redirect because there's no guaranteed
 * brand-home URL for every deployment.
 */
export default function ThankYou({ companyName, accountManagerName, token }: ThankYouProps) {
  const [hoveredStar, setHoveredStar] = useState(0);
  const [selectedRating, setSelectedRating] = useState<number>(0);
  const [submittingRating, setSubmittingRating] = useState(false);
  const [ratingPersisted, setRatingPersisted] = useState(false);
  const [finished, setFinished] = useState(false);
  const confettiFiredRef = useRef(false);

  // Confetti fires once on mount. canvas-confetti spawns its own canvas
  // sized to the viewport, so we don't need to manage one ourselves.
  useEffect(() => {
    if (confettiFiredRef.current) return;
    confettiFiredRef.current = true;
    const fire = (originX: number) =>
      confetti({
        particleCount: 80,
        spread: 75,
        origin: { x: originX, y: 0.55 },
        colors: BRAND_GREENS,
        scalar: 1,
        ticks: 220,
        gravity: 1.1,
        startVelocity: 45,
      });
    fire(0.15);
    fire(0.85);
    // A small follow-up burst from the centre 200ms later — feels less
    // mechanical than a single shot.
    const t = setTimeout(() => {
      confetti({
        particleCount: 60,
        spread: 100,
        origin: { x: 0.5, y: 0.4 },
        colors: BRAND_GREENS,
        scalar: 0.9,
      });
    }, 220);
    return () => clearTimeout(t);
  }, []);

  const persistRating = useCallback(
    async (rating: number) => {
      setSubmittingRating(true);
      try {
        const resp = await fetch('/api/public/onboarding/submit-feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, rating }),
        });
        if (resp.ok) {
          setRatingPersisted(true);
        } else {
          console.warn('submit-feedback failed', await resp.text().catch(() => ''));
        }
      } catch (err) {
        console.warn('submit-feedback network error', err);
      } finally {
        setSubmittingRating(false);
      }
    },
    [token]
  );

  const handleStarClick = (n: number) => {
    setSelectedRating(n);
    void persistRating(n);
  };

  const handleFinish = () => {
    setFinished(true);
  };

  // Friendly fallbacks per the doc.
  const company = companyName?.trim() || 'friend';
  const am = accountManagerName?.trim() || 'your account manager';

  return (
    <div className="min-h-screen bg-[#F4F5F6]">
      <header className="bg-[#0F1A14]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
          <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg">
            Clixsy Onboarding Portal
          </div>
        </div>
      </header>

      <div className="flex items-center justify-center px-4 py-16">
        <div className="max-w-xl w-full p-10 bg-white rounded-2xl shadow-lg text-center animate-clixsy-pop-in">
          {finished ? (
            // Final neutral state per S12.4.
            <>
              <div className="w-14 h-14 mx-auto mb-5 bg-[#25DC7F]/10 rounded-full flex items-center justify-center">
                <svg className="w-7 h-7 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-2xl font-extrabold text-[#0B0B0B] mb-3">Thanks again — see you soon.</h1>
              <p className="text-[#6B6B6B]">
                {am === 'your account manager' ? am.charAt(0).toUpperCase() + am.slice(1) : am} will be in touch shortly.
                {ratingPersisted && ' Thanks for the rating!'}
              </p>
            </>
          ) : (
            <>
              <div className="w-16 h-16 mx-auto mb-6 bg-[#25DC7F]/10 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>

              {/* S12.2 — new copy with company + AM interpolation. */}
              <h1
                className="text-2xl font-extrabold text-[#0B0B0B] mb-3"
                style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
              >
                We&apos;ve got all your onboarding details, thank you, {company}!
              </h1>
              <p className="text-[#1A1A1A] mb-8">
                We&apos;re looking forward to welcoming you to the Clixsy experience.
              </p>

              <div className="text-left mb-8 border-t border-[#E6E8EA] pt-6">
                <h2 className="text-lg font-bold text-[#0B0B0B] mb-2">What happens next?</h2>
                <p className="text-[#6B6B6B]">
                  Our team will review all your information and prepare the last few steps in
                  getting you onboarded. You can expect an email from your personal account
                  manager, <span className="font-semibold text-[#0B0B0B]">{am}</span>, soon!
                </p>
              </div>

              {/* S12.4 — star rating. Hover fills left-to-right; click locks in. */}
              <div className="border-t border-[#E6E8EA] pt-6 mb-6">
                <h3 className="text-sm font-semibold text-[#0B0B0B] mb-3">
                  How would you rate our onboarding process?
                </h3>
                <div
                  className="flex justify-center gap-2"
                  onMouseLeave={() => setHoveredStar(0)}
                  role="radiogroup"
                  aria-label="Onboarding experience rating"
                >
                  {[1, 2, 3, 4, 5].map((n) => {
                    const active = (hoveredStar || selectedRating) >= n;
                    return (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={selectedRating === n}
                        aria-label={`${n} star${n === 1 ? '' : 's'}`}
                        onMouseEnter={() => setHoveredStar(n)}
                        onClick={() => handleStarClick(n)}
                        disabled={submittingRating}
                        className="p-1 transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[#25DC7F]/40 rounded"
                      >
                        <svg
                          className={`w-8 h-8 transition-colors ${
                            active ? 'text-[#25DC7F]' : 'text-[#E6E8EA]'
                          }`}
                          fill="currentColor"
                          viewBox="0 0 24 24"
                          aria-hidden
                        >
                          <path d="M12 17.27l5.18 3.73-1.64-6.81L21 9.24l-6.91-.59L12 2 9.91 8.65 3 9.24l5.46 4.95-1.64 6.81z" />
                        </svg>
                      </button>
                    );
                  })}
                </div>
                {ratingPersisted && (
                  <p className="mt-3 text-xs text-[#25DC7F] font-medium" aria-live="polite">
                    Thanks for the feedback!
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={handleFinish}
                className="w-full py-3 bg-[#25DC7F] text-white rounded-lg font-semibold hover:bg-[#1DB96A] transition-colors"
              >
                Finish onboarding
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
