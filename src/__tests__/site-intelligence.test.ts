/**
 * Site Intelligence Unit Tests
 *
 * Run with: npx tsx src/__tests__/site-intelligence.test.ts
 *
 * Tests cover:
 * - Schema validation
 * - Confidence gating
 * - Field mapping rules
 * - Question override generation
 */

import { getPolicy, siteInsightsSchema, brandingSchema, prefillEntrySchema } from '../lib/siteIntelligence/schemas';
import { buildPrefillMap } from '../lib/siteIntelligence/field-mapping';
import { buildQuestionOverrides } from '../lib/siteIntelligence/question-overrides';
import type { SiteInsights, TechStack, Branding } from '../lib/siteIntelligence/schemas';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

// =============================================
// Test: Confidence Gating
// =============================================
console.log('\n--- Confidence Gating ---');

assert(getPolicy(0.90) === 'autofill', 'confidence 0.90 → autofill');
assert(getPolicy(0.80) === 'autofill', 'confidence 0.80 → autofill');
assert(getPolicy(0.79) === 'suggest_only', 'confidence 0.79 → suggest_only');
assert(getPolicy(0.55) === 'suggest_only', 'confidence 0.55 → suggest_only');
assert(getPolicy(0.54) === 'no_prefill', 'confidence 0.54 → no_prefill');
assert(getPolicy(0) === 'no_prefill', 'confidence 0 → no_prefill');
assert(getPolicy(1.0) === 'autofill', 'confidence 1.0 → autofill');

// =============================================
// Test: Schema Validation
// =============================================
console.log('\n--- Schema Validation ---');

// Valid insights
const validInsights = siteInsightsSchema.parse({
  brand_name: 'Test Corp',
  business_summary: 'A test business.',
  primary_services: [{ name: 'Web Design', confidence: 0.85, evidence: [{ source_url: 'https://test.com', excerpt: 'We do web design' }] }],
  primary_locations: [{ name: 'Dallas', type: 'city', confidence: 0.90, evidence: [{ source_url: 'https://test.com', excerpt: 'Based in Dallas' }] }],
});
assert(validInsights.brand_name === 'Test Corp', 'Valid insights parse correctly');
assert(validInsights.primary_services.length === 1, 'Services parsed correctly');

// Empty insights (should have defaults)
const emptyInsights = siteInsightsSchema.parse({});
assert(emptyInsights.primary_services.length === 0, 'Empty insights default to empty arrays');
assert(emptyInsights.social_links.length === 0, 'Social links default to empty array');

// Valid branding
const validBranding = brandingSchema.parse({
  screenshot_url: 'https://example.com/screenshot.png',
  colors: ['#FF0000', '#00FF00'],
  fonts: ['Arial'],
});
assert(validBranding.colors.length === 2, 'Branding colors parsed');
assert(validBranding.fonts.length === 1, 'Branding fonts parsed');

// Prefill entry validation
const validPrefill = prefillEntrySchema.parse({
  suggested_value: 'Dallas, TX',
  confidence: 0.85,
  policy: 'autofill',
  evidence: [{ source_url: 'https://test.com', excerpt: 'Located in Dallas' }],
});
assert(validPrefill.policy === 'autofill', 'Prefill entry validates');

// =============================================
// Test: Field Mapping
// =============================================
console.log('\n--- Field Mapping ---');

const testInsights: SiteInsights = {
  brand_name: 'Smith & Associates',
  business_summary: 'A law firm in Dallas.',
  primary_services: [
    { name: 'Personal Injury', confidence: 0.90, evidence: [{ source_url: 'https://smith.com', excerpt: 'Practice area' }] },
    { name: 'Car Accidents', confidence: 0.85, evidence: [{ source_url: 'https://smith.com/services', excerpt: 'Specializing in car accidents' }] },
  ],
  secondary_services: [],
  primary_locations: [
    { name: 'Dallas', type: 'city', confidence: 0.90, evidence: [{ source_url: 'https://smith.com', excerpt: 'Serving Dallas' }] },
  ],
  secondary_locations: [
    { name: 'Fort Worth', type: 'city', confidence: 0.70, evidence: [{ source_url: 'https://smith.com', excerpt: 'Also serving Fort Worth' }] },
  ],
  focus_themes: [],
  contact_public: { phone: '(555) 123-4567', address: '123 Main St, Dallas, TX 75201' },
  social_links: [],
  key_pages: [],
};

const testTechStack: TechStack = {
  cms: 'WordPress',
  analytics: ['Google Analytics'],
  frameworks: [],
  other: [],
};

const testBranding: Branding = {
  colors: ['#1a2b3c', '#4d5e6f'],
  fonts: ['Montserrat', 'Open Sans'],
};

const prefillMap = buildPrefillMap(testInsights, testTechStack, testBranding);

assert(prefillMap['business_name']?.suggested_value === 'Smith & Associates', 'business_name mapped');
assert(prefillMap['business_name']?.policy === 'autofill', 'business_name policy is autofill');
assert(prefillMap['business_phone']?.suggested_value === '(555) 123-4567', 'business_phone mapped');
assert(prefillMap['physical_address']?.suggested_value === '123 Main St, Dallas, TX 75201', 'physical_address mapped');
assert(typeof prefillMap['main_geographical_areas']?.suggested_value === 'string', 'main_geographical_areas mapped');
assert((prefillMap['main_geographical_areas']?.suggested_value as string).includes('Dallas'), 'locations include Dallas');
assert(prefillMap['website_platform']?.suggested_value === 'wordpress', 'website_platform mapped to option value');
assert(prefillMap['primary_color']?.suggested_value === '#1a2b3c', 'primary_color mapped');
assert(prefillMap['secondary_color']?.suggested_value === '#4d5e6f', 'secondary_color mapped');
assert((prefillMap['typography_fonts']?.suggested_value as string).includes('Montserrat'), 'fonts mapped');

// Every entry must have evidence
for (const [key, entry] of Object.entries(prefillMap)) {
  assert(entry.evidence.length > 0, `${key} has evidence`);
}

// =============================================
// Test: Question Overrides
// =============================================
console.log('\n--- Question Overrides ---');

const overrides = buildQuestionOverrides(testInsights, 'WordPress');

assert(!!overrides['main_geographical_areas'], 'Location override generated');
assert(overrides['main_geographical_areas']?.ui_pattern === 'confirmation', 'Location override uses confirmation pattern');
assert(overrides['main_geographical_areas']?.label_override.includes('Dallas'), 'Location override mentions Dallas');

assert(!!overrides['primary_case_types_keywords'], 'Services override generated');
assert(overrides['primary_case_types_keywords']?.label_override.includes('Personal Injury'), 'Services override mentions top service');

assert(!!overrides['website_platform'], 'Platform override generated');
assert(overrides['website_platform']?.label_override.includes('WordPress'), 'Platform override mentions CMS');

assert(!!overrides['business_name'], 'Business name override generated');
assert(overrides['business_name']?.label_override.includes('Smith & Associates'), 'Business name override mentions brand');

// All overrides keep original_label
for (const [key, override] of Object.entries(overrides)) {
  assert(!!override.original_label, `${key} has original_label`);
}

// =============================================
// Test: Low confidence should not generate overrides
// =============================================
console.log('\n--- Low Confidence Handling ---');

const lowConfInsights: SiteInsights = {
  ...testInsights,
  primary_locations: [
    { name: 'Somewhere', type: 'city', confidence: 0.40, evidence: [{ source_url: 'https://test.com', excerpt: 'Maybe' }] },
  ],
  primary_services: [
    { name: 'Something', confidence: 0.40, evidence: [{ source_url: 'https://test.com', excerpt: 'Maybe' }] },
  ],
};

const lowConfOverrides = buildQuestionOverrides(lowConfInsights);
assert(!lowConfOverrides['main_geographical_areas'], 'No location override at low confidence');
assert(!lowConfOverrides['primary_case_types_keywords'], 'No services override at low confidence');

const lowConfPrefill = buildPrefillMap(lowConfInsights);
// Low confidence services/locations should still map but with no_prefill policy filtered out
const lowGeoEntry = lowConfPrefill['main_geographical_areas'];
assert(!lowGeoEntry || lowGeoEntry.policy !== 'autofill', 'Low confidence location not autofilled');

// =============================================
// Summary
// =============================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
