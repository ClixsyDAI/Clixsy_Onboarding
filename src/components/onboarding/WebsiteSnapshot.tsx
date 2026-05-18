'use client';

import { useState } from 'react';

// S1.1: defensive cleanup of any markdown image / link / raw-URL noise in
// the scraped business_summary BEFORE we render it. The pipeline now
// sanitises on the way in too, but historical scrapes pre-Stage-6 may
// still hold raw `![](https://static.wixstatic.com/…)` strings, and the
// LLM has been observed echoing markdown back even after prompt
// engineering. Keep this as a last-line backstop. Returns null if
// nothing meaningful is left after cleaning.
function cleanBusinessSummary(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // If cleaning leaves us with too little real prose, treat it as no summary.
  return cleaned.replace(/\s/g, '').length >= 30 ? cleaned : null;
}

// Compose a fallback prose summary from the structured insights when
// business_summary itself is missing or got cleaned away. We prefer the
// pipeline's own summary, but a tidy "Personal Injury & Car Accidents
// firm serving Houston, TX" is much better than an empty panel.
function buildFallbackSummary(insights: WebsiteSnapshotProps['insights']): string | null {
  if (!insights) return null;
  const brand = insights.brand_name?.trim();
  const serviceNames = (insights.primary_services ?? [])
    .slice(0, 3)
    .map((s) => s.name.trim())
    .filter(Boolean);
  const locationNames = (insights.primary_locations ?? [])
    .slice(0, 2)
    .map((l) => l.name.trim())
    .filter(Boolean);
  if (!brand && serviceNames.length === 0 && locationNames.length === 0) return null;

  const parts: string[] = [];
  if (brand && serviceNames.length > 0) {
    parts.push(`${brand} focuses on ${joinWithAnd(serviceNames)}`);
  } else if (brand) {
    parts.push(brand);
  } else if (serviceNames.length > 0) {
    parts.push(`Focused on ${joinWithAnd(serviceNames)}`);
  }
  if (locationNames.length > 0) {
    parts.push(`serving ${joinWithAnd(locationNames)}`);
  }
  return parts.join(' ') + '.';
}

function joinWithAnd(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

interface WebsiteSnapshotProps {
  branding?: {
    screenshot_url?: string;
    logo_url?: string;
    colors?: string[];
    fonts?: string[];
  };
  insights?: {
    brand_name?: string;
    business_summary?: string;
    primary_services?: { name: string; confidence: number }[];
    primary_locations?: { name: string; type: string; confidence: number }[];
    key_pages?: { url: string; title: string; reason: string }[];
  };
  techStack?: {
    cms?: string;
    ecommerce?: string;
    analytics?: string[];
  };
  onDismiss: () => void;
}

export default function WebsiteSnapshot({ branding, insights, techStack, onDismiss }: WebsiteSnapshotProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  // S1.1: sanitise summary BEFORE deciding whether the panel has data.
  // A raw markdown-image string should NOT count as "we have a summary".
  const cleanedSummary = cleanBusinessSummary(insights?.business_summary);
  const fallbackSummary = cleanedSummary ? null : buildFallbackSummary(insights);
  const summaryToShow = cleanedSummary ?? fallbackSummary;

  const hasData =
    summaryToShow || insights?.primary_services?.length || insights?.primary_locations?.length;
  if (!hasData && !branding?.screenshot_url) return null;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-[#E6E8EA] mb-6 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-gradient-to-r from-[#0F1A14] to-[#1A2A1F] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[#25DC7F]/20 rounded-full flex items-center justify-center">
            <svg className="w-4 h-4 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <div>
            <h2 className="text-white font-semibold text-sm">We did our homework</h2>
            <p className="text-[#569077] text-xs">Here&apos;s what we found on your website</p>
          </div>
        </div>
        <button
          onClick={() => { setDismissed(true); onDismiss(); }}
          className="text-[#569077] hover:text-white text-xs font-medium transition-colors"
        >
          Dismiss
        </button>
      </div>

      <div className="p-6 space-y-5">
        {/* Screenshot + Brand Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {branding?.screenshot_url && (
            <div>
              <div className="rounded-lg overflow-hidden border border-[#E6E8EA] shadow-sm">
                <img
                  src={branding.screenshot_url}
                  alt="Website screenshot"
                  className="w-full h-auto"
                />
              </div>
            </div>
          )}

          <div className="space-y-4">
            {/* Summary — sanitised pipeline string or built from insights */}
            {summaryToShow && (
              <div>
                <h3 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-1">What we found</h3>
                <p className="text-sm text-[#0B0B0B] leading-relaxed">{summaryToShow}</p>
              </div>
            )}

            {/* Services */}
            {insights?.primary_services && insights.primary_services.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Top services we noticed</h3>
                <div className="flex flex-wrap gap-1.5">
                  {insights.primary_services.slice(0, 6).map((svc, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center px-2.5 py-1 bg-[#25DC7F]/10 border border-[#25DC7F]/20 rounded-full text-xs text-[#0B0B0B] font-medium"
                    >
                      {svc.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Locations */}
            {insights?.primary_locations && insights.primary_locations.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Primary market</h3>
                <div className="flex flex-wrap gap-1.5">
                  {insights.primary_locations.map((loc, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 border border-blue-100 rounded-full text-xs text-blue-700 font-medium"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      </svg>
                      {loc.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Tech + Key Pages row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Tech Stack */}
          {techStack && (techStack.cms || techStack.analytics?.length) && (
            <div>
              <h3 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Your site setup</h3>
              <div className="flex flex-wrap gap-1.5">
                {techStack.cms && (
                  <span className="inline-flex items-center px-2.5 py-1 bg-purple-50 border border-purple-100 rounded-full text-xs text-purple-700">
                    {techStack.cms}
                  </span>
                )}
                {techStack.ecommerce && (
                  <span className="inline-flex items-center px-2.5 py-1 bg-orange-50 border border-orange-100 rounded-full text-xs text-orange-700">
                    {techStack.ecommerce}
                  </span>
                )}
                {techStack.analytics?.map((a, i) => (
                  <span key={i} className="inline-flex items-center px-2.5 py-1 bg-gray-50 border border-gray-200 rounded-full text-xs text-gray-600">
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Key Pages */}
          {insights?.key_pages && insights.key_pages.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Key pages we reviewed</h3>
              <div className="space-y-1">
                {insights.key_pages.slice(0, 5).map((page, i) => (
                  <a
                    key={i}
                    href={page.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-[#25DC7F] hover:text-[#1DB96A] font-medium"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    {page.title}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Brand Colors */}
        {branding?.colors && branding.colors.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Detected brand colors</h3>
            <div className="flex gap-3">
              {branding.colors.slice(0, 5).map((color, i) => (
                <div key={i} className="flex flex-col items-center gap-1">
                  <div className="w-8 h-8 rounded-lg border border-[#E6E8EA] shadow-sm" style={{ backgroundColor: color }} />
                  <span className="text-[10px] text-[#6B6B6B]">{color}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Disclaimer */}
        <p className="text-[10px] text-[#A0A0A0] text-center pt-2 border-t border-[#E6E8EA]">
          Based on publicly available pages. Please confirm or correct anything that looks off as you go through the onboarding.
        </p>
      </div>
    </div>
  );
}
