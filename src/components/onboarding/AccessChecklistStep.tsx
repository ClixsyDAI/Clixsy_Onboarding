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
  statusOptions: { value: string; label: string }[];
}[] = (() => {
  // Filter out LSA (deferred in v2), build from ACCESS_ITEMS
  const items = ACCESS_ITEMS.filter(item => item.key !== 'lsa');
  return items.map(item => {
    const statusField = `${item.key === 'domain' ? 'domain' : item.key}_access_status`;
    return {
      accessKey: item.key,
      statusField,
      label: item.label,
      whatWeNeed: item.whatWeNeed,
      statusOptions: item.key === 'youtube' ? YOUTUBE_STATUS_OPTIONS : ACCESS_STATUS_OPTIONS,
    };
  });
})();

export default function AccessChecklistStep({ values, errors, onChange }: AccessChecklistStepProps) {
  const [expandedVideo, setExpandedVideo] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Checklist table / cards */}
      <div className="border border-[var(--border2)] rounded-xl overflow-hidden">
        {/* Desktop table header */}
        <div className="hidden md:grid grid-cols-[1fr_1.5fr_200px] bg-[var(--bg)] px-4 py-3 text-sm font-semibold text-[var(--muted)]">
          <span>Service</span>
          <span>What We Need</span>
          <span>Status</span>
        </div>

        {/* Rows */}
        <div className="divide-y divide-[var(--border2)]">
          {CHECKLIST_ROWS.map(row => {
            const currentStatus = (values[row.statusField] as string) || '';

            const tutorial = TUTORIAL_VIDEOS[row.accessKey];
            const isVideoExpanded = expandedVideo === row.accessKey;
            const embedUrl = tutorial ? youTubeEmbedUrl(tutorial.url) : null;

            return (
              <div key={row.accessKey}>
                {/* Desktop row */}
                <div className="hidden md:grid grid-cols-[1fr_1.5fr_200px] items-center px-4 py-3 gap-4">
                  <div>
                    <div className="font-medium text-[var(--text)] text-sm">
                      {row.label}
                    </div>
                    {tutorial && (
                      <button
                        type="button"
                        onClick={() => setExpandedVideo(isVideoExpanded ? null : row.accessKey)}
                        className="inline-flex items-center gap-1.5 mt-1 text-xs text-[var(--green)] hover:text-[var(--green)] font-medium transition-colors"
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
                        </svg>
                        {isVideoExpanded ? 'Hide tutorial' : 'Watch tutorial'}
                      </button>
                    )}
                  </div>
                  <div className="text-sm text-[var(--muted)]">
                    {row.whatWeNeed}
                  </div>
                  <div>
                    <select
                      value={currentStatus}
                      onChange={e => onChange(row.statusField, e.target.value)}
                      className={`w-full px-3 py-2 rounded-lg border text-sm transition-colors ${
                        currentStatus === 'done'
                          ? 'border-[var(--green)] bg-[var(--green-fill)]/5 text-[var(--text)]'
                          : currentStatus === 'need_help'
                          ? 'border-[var(--amber)] bg-[var(--amber)]/5 text-[var(--text)]'
                          : 'border-[var(--border2)] bg-[var(--card)] text-[var(--text)]'
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
                      <svg className="w-5 h-5 text-[var(--red)]" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
                      </svg>
                      <span className="text-sm font-semibold text-[var(--text)]">{tutorial.title}</span>
                    </div>
                    <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-[var(--border2)] bg-black max-w-2xl">
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
                  <div className="font-medium text-[var(--text)] text-sm">
                    {row.label}
                  </div>
                  <div className="text-xs text-[var(--muted)]">
                    {row.whatWeNeed}
                  </div>
                  {tutorial && (
                    <button
                      type="button"
                      onClick={() => setExpandedVideo(isVideoExpanded ? null : row.accessKey)}
                      className="inline-flex items-center gap-1.5 text-xs text-[var(--green)] hover:text-[var(--green)] font-medium transition-colors"
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
                      <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-[var(--border2)] bg-black">
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
                        ? 'border-[var(--green)] bg-[var(--green-fill)]/5 text-[var(--text)]'
                        : currentStatus === 'need_help'
                        ? 'border-[var(--amber)] bg-[var(--amber)]/5 text-[var(--text)]'
                        : 'border-[var(--border2)] bg-[var(--card)] text-[var(--text)]'
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
                    <p className="text-xs text-[var(--red)]">{errors[row.statusField]}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-[var(--faint)] text-center">
        You can come back and update these statuses at any time before submitting.
      </p>
    </div>
  );
}
