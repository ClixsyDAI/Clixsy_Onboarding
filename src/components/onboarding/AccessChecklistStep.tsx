'use client';

import { useState } from 'react';
import { ACCESS_ITEMS } from '@/lib/onboarding/accessChecklist';
import { youTubeEmbedUrl } from '@/lib/onboarding/youtube';

interface AccessChecklistStepProps {
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (name: string, value: unknown) => void;
}

// Exported (Sprint 2 / #3): the WelcomeAccessWizard's status dropdowns
// must mirror these values exactly — same const, no drift possible.
export const ACCESS_STATUS_OPTIONS = [
  { value: 'done', label: 'Done — access granted' },
  { value: 'later', label: "I'll do this later" },
  { value: 'need_help', label: 'I need help' },
  { value: 'not_applicable', label: 'Not applicable' },
];

const YOUTUBE_STATUS_OPTIONS = [
  { value: 'done', label: 'Done — access granted' },
  { value: 'later', label: "I'll do this later" },
  { value: 'need_help', label: 'I need help' },
];

// Tutorial videos for each access service (from v1 steps 20-25)
// Exported (Sprint 2 / #3): reused by the WelcomeAccessWizard so the
// urgent-access rows embed the same production tutorials as this step.
export const TUTORIAL_VIDEOS: Record<string, { url: string; title: string }> = {
  ga: {
    url: 'https://youtu.be/8nWZRo_l8bs',
    title: 'Tutorial - How to add admin user to Google Analytics',
  },
  gsc: {
    url: 'https://youtu.be/17KmgnPz-K4',
    title: 'Tutorial - How to add admin user to Google Search Console',
  },
  gbp: {
    url: 'https://youtu.be/0Vb6v8YA3AY?si=PD9PU-VYRP-n1yLz',
    title: 'Tutorial - How to add admin user to Google Business Profile',
  },
  wordpress: {
    url: 'https://youtu.be/pxB2YB1578Q',
    title: 'Tutorial - How to grant admin access to WordPress',
  },
  domain: {
    url: 'https://youtu.be/ProhJAnO9ms',
    title: 'Tutorial - How to delegate access to Domain Registrar',
  },
  dns: {
    url: 'https://youtu.be/s7AS0XYR0KI',
    title: 'Tutorial - How to delegate access to Cloudflare',
  },
};


// Map access keys to v2 field keys and display config
const CHECKLIST_ROWS: {
  accessKey: string;
  statusField: string;
  label: string;
  whatWeNeed: string;
  gatedBy?: { field: string; value: string };
  statusOptions: { value: string; label: string }[];
}[] = (() => {
  // Filter out LSA (deferred in v2), build from ACCESS_ITEMS
  const items = ACCESS_ITEMS.filter(item => item.key !== 'lsa');
  return items.map(item => {
    const statusField = `${item.key === 'domain' ? 'domain' : item.key}_access_status`;
    let gatedBy: { field: string; value: string } | undefined;
    if (item.key === 'ga') gatedBy = { field: 'has_google_analytics', value: 'yes' };
    if (item.key === 'youtube') gatedBy = { field: 'has_youtube', value: 'yes' };
    return {
      accessKey: item.key,
      statusField,
      label: item.label,
      whatWeNeed: item.whatWeNeed,
      gatedBy,
      statusOptions: item.key === 'youtube' ? YOUTUBE_STATUS_OPTIONS : ACCESS_STATUS_OPTIONS,
    };
  });
})();

export default function AccessChecklistStep({ values, errors, onChange }: AccessChecklistStepProps) {
  const hasGA = values.has_google_analytics as string;
  const hasYT = values.has_youtube as string;
  const [expandedVideo, setExpandedVideo] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Gating questions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Google Analytics gate */}
        <div>
          <label className="block text-sm font-medium text-[#0B0B0B] mb-2">
            Do you have Google Analytics set up?
          </label>
          <div className="flex gap-3">
            {[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
              { value: 'not_sure', label: 'Not sure' },
            ].map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange('has_google_analytics', opt.value)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  hasGA === opt.value
                    ? 'bg-[#25DC7F]/10 border-[#25DC7F] text-[#0B0B0B]'
                    : 'border-[#E6E8EA] text-[#6B6B6B] hover:bg-[#F4F5F6]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {errors.has_google_analytics && (
            <p className="mt-1 text-sm text-[#E5484D]">{errors.has_google_analytics}</p>
          )}
        </div>

        {/* YouTube gate */}
        <div>
          <label className="block text-sm font-medium text-[#0B0B0B] mb-2">
            Do you have a YouTube channel?
          </label>
          <div className="flex gap-3">
            {[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ].map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange('has_youtube', opt.value)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  hasYT === opt.value
                    ? 'bg-[#25DC7F]/10 border-[#25DC7F] text-[#0B0B0B]'
                    : 'border-[#E6E8EA] text-[#6B6B6B] hover:bg-[#F4F5F6]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {errors.has_youtube && (
            <p className="mt-1 text-sm text-[#E5484D]">{errors.has_youtube}</p>
          )}
        </div>
      </div>

      {/* Checklist table / cards */}
      <div className="border border-[#E6E8EA] rounded-xl overflow-hidden">
        {/* Desktop table header */}
        <div className="hidden md:grid grid-cols-[1fr_1.5fr_200px] bg-[#F4F5F6] px-4 py-3 text-sm font-semibold text-[#6B6B6B]">
          <span>Service</span>
          <span>What We Need</span>
          <span>Status</span>
        </div>

        {/* Rows */}
        <div className="divide-y divide-[#E6E8EA]">
          {CHECKLIST_ROWS.map(row => {
            // Check gating
            if (row.gatedBy) {
              const gateValue = values[row.gatedBy.field] as string;
              if (gateValue !== row.gatedBy.value) return null;
            }

            const currentStatus = (values[row.statusField] as string) || '';

            const tutorial = TUTORIAL_VIDEOS[row.accessKey];
            const isVideoExpanded = expandedVideo === row.accessKey;
            const embedUrl = tutorial ? youTubeEmbedUrl(tutorial.url) : null;

            return (
              <div key={row.accessKey}>
                {/* Desktop row */}
                <div className="hidden md:grid grid-cols-[1fr_1.5fr_200px] items-center px-4 py-3 gap-4">
                  <div>
                    <div className="font-medium text-[#0B0B0B] text-sm">
                      {row.label}
                    </div>
                    {tutorial && (
                      <button
                        type="button"
                        onClick={() => setExpandedVideo(isVideoExpanded ? null : row.accessKey)}
                        className="inline-flex items-center gap-1.5 mt-1 text-xs text-[#25DC7F] hover:text-[#1eb86a] font-medium transition-colors"
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
                        </svg>
                        {isVideoExpanded ? 'Hide tutorial' : 'Watch tutorial'}
                      </button>
                    )}
                  </div>
                  <div className="text-sm text-[#6B6B6B]">
                    {row.whatWeNeed}
                  </div>
                  <div>
                    <select
                      value={currentStatus}
                      onChange={e => onChange(row.statusField, e.target.value)}
                      className={`w-full px-3 py-2 rounded-lg border text-sm transition-colors ${
                        currentStatus === 'done'
                          ? 'border-[#25DC7F] bg-[#25DC7F]/5 text-[#0B0B0B]'
                          : currentStatus === 'need_help'
                          ? 'border-[#F5A524] bg-[#F5A524]/5 text-[#0B0B0B]'
                          : 'border-[#E6E8EA] bg-white text-[#0B0B0B]'
                      }`}
                    >
                      <option value="">Select status...</option>
                      {row.statusOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Expanded video (desktop) */}
                {isVideoExpanded && embedUrl && (
                  <div className="hidden md:block px-4 pb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <svg className="w-5 h-5 text-[#E5484D]" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
                      </svg>
                      <span className="text-sm font-semibold text-[#0B0B0B]">{tutorial.title}</span>
                    </div>
                    <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-[#E6E8EA] bg-black max-w-2xl">
                      <iframe
                        src={embedUrl}
                        title={tutorial.title}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                        className="absolute inset-0 w-full h-full"
                      />
                    </div>
                  </div>
                )}

                {/* Mobile card */}
                <div className="md:hidden p-4 space-y-2">
                  <div className="font-medium text-[#0B0B0B] text-sm">
                    {row.label}
                  </div>
                  <div className="text-xs text-[#6B6B6B]">
                    {row.whatWeNeed}
                  </div>
                  {tutorial && (
                    <button
                      type="button"
                      onClick={() => setExpandedVideo(isVideoExpanded ? null : row.accessKey)}
                      className="inline-flex items-center gap-1.5 text-xs text-[#25DC7F] hover:text-[#1eb86a] font-medium transition-colors"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
                      </svg>
                      {isVideoExpanded ? 'Hide tutorial' : 'Watch tutorial'}
                    </button>
                  )}
                  {/* Expanded video (mobile) */}
                  {isVideoExpanded && embedUrl && (
                    <div className="pt-1">
                      <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-[#E6E8EA] bg-black">
                        <iframe
                          src={embedUrl}
                          title={tutorial.title}
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                          className="absolute inset-0 w-full h-full"
                        />
                      </div>
                    </div>
                  )}
                  <select
                    value={currentStatus}
                    onChange={e => onChange(row.statusField, e.target.value)}
                    className={`w-full px-3 py-2 rounded-lg border text-sm transition-colors ${
                      currentStatus === 'done'
                        ? 'border-[#25DC7F] bg-[#25DC7F]/5 text-[#0B0B0B]'
                        : currentStatus === 'need_help'
                        ? 'border-[#F5A524] bg-[#F5A524]/5 text-[#0B0B0B]'
                        : 'border-[#E6E8EA] bg-white text-[#0B0B0B]'
                    }`}
                  >
                    <option value="">Select status...</option>
                    {row.statusOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {errors[row.statusField] && (
                    <p className="text-xs text-[#E5484D]">{errors[row.statusField]}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-[#A0A0A0] text-center">
        You can come back and update these statuses at any time before submitting.
      </p>
    </div>
  );
}
