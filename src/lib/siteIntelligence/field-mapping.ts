import type { SiteInsights, TechStack, Branding, PrefillMap, PrefillEntry, Evidence } from './schemas';
import { getPolicy } from './schemas';
import { detectCallTrackingProvider } from './question-overrides';

// =============================================
// Field Mapping: insight slots -> onboarding field keys
// =============================================

interface MappingRule {
  field_key: string;
  step_key: string;
  extract: (insights: SiteInsights, techStack?: TechStack | null, branding?: Branding | null) => {
    value: unknown;
    confidence: number;
    evidence: Evidence[];
  } | null;
}

const MAPPING_RULES: MappingRule[] = [
  // Business Overview fields
  {
    field_key: 'business_name',
    step_key: 'business_overview',
    extract: (insights) => {
      if (!insights.brand_name) return null;
      return {
        value: insights.brand_name,
        confidence: 0.85,
        evidence: insights.primary_services[0]?.evidence || [{ source_url: '', excerpt: 'Extracted from website title/content' }],
      };
    },
  },
  {
    field_key: 'business_phone',
    step_key: 'business_overview',
    extract: (insights) => {
      if (!insights.contact_public?.phone) return null;
      return {
        value: insights.contact_public.phone,
        confidence: 0.90,
        evidence: [{ source_url: '', excerpt: 'Phone number found on website' }],
      };
    },
  },
  {
    field_key: 'physical_address',
    step_key: 'business_overview',
    extract: (insights) => {
      if (!insights.contact_public?.address) return null;
      return {
        value: insights.contact_public.address,
        confidence: 0.80,
        evidence: [{ source_url: '', excerpt: 'Address found on website' }],
      };
    },
  },

  // SEO & Targeting fields
  {
    field_key: 'main_geographical_areas',
    step_key: 'seo_targeting',
    extract: (insights) => {
      const allLocations = [...insights.primary_locations, ...insights.secondary_locations];
      if (allLocations.length === 0) return null;
      const names = allLocations.map(l => l.name);
      const avgConfidence = allLocations.reduce((sum, l) => sum + l.confidence, 0) / allLocations.length;
      return {
        value: names.join(', '),
        confidence: avgConfidence,
        evidence: allLocations.flatMap(l => l.evidence).slice(0, 3),
      };
    },
  },
  {
    field_key: 'primary_case_types_keywords',
    step_key: 'seo_targeting',
    extract: (insights) => {
      const allServices = [...insights.primary_services, ...insights.secondary_services];
      if (allServices.length === 0) return null;
      const names = allServices.map(s => s.name);
      const avgConfidence = allServices.reduce((sum, s) => sum + s.confidence, 0) / allServices.length;
      return {
        value: names.join(', '),
        confidence: avgConfidence,
        evidence: allServices.flatMap(s => s.evidence).slice(0, 3),
      };
    },
  },
  {
    field_key: 'case_priority',
    step_key: 'seo_targeting',
    extract: (insights) => {
      if (insights.primary_services.length === 0) return null;
      const top = insights.primary_services[0];
      return {
        value: top.name,
        confidence: top.confidence * 0.9, // slightly lower — we're guessing priority
        evidence: top.evidence,
      };
    },
  },

  // Technical Setup fields
  {
    field_key: 'website_platform',
    step_key: 'technical_setup',
    extract: (_insights, techStack) => {
      if (!techStack?.cms) return null;
      // Map detected CMS to field option values
      const cmsMap: Record<string, string> = {
        'wordpress': 'wordpress',
        'squarespace': 'squarespace',
        'wix': 'wix',
        'webflow': 'webflow',
      };
      const key = techStack.cms.toLowerCase();
      const mapped = Object.entries(cmsMap).find(([k]) => key.includes(k));
      return {
        value: mapped ? mapped[1] : 'custom',
        confidence: 0.90,
        evidence: [{ source_url: '', excerpt: `Detected CMS: ${techStack.cms}` }],
      };
    },
  },

  // Brand & Design fields. Confidence + evidence are pulled from the
  // parallel branding.color_sources / branding.font_sources arrays
  // (populated by the deterministic extractor in Stage 5) when present;
  // otherwise we fall back to the legacy 0.85 / 0.80 defaults so older
  // snapshots and LLM-only sites continue to round-trip unchanged.
  {
    field_key: 'primary_color',
    step_key: 'brand_design',
    extract: (_insights, _techStack, branding) => {
      if (!branding?.colors?.[0]) return null;
      const src = branding.color_sources?.[0];
      const sourceLabel =
        src?.source === 'theme-color'
          ? 'theme-color meta tag'
          : src?.source === 'css'
            ? 'CSS frequency analysis'
            : 'LLM extraction';
      return {
        value: branding.colors[0],
        confidence: src?.confidence ?? 0.85,
        evidence: [{ source_url: '', excerpt: `Primary color via ${sourceLabel}` }],
      };
    },
  },
  {
    field_key: 'secondary_color',
    step_key: 'brand_design',
    extract: (_insights, _techStack, branding) => {
      if (!branding?.colors?.[1]) return null;
      const src = branding.color_sources?.[1];
      const sourceLabel =
        src?.source === 'theme-color'
          ? 'theme-color meta tag'
          : src?.source === 'css'
            ? 'CSS frequency analysis'
            : 'LLM extraction';
      return {
        value: branding.colors[1],
        confidence: src?.confidence ?? 0.8,
        evidence: [{ source_url: '', excerpt: `Secondary color via ${sourceLabel}` }],
      };
    },
  },
  {
    field_key: 'typography_fonts',
    step_key: 'brand_design',
    extract: (_insights, _techStack, branding) => {
      if (!branding?.fonts?.length) return null;
      // For fonts we surface the joined list; confidence is the MAX across
      // sources so we don't penalise a Google-Fonts hit (0.90) just because
      // a fallback CSS-only font tagged along.
      const maxConfidence = branding.font_sources?.length
        ? Math.max(...branding.font_sources.map((s) => s.confidence))
        : 0.8;
      const topSource = branding.font_sources?.[0]?.source;
      const sourceLabel =
        topSource === 'google-fonts'
          ? 'Google Fonts <link>'
          : topSource === 'bunny-fonts'
            ? 'Bunny Fonts <link>'
            : topSource === 'css'
              ? 'inline CSS font-family'
              : 'LLM extraction';
      return {
        value: branding.fonts.join(', '),
        confidence: maxConfidence,
        evidence: [{ source_url: '', excerpt: `Fonts via ${sourceLabel}` }],
      };
    },
  },

  // S6.2: call tracking detection. When a recognised provider is found in
  // techStack, autofill BOTH the yes/no gate AND the dropdown value so the
  // ConfirmationField on call_tracking_provider has data to confirm against.
  {
    field_key: 'uses_call_tracking',
    step_key: 'technical_setup',
    extract: (_insights, techStack) => {
      const detected = detectCallTrackingProvider(techStack);
      if (!detected) return null;
      return {
        value: 'yes',
        confidence: 0.90,
        evidence: [{ source_url: '', excerpt: `Detected ${detected.displayName} in site tech stack` }],
      };
    },
  },
  {
    field_key: 'call_tracking_provider',
    step_key: 'technical_setup',
    extract: (_insights, techStack) => {
      const detected = detectCallTrackingProvider(techStack);
      if (!detected) return null;
      return {
        value: detected.key,
        confidence: 0.90,
        evidence: [{ source_url: '', excerpt: `Detected ${detected.displayName} in site tech stack` }],
      };
    },
  },
];

// =============================================
// Build prefill map from insights
// =============================================

export function buildPrefillMap(
  insights: SiteInsights,
  techStack?: TechStack | null,
  branding?: Branding | null,
): PrefillMap {
  const map: PrefillMap = {};

  for (const rule of MAPPING_RULES) {
    const result = rule.extract(insights, techStack, branding);
    if (!result) continue;

    const policy = getPolicy(result.confidence);
    if (policy === 'no_prefill') continue;

    const entry: PrefillEntry = {
      suggested_value: result.value,
      confidence: result.confidence,
      policy,
      evidence: result.evidence,
    };

    map[rule.field_key] = entry;
  }

  return map;
}

// =============================================
// Get mapping rules (for documentation/testing)
// =============================================
export function getMappingRules(): MappingRule[] {
  return MAPPING_RULES;
}
