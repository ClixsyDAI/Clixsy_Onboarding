'use client';

import { useMemo } from 'react';
import { computeSops, extractSOPInputFromAnswers } from '@/lib/sopRouting/computeSops';

interface SOPRoutingSummaryProps {
  answers: Record<string, Record<string, unknown>>;
}

export default function SOPRoutingSummary({ answers }: SOPRoutingSummaryProps) {
  const result = useMemo(() => {
    const input = extractSOPInputFromAnswers(answers);
    return computeSops(input);
  }, [answers]);

  if (result.required_sops.length === 0) {
    return (
      <div className="bg-[#ECFDF5] border border-[#25DC7F]/30 rounded-lg p-4 mb-4">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-sm text-[#065F46] font-medium">
            Great news! Based on your answers, no additional setup steps are needed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <h3 className="text-sm font-semibold text-blue-900 mb-2 flex items-center gap-2">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        Based on your answers, we&apos;ll include these additional steps:
      </h3>
      <ul className="space-y-1.5">
        {result.required_sops.map((sop, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-blue-800">
            <span className="w-1.5 h-1.5 mt-1.5 bg-blue-400 rounded-full flex-shrink-0" />
            {sop}
          </li>
        ))}
      </ul>
      <p className="text-xs text-blue-600 mt-3">
        Don&apos;t worry — our team will handle these for you as part of the onboarding process.
      </p>
    </div>
  );
}
