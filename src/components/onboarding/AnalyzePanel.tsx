'use client';

// =============================================================
// AnalyzePanel — step 1 (primary_contact) site-intelligence trigger
// =============================================================
//
// Renders above the form card on step 1 of the wizard. Drives the
// client-side site-intelligence flow:
//   - idle:        "Analyze my site" button (disabled until URL filled).
//   - analyzing:   in-flight spinner + reassurance that the client can
//                  continue filling step 1 in parallel.
//   - completed:   "✓ Prefill applied" confirmation (rich results live
//                  in the separate WebsiteSnapshot below).
//   - failed:      error message + "Try again" + "Continue without".
//   - timed_out:   same as failed but with a different headline copy.
//
// State + handlers are owned by Wizard.tsx — this component is a
// pure render based on props.

export type AnalyzeState =
  | 'idle'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'timed_out';

interface AnalyzePanelProps {
  state: AnalyzeState;
  error: string | null;
  websiteUrl: string;
  /** True when the session already has a completed site_intelligence
   *  record linked (admin-flow sessions, or a previous successful
   *  client-side analyze). When true, the panel renders a passive
   *  "we've already analyzed your site" notice instead of the
   *  trigger UI — re-analyze is opted-in via editing the URL field
   *  itself, which resets state back to idle. */
  hasExistingAnalysis: boolean;
  onAnalyze: () => void;
  onRetry: () => void;
  onSkip: () => void;
}

const cardBase =
  'rounded-xl border p-4 mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3';

export default function AnalyzePanel({
  state,
  error,
  websiteUrl,
  hasExistingAnalysis,
  onAnalyze,
  onRetry,
  onSkip,
}: AnalyzePanelProps) {
  // Existing-analysis: passive confirmation. Re-analyze only fires when
  // the client edits the URL field (Wizard.tsx resets state to idle on
  // URL change after a completed analysis).
  if (hasExistingAnalysis && state === 'completed') {
    return (
      <div className={`${cardBase} bg-[#E8F8EE] border-[#25DC7F]/30`}>
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 text-[#1A9A5C] flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
          <p className="text-sm text-[#0B0B0B]">
            <strong>We&apos;ve analyzed your website.</strong> Empty fields
            below have been pre-filled with our best guesses — review and
            tweak them before continuing.
          </p>
        </div>
      </div>
    );
  }

  if (state === 'idle') {
    const canAnalyze = websiteUrl.trim().length > 0;
    return (
      <div className={`${cardBase} bg-[#F4F5F6] border-[#E6E8EA]`}>
        <p className="text-sm text-[#0B0B0B]">
          <strong>Save time:</strong> we&apos;ll read your website and
          pre-fill many of the questions below so you don&apos;t have to
          type everything from scratch.
        </p>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={!canAnalyze}
          className="px-5 py-2.5 bg-[#25DC7F] text-white rounded-lg text-sm font-semibold hover:bg-[#1DB96A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
        >
          Analyze my site
        </button>
      </div>
    );
  }

  if (state === 'analyzing') {
    return (
      <div className={`${cardBase} bg-[#FFF4E5] border-[#F5A524]/30`}>
        <div className="flex items-center gap-3">
          <svg
            className="w-5 h-5 animate-spin text-[#F5A524] flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          <p className="text-sm text-[#0B0B0B]">
            <strong>Analyzing your website…</strong> This usually takes 30-60
            seconds. Feel free to fill in the rest of step 1 while we
            work — we&apos;ll only pre-fill fields you haven&apos;t
            answered yet.
          </p>
        </div>
      </div>
    );
  }

  if (state === 'completed') {
    return (
      <div className={`${cardBase} bg-[#E8F8EE] border-[#25DC7F]/30`}>
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 text-[#1A9A5C] flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
          <p className="text-sm text-[#0B0B0B]">
            <strong>Analysis complete.</strong> Empty fields below have
            been pre-filled with suggestions. Edit any of them — your
            input always wins.
          </p>
        </div>
      </div>
    );
  }

  // failed | timed_out
  const headline =
    state === 'timed_out'
      ? "Analysis is taking longer than expected."
      : "Couldn't analyze your website.";
  const detail =
    state === 'timed_out'
      ? "You can try again, or continue filling in the form manually. Either way, your progress is saved."
      : error ?? "We hit an error while reading your site. You can try again or continue manually.";

  return (
    <div className={`${cardBase} bg-[#FEEBED] border-[#E5484D]/30`}>
      <div className="flex-1">
        <p className="text-sm font-semibold text-[#0B0B0B]">{headline}</p>
        <p className="text-xs text-[#6B6B6B] mt-1">{detail}</p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="px-4 py-2 bg-white border border-[#E6E8EA] text-[#0B0B0B] rounded-lg text-xs font-semibold hover:bg-[#F4F5F6] transition-colors whitespace-nowrap"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="px-4 py-2 bg-[#0F1A14] text-white rounded-lg text-xs font-semibold hover:bg-[#1A2A1F] transition-colors whitespace-nowrap"
        >
          Continue manually
        </button>
      </div>
    </div>
  );
}
