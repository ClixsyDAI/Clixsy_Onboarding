import type { SiteInsights, QuestionOverrides, QuestionOverride, TechStack } from './schemas';
import { CONFIDENCE_THRESHOLDS } from './schemas';

// Known call-tracking provider names that the scrapers (Wappalyzer /
// BuiltWith) surface in tech_stack.other. Used by S6.2 to drive both the
// confirmation override and the call_tracking_provider prefill.
// Keys MUST match the option values in steps-v2.ts.
const CALL_TRACKING_NAMES: Record<string, string> = {
  callrail: 'CallRail',
  ctm: 'CallTrackingMetrics',
  marchex: 'Marchex',
  whatconverts: 'WhatConverts',
  invoca: 'Invoca',
};

/**
 * Inspect a TechStack for any known call-tracking provider name.
 * Returns the canonical option key (e.g. 'callrail') and human display name,
 * or `null` if nothing detected. Also exported so field-mapping.ts can
 * derive the prefill_map entries from the same matching logic.
 */
export function detectCallTrackingProvider(
  techStack: TechStack | null | undefined
): { key: string; displayName: string } | null {
  if (!techStack) return null;
  const haystack = [
    ...(techStack.other || []),
    ...(techStack.analytics || []),
    ...(techStack.frameworks || []),
  ].map((s) => s.toLowerCase());

  for (const [key, displayName] of Object.entries(CALL_TRACKING_NAMES)) {
    if (haystack.some((s) => s.includes(key) || s.includes(displayName.toLowerCase()))) {
      return { key, displayName };
    }
  }
  // Anything in the option list other than the known ones — fall back to
  // 'other'. We surface the literal scraper name for the confirmation prose.
  return null;
}

// =============================================
// Question personalization templates
// =============================================
// Rules:
// - Always present findings as "we noticed" + confirmation
// - Never claim revenue, staff size, or private data
// - Keep original label as fallback
// =============================================

interface OverrideRule {
  field_key: string;
  generate: (insights: SiteInsights) => QuestionOverride | null;
}

const OVERRIDE_RULES: OverrideRule[] = [
  // Location confirmation
  {
    field_key: 'main_geographical_areas',
    generate: (insights) => {
      const primary = insights.primary_locations[0];
      if (!primary || primary.confidence < CONFIDENCE_THRESHOLDS.SUGGEST) return null;

      const allLocations = [
        ...insights.primary_locations.map(l => l.name),
        ...insights.secondary_locations.map(l => l.name),
      ];
      const locationList = allLocations.slice(0, 4).join(', ');

      return {
        label_override: `We noticed ${primary.name} looks like your primary market${allLocations.length > 1 ? `, along with ${allLocations.slice(1, 4).join(', ')}` : ''}. Is that correct?`,
        help_override: 'Edit the areas below to adjust. Add or remove cities as needed.',
        ui_pattern: 'confirmation',
        original_label: 'What cities or areas do you want to target?',
      };
    },
  },

  // Services confirmation
  {
    field_key: 'primary_case_types_keywords',
    generate: (insights) => {
      if (insights.primary_services.length === 0) return null;
      const topConfidence = insights.primary_services[0].confidence;
      if (topConfidence < CONFIDENCE_THRESHOLDS.SUGGEST) return null;

      const serviceNames = insights.primary_services.slice(0, 5).map(s => s.name).join(', ');

      return {
        label_override: `We noticed you focus on ${serviceNames}. Is that accurate?`,
        help_override: 'Edit the list below to add, remove, or reorder your services.',
        ui_pattern: 'confirmation',
        original_label: 'What are your primary case types or services?',
      };
    },
  },

  // Platform/CMS confirmation
  {
    field_key: 'website_platform',
    generate: (insights) => {
      // This override doesn't use insights directly — it uses tech_stack
      // which is handled separately. We return null here and handle it in
      // buildQuestionOverridesWithTechStack below.
      return null;
    },
  },

  // Brand colors confirmation
  {
    field_key: 'knows_brand_colors',
    generate: (insights) => {
      // If we detected colors, we can suggest them
      return null; // Handled via branding data
    },
  },

  // Business name confirmation
  {
    field_key: 'business_name',
    generate: (insights) => {
      if (!insights.brand_name) return null;
      return {
        label_override: `We found your business name is "${insights.brand_name}". Is that correct?`,
        help_override: 'Edit if this isn\'t quite right.',
        ui_pattern: 'confirmation',
        original_label: 'Business Name',
      };
    },
  },

  // Address confirmation
  {
    field_key: 'physical_address',
    generate: (insights) => {
      if (!insights.contact_public?.address) return null;
      return {
        label_override: `We found this address on your website. Is it correct?`,
        help_override: 'Edit if your address has changed or this isn\'t your main office.',
        ui_pattern: 'confirmation',
        original_label: 'Physical Company Address',
      };
    },
  },

  // Phone confirmation
  {
    field_key: 'business_phone',
    generate: (insights) => {
      if (!insights.contact_public?.phone) return null;
      return {
        label_override: `We found this phone number on your website. Is it your main business line?`,
        help_override: 'Update if this is not the best number for us to use.',
        ui_pattern: 'confirmation',
        original_label: 'Main Business Phone',
      };
    },
  },
];

// =============================================
// Build question overrides from insights
// =============================================

export function buildQuestionOverrides(
  insights: SiteInsights,
  cmsName?: string,
  techStack?: TechStack | null,
): QuestionOverrides {
  const overrides: QuestionOverrides = {};

  for (const rule of OVERRIDE_RULES) {
    const result = rule.generate(insights);
    if (result) {
      overrides[rule.field_key] = result;
    }
  }

  // CMS/platform confirmation (needs tech_stack data)
  if (cmsName) {
    overrides['website_platform'] = {
      label_override: `It looks like your site is built on ${cmsName}. Is that correct?`,
      help_override: 'Select the correct platform if this doesn\'t look right.',
      ui_pattern: 'confirmation',
      original_label: 'What platform is your website built on?',
    };
  }

  // S6.2: call-tracking provider confirmation. When the scrape detects a
  // known provider, present the dropdown as a Yes/No confirmation rather
  // than asking the client to pick from a list they don't recognise. If
  // they click "No, let me edit", StepRenderer's dismissedOverrides set
  // takes over and the original dropdown reappears for manual selection.
  const callTracking = detectCallTrackingProvider(techStack || null);
  if (callTracking) {
    overrides['call_tracking_provider'] = {
      label_override: `We detected ${callTracking.displayName} on your website. Is that your call tracking provider?`,
      help_override: 'Click "No, let me edit" if your firm actually uses a different provider.',
      ui_pattern: 'confirmation',
      original_label: 'Which call tracking provider?',
    };
  }

  return overrides;
}
