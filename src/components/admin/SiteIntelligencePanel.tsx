'use client';

import { useState, useEffect, useCallback } from 'react';

interface SiteIntelligenceData {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  website_url: string;
  domain: string;
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
    secondary_services?: { name: string; confidence: number }[];
    primary_locations?: { name: string; type: string; confidence: number }[];
    secondary_locations?: { name: string; type: string; confidence: number }[];
    contact_public?: { phone?: string; email?: string; address?: string };
    social_links?: { platform: string; url: string }[];
    key_pages?: { url: string; title: string; reason: string }[];
  };
  tech_stack?: {
    cms?: string;
    ecommerce?: string;
    analytics?: string[];
    hosting?: string;
    frameworks?: string[];
  };
  metrics?: {
    performance_score?: number;
    accessibility_score?: number;
    seo_score?: number;
  };
  prefill_count: number;
  autofill_count: number;
  suggest_count: number;
  error?: string;
}

interface SiteIntelligencePanelProps {
  websiteUrl: string;
  sessionId?: string;
  onAnalysisComplete?: (recordId: string) => void;
}

export default function SiteIntelligencePanel({
  websiteUrl,
  sessionId,
  onAnalysisComplete,
}: SiteIntelligencePanelProps) {
  const [data, setData] = useState<SiteIntelligenceData | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll for status when analyzing
  const pollStatus = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/admin/site-intelligence/status?id=${id}`);
      if (!res.ok) throw new Error('Failed to fetch status');
      const result = await res.json();
      setData(result);

      if (result.status === 'completed') {
        setIsAnalyzing(false);
        onAnalysisComplete?.(id);
      } else if (result.status === 'failed') {
        setIsAnalyzing(false);
        setError(result.error || 'Analysis failed');
      }

      return result.status;
    } catch (err) {
      console.error('Poll error:', err);
      return null;
    }
  }, [onAnalysisComplete]);

  useEffect(() => {
    if (!isAnalyzing || !recordId) return;

    const interval = setInterval(async () => {
      const status = await pollStatus(recordId);
      if (status === 'completed' || status === 'failed') {
        clearInterval(interval);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [isAnalyzing, recordId, pollStatus]);

  const startAnalysis = async () => {
    setIsAnalyzing(true);
    setError(null);
    setData(null);

    try {
      const res = await fetch('/api/admin/site-intelligence/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteUrl, sessionId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to start analysis');
      }

      const result = await res.json();
      setRecordId(result.recordId);

      // Start polling immediately
      await pollStatus(result.recordId);
    } catch (err) {
      setIsAnalyzing(false);
      setError(err instanceof Error ? err.message : 'Failed to start analysis');
    }
  };

  // Not started yet
  if (!data && !isAnalyzing && !error) {
    return (
      <div className="border border-dashed border-[#E6E8EA] rounded-lg p-6 text-center">
        <div className="w-12 h-12 mx-auto mb-3 bg-[#25DC7F]/10 rounded-full flex items-center justify-center">
          <svg className="w-6 h-6 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <h3 className="text-sm font-semibold text-[#0B0B0B] mb-1">Website Intelligence</h3>
        <p className="text-xs text-[#6B6B6B] mb-4">
          Analyze the client&apos;s website to pre-fill onboarding fields and personalize questions.
        </p>
        <button
          onClick={startAnalysis}
          disabled={!websiteUrl}
          className="px-4 py-2 bg-[#25DC7F] text-white rounded-lg text-sm font-semibold hover:bg-[#1DB96A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Analyze Website
        </button>
      </div>
    );
  }

  // Loading state
  if (isAnalyzing && (!data || data.status === 'queued' || data.status === 'running')) {
    return (
      <div className="border border-[#E6E8EA] rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 bg-[#25DC7F]/10 rounded-full flex items-center justify-center">
            <svg className="w-4 h-4 text-[#25DC7F] animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#0B0B0B]">Analyzing Website...</h3>
            <p className="text-xs text-[#6B6B6B]">
              {data?.status === 'running' ? 'Crawling and extracting data...' : 'Starting analysis...'}
            </p>
          </div>
        </div>
        <div className="h-2 bg-[#F4F5F6] rounded-full overflow-hidden">
          <div className="h-full bg-[#25DC7F] rounded-full animate-pulse" style={{ width: data?.status === 'running' ? '60%' : '20%' }} />
        </div>
      </div>
    );
  }

  // Error state
  if (error || data?.status === 'failed') {
    return (
      <div className="border border-red-200 bg-red-50 rounded-lg p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center">
            <svg className="w-4 h-4 text-[#E5484D]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#0B0B0B]">Analysis Failed</h3>
            <p className="text-xs text-[#E5484D]">{error || data?.error}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={startAnalysis}
            className="px-3 py-1.5 bg-[#25DC7F] text-white rounded text-xs font-semibold hover:bg-[#1DB96A]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Completed — show preview
  if (!data) return null;

  const { branding, insights, tech_stack, metrics, autofill_count, suggest_count } = data;

  return (
    <div className="border border-[#25DC7F]/30 bg-[#25DC7F]/5 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-[#25DC7F]/10 border-b border-[#25DC7F]/20 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[#25DC7F] rounded-full flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#0B0B0B]">Website Analysis Complete</h3>
            <p className="text-xs text-[#6B6B6B]">{data.domain}</p>
          </div>
        </div>
        <button
          onClick={startAnalysis}
          className="px-3 py-1.5 border border-[#E6E8EA] bg-white rounded text-xs font-medium hover:bg-[#F4F5F6]"
        >
          Re-analyze
        </button>
      </div>

      <div className="p-6 space-y-5">
        {/* Screenshot */}
        {branding?.screenshot_url && (
          <div>
            <h4 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Website Screenshot</h4>
            <div className="rounded-lg overflow-hidden border border-[#E6E8EA] shadow-sm">
              <img
                src={branding.screenshot_url}
                alt={`Screenshot of ${data.domain}`}
                className="w-full h-auto"
              />
            </div>
          </div>
        )}

        {/* Brand Info. Stage 12 / Fix 2: stack to 1-col on mobile so the
            brand name and color chip rows each get the full card width.
            Color chips also get flex-wrap so the 5-chip row doesn't
            push the panel off-screen on narrow viewports. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {insights?.brand_name && (
            <div>
              <h4 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-1">Brand Name</h4>
              <p className="text-sm text-[#0B0B0B] font-medium break-words">{insights.brand_name}</p>
            </div>
          )}

          {branding?.colors && branding.colors.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-1">Brand Colors</h4>
              <div className="flex flex-wrap gap-2">
                {branding.colors.slice(0, 5).map((color, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <div className="w-5 h-5 rounded-full border border-[#E6E8EA]" style={{ backgroundColor: color }} />
                    <span className="text-xs text-[#6B6B6B]">{color}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Business Summary */}
        {insights?.business_summary && (
          <div>
            <h4 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-1">What We Learned</h4>
            <p className="text-sm text-[#0B0B0B]">{insights.business_summary}</p>
          </div>
        )}

        {/* Services */}
        {insights?.primary_services && insights.primary_services.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Top Services</h4>
            <div className="flex flex-wrap gap-2">
              {insights.primary_services.slice(0, 8).map((svc, i) => (
                <span
                  key={i}
                  className="inline-flex items-center px-2.5 py-1 bg-white border border-[#E6E8EA] rounded-full text-xs text-[#0B0B0B]"
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
            <h4 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Primary Market</h4>
            <div className="flex flex-wrap gap-2">
              {insights.primary_locations.map((loc, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-[#E6E8EA] rounded-full text-xs text-[#0B0B0B]"
                >
                  <svg className="w-3 h-3 text-[#6B6B6B]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  {loc.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Tech Stack */}
        {tech_stack && (tech_stack.cms || tech_stack.analytics?.length) && (
          <div>
            <h4 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Tech Stack</h4>
            <div className="flex flex-wrap gap-2">
              {tech_stack.cms && (
                <span className="inline-flex items-center px-2.5 py-1 bg-blue-50 border border-blue-200 rounded-full text-xs text-blue-700">
                  CMS: {tech_stack.cms}
                </span>
              )}
              {tech_stack.ecommerce && (
                <span className="inline-flex items-center px-2.5 py-1 bg-purple-50 border border-purple-200 rounded-full text-xs text-purple-700">
                  E-commerce: {tech_stack.ecommerce}
                </span>
              )}
              {tech_stack.analytics?.map((a, i) => (
                <span key={i} className="inline-flex items-center px-2.5 py-1 bg-orange-50 border border-orange-200 rounded-full text-xs text-orange-700">
                  {a}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Metrics. Stage 12 / Fix 2: 3-col grid was clipping "Performance"
            and "Accessibility" labels on Android (~360px) — each box ended
            up ~65-70px wide after p-3 padding, well below the ~110px the
            text-xs label needed. Kept the 3-col layout (operator's option
            b) but tightened mobile sizing: smaller padding, smaller font,
            and leading-tight + break-words so long labels can wrap to 2
            lines rather than overflow. Score numbers shrink one step on
            mobile too so the box stays compact. min-w-0 lets the grid
            children shrink below their intrinsic width. */}
        {metrics && (metrics.performance_score !== undefined || metrics.seo_score !== undefined) && (
          <div>
            <h4 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Quick Technical Snapshot</h4>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {metrics.performance_score !== undefined && (
                <div className="text-center min-w-0 p-2 sm:p-3 bg-white rounded-lg border border-[#E6E8EA]">
                  <div className={`text-lg sm:text-xl font-bold ${metrics.performance_score >= 70 ? 'text-[#25DC7F]' : metrics.performance_score >= 50 ? 'text-[#F5A524]' : 'text-[#E5484D]'}`}>
                    {metrics.performance_score}
                  </div>
                  <div className="text-[11px] sm:text-xs leading-tight break-words text-[#6B6B6B]">Performance</div>
                </div>
              )}
              {metrics.accessibility_score !== undefined && (
                <div className="text-center min-w-0 p-2 sm:p-3 bg-white rounded-lg border border-[#E6E8EA]">
                  <div className={`text-lg sm:text-xl font-bold ${metrics.accessibility_score >= 70 ? 'text-[#25DC7F]' : 'text-[#F5A524]'}`}>
                    {metrics.accessibility_score}
                  </div>
                  <div className="text-[11px] sm:text-xs leading-tight break-words text-[#6B6B6B]">Accessibility</div>
                </div>
              )}
              {metrics.seo_score !== undefined && (
                <div className="text-center min-w-0 p-2 sm:p-3 bg-white rounded-lg border border-[#E6E8EA]">
                  <div className={`text-lg sm:text-xl font-bold ${metrics.seo_score >= 70 ? 'text-[#25DC7F]' : 'text-[#F5A524]'}`}>
                    {metrics.seo_score}
                  </div>
                  <div className="text-[11px] sm:text-xs leading-tight break-words text-[#6B6B6B]">SEO</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Prefill Summary */}
        <div className="bg-white rounded-lg border border-[#E6E8EA] p-4">
          <h4 className="text-xs font-semibold text-[#6B6B6B] uppercase mb-2">Pre-fill Summary</h4>
          <div className="flex items-center gap-4 text-sm">
            <div>
              <span className="font-bold text-[#25DC7F]">{autofill_count}</span>
              <span className="text-[#6B6B6B] ml-1">fields will auto-fill</span>
            </div>
            <div>
              <span className="font-bold text-[#F5A524]">{suggest_count}</span>
              <span className="text-[#6B6B6B] ml-1">fields will suggest</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
