import { z } from 'zod';

// =============================================
// Evidence schema — every claim needs a source
// =============================================
export const evidenceSchema = z.object({
  source_url: z.string().url(),
  excerpt: z.string().max(500),
});

export type Evidence = z.infer<typeof evidenceSchema>;

// =============================================
// Site Insights — structured business data
// =============================================
export const siteInsightsSchema = z.object({
  brand_name: z.string().optional(),
  business_summary: z.string().max(1000).optional(),
  primary_services: z.array(z.object({
    name: z.string(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(evidenceSchema),
  })).default([]),
  secondary_services: z.array(z.object({
    name: z.string(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(evidenceSchema),
  })).default([]),
  primary_locations: z.array(z.object({
    name: z.string(),
    type: z.enum(['city', 'state', 'region', 'country']),
    confidence: z.number().min(0).max(1),
    evidence: z.array(evidenceSchema),
  })).default([]),
  secondary_locations: z.array(z.object({
    name: z.string(),
    type: z.enum(['city', 'state', 'region', 'country']),
    confidence: z.number().min(0).max(1),
    evidence: z.array(evidenceSchema),
  })).default([]),
  focus_themes: z.array(z.object({
    theme: z.string(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(evidenceSchema),
  })).default([]),
  contact_public: z.object({
    phone: z.string().optional(),
    email: z.string().optional(),
    address: z.string().optional(),
  }).optional(),
  social_links: z.array(z.object({
    platform: z.string(),
    url: z.string().url(),
  })).default([]),
  key_pages: z.array(z.object({
    url: z.string().url(),
    title: z.string(),
    reason: z.string(),
  })).default([]),
});

export type SiteInsights = z.infer<typeof siteInsightsSchema>;

// =============================================
// Branding — visual identity from the site
// =============================================
export const brandingSchema = z.object({
  logo_url: z.string().url().optional(),
  screenshot_url: z.string().url().optional(),
  colors: z.array(z.string()).default([]),
  fonts: z.array(z.string()).default([]),
});

export type Branding = z.infer<typeof brandingSchema>;

// =============================================
// Tech Stack — detected technologies
// =============================================
export const techStackSchema = z.object({
  cms: z.string().optional(),
  ecommerce: z.string().optional(),
  analytics: z.array(z.string()).default([]),
  hosting: z.string().optional(),
  frameworks: z.array(z.string()).default([]),
  other: z.array(z.string()).default([]),
});

export type TechStack = z.infer<typeof techStackSchema>;

// =============================================
// PageSpeed Metrics
// =============================================
export const metricsSchema = z.object({
  performance_score: z.number().min(0).max(100).optional(),
  accessibility_score: z.number().min(0).max(100).optional(),
  seo_score: z.number().min(0).max(100).optional(),
  best_practices_score: z.number().min(0).max(100).optional(),
  lcp_ms: z.number().optional(),
  fid_ms: z.number().optional(),
  cls: z.number().optional(),
});

export type Metrics = z.infer<typeof metricsSchema>;

// =============================================
// Confidence policy — hard rules
// =============================================
export const CONFIDENCE_THRESHOLDS = {
  AUTOFILL: 0.80,
  SUGGEST: 0.55,
} as const;

export type PrefillPolicy = 'autofill' | 'suggest_only' | 'no_prefill';

export function getPolicy(confidence: number): PrefillPolicy {
  if (confidence >= CONFIDENCE_THRESHOLDS.AUTOFILL) return 'autofill';
  if (confidence >= CONFIDENCE_THRESHOLDS.SUGGEST) return 'suggest_only';
  return 'no_prefill';
}

// =============================================
// Prefill Map — per field suggested values
// =============================================
export const prefillEntrySchema = z.object({
  suggested_value: z.unknown(),
  confidence: z.number().min(0).max(1),
  policy: z.enum(['autofill', 'suggest_only', 'no_prefill']),
  evidence: z.array(evidenceSchema),
});

export type PrefillEntry = z.infer<typeof prefillEntrySchema>;

export const prefillMapSchema = z.record(z.string(), prefillEntrySchema);
export type PrefillMap = z.infer<typeof prefillMapSchema>;

// =============================================
// Question Overrides — personalized copy
// =============================================
export type UIPattern = 'confirmation' | 'default';

export const questionOverrideSchema = z.object({
  label_override: z.string(),
  help_override: z.string().optional(),
  ui_pattern: z.enum(['confirmation', 'default']),
  original_label: z.string(),
});

export type QuestionOverride = z.infer<typeof questionOverrideSchema>;

export const questionOverridesSchema = z.record(z.string(), questionOverrideSchema);
export type QuestionOverrides = z.infer<typeof questionOverridesSchema>;

// =============================================
// Full Site Intelligence Record
// =============================================
export const siteIntelligenceStatusSchema = z.enum([
  'queued', 'running', 'completed', 'failed',
]);

export type SiteIntelligenceStatus = z.infer<typeof siteIntelligenceStatusSchema>;

export interface SiteIntelligenceRecord {
  id: string;
  website_url: string;
  domain: string;
  status: SiteIntelligenceStatus;
  started_at: string | null;
  completed_at: string | null;
  providers_used: {
    firecrawl: boolean;
    wappalyzer: boolean;
    builtwith: boolean;
    pagespeed: boolean;
  };
  branding: Branding | null;
  insights: SiteInsights | null;
  tech_stack: TechStack | null;
  metrics: Metrics | null;
  prefill_map: PrefillMap | null;
  question_overrides: QuestionOverrides | null;
  evidence: Evidence[];
  error: string | null;
  created_at: string;
}
