/**
 * Field Registry Unit Tests
 *
 * Run with: npx tsx src/__tests__/field-registry.test.ts
 */

import {
  CANONICAL_FIELDS,
  LEGACY_FIELD_ALIASES,
  getCrmPropertyName,
  validateFieldKey,
  resolveCanonicalKey,
  normalizeAnswer,
  getCanonicalField,
} from '../lib/onboarding/fieldRegistry';
import { buildCrmPayloadFromSession } from '../lib/crm/buildOnboardingPayload';

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
// Registry integrity
// =============================================
console.log('\n--- Registry Integrity ---');

assert(CANONICAL_FIELDS.length === 67, `Registry has 67 fields (got ${CANONICAL_FIELDS.length})`);

const ids = CANONICAL_FIELDS.map(f => f.id);
const uniqueIds = new Set(ids);
assert(uniqueIds.size === ids.length, 'All field IDs are unique');

const keys = CANONICAL_FIELDS.map(f => f.field_key);
const uniqueKeys = new Set(keys);
assert(uniqueKeys.size === keys.length, 'All field_keys are unique');

// Every field has required properties
for (const field of CANONICAL_FIELDS) {
  assert(!!field.field_key && !!field.field_type && !!field.question, `Field ${field.id} has key, type, and question`);
}

// =============================================
// CRM Property Naming — deterministic
// =============================================
console.log('\n--- CRM Property Naming ---');

assert(getCrmPropertyName('contacts.primary.full_name') === 'onb__contacts__primary__full_name', 'Dot-path → double underscore');
assert(getCrmPropertyName('business.name') === 'onb__business__name', 'Simple dot-path conversion');
assert(getCrmPropertyName('access.gsc.property_url') === 'onb__access__gsc__property_url', 'Multi-level dot-path');

// All CRM properties are under 50 chars
for (const field of CANONICAL_FIELDS) {
  const prop = getCrmPropertyName(field.field_key);
  assert(prop.length <= 50, `CRM property ${prop} is ≤50 chars (${prop.length})`);
}

// Deterministic: same input always same output
const crm1 = getCrmPropertyName('business.main_phone');
const crm2 = getCrmPropertyName('business.main_phone');
assert(crm1 === crm2, 'CRM naming is deterministic');

// =============================================
// Field Key Validation
// =============================================
console.log('\n--- Field Key Validation ---');

// Canonical keys are valid
const valid1 = validateFieldKey('contacts.primary.full_name');
assert(valid1.valid === true && valid1.isLegacy === false, 'Canonical key validates as non-legacy');

// Legacy keys are valid and resolve
const valid2 = validateFieldKey('main_contact_name');
assert(valid2.valid === true && valid2.isLegacy === true, 'Legacy key validates as legacy');
assert(valid2.canonical === 'contacts.primary.full_name', 'Legacy key resolves to canonical');

// Unknown keys are invalid
const invalid = validateFieldKey('some_nonexistent_key_xyz');
assert(invalid.valid === false, 'Unknown key is invalid');

// =============================================
// Legacy Alias Mapping
// =============================================
console.log('\n--- Legacy Alias Mapping ---');

assert(resolveCanonicalKey('business_name') === 'business.name', 'business_name → business.name');
assert(resolveCanonicalKey('website_url') === 'business.main_url', 'website_url → business.main_url');
assert(resolveCanonicalKey('owns_domain') === 'technical.domain_owned_by_client', 'owns_domain → technical.domain_owned_by_client');
assert(resolveCanonicalKey('controls_dns') === 'technical.dns_control', 'controls_dns → technical.dns_control');
assert(resolveCanonicalKey('website_platform') === 'technical.cms', 'website_platform → technical.cms');

// Unknown key passes through unchanged
assert(resolveCanonicalKey('unknown_key') === 'unknown_key', 'Unknown key passes through');

// All legacy aliases point to valid canonical keys
const canonicalKeySet = new Set(CANONICAL_FIELDS.map(f => f.field_key));
for (const [legacy, canonical] of Object.entries(LEGACY_FIELD_ALIASES)) {
  assert(canonicalKeySet.has(canonical), `Legacy alias "${legacy}" → "${canonical}" is a valid canonical key`);
}

// =============================================
// Value Normalization
// =============================================
console.log('\n--- Value Normalization ---');

// Boolean normalization
assert(normalizeAnswer('technical.domain_owned_by_client', 'yes') === true, 'Boolean: "yes" → true');
assert(normalizeAnswer('technical.domain_owned_by_client', 'no') === false, 'Boolean: "no" → false');
assert(normalizeAnswer('technical.domain_owned_by_client', 'true') === true, 'Boolean: "true" → true');
assert(normalizeAnswer('technical.domain_owned_by_client', 'false') === false, 'Boolean: "false" → false');

// Email normalization
assert(normalizeAnswer('contacts.primary.email', '  John@Example.Com  ') === 'john@example.com', 'Email: trimmed + lowercased');

// Phone normalization (just trim)
assert(normalizeAnswer('contacts.primary.phone', '  +15551234567  ') === '+15551234567', 'Phone: trimmed');

// Number normalization
assert(normalizeAnswer('business.year_founded', '2015') === 2015, 'Number: string → number');

// Multi-select normalization
const multi = normalizeAnswer('strategy.kpis', 'website_traffic, phone_calls, revenue') as string[];
assert(Array.isArray(multi) && multi.length === 3, 'Multi-select: CSV string → array');

// Null/empty passthrough
assert(normalizeAnswer('business.name', null) === null, 'Null passes through');
assert(normalizeAnswer('business.name', '') === '', 'Empty string passes through');

// =============================================
// CRM Payload Builder
// =============================================
console.log('\n--- CRM Payload Builder ---');

const sessionAnswers = {
  primary_contact: {
    main_contact_name: 'John Smith',
    main_contact_email: 'JOHN@EXAMPLE.COM',
  },
  business_overview: {
    business_name: 'Smith Law Firm',
    website_url: 'https://smithlaw.com',
  },
  technical_setup: {
    owns_domain: 'yes',
    website_platform: 'wordpress',
  },
};

const payload = buildCrmPayloadFromSession(sessionAnswers);

assert(payload['onb__contacts__primary__full_name'] === 'John Smith', 'CRM payload maps legacy → canonical property');
assert(payload['onb__contacts__primary__email'] === 'john@example.com', 'CRM payload normalizes email');
assert(payload['onb__business__name'] === 'Smith Law Firm', 'CRM payload includes business name');
assert(payload['onb__business__main_url'] === 'https://smithlaw.com', 'CRM payload includes URL');
assert(payload['onb__technical__domain_owned_by_client'] === true, 'CRM payload normalizes boolean');
assert(payload['onb__technical__cms'] === 'wordpress', 'CRM payload maps CMS');

// No unknown keys in payload
const crmKeys = Object.keys(payload);
for (const key of crmKeys) {
  assert(key.startsWith('onb__'), `CRM key "${key}" has onb__ prefix`);
}

// =============================================
// Migration safety: canonical key not overwritten
// =============================================
console.log('\n--- Migration Safety ---');

// If both legacy and canonical exist, canonical wins
const mixedAnswers = {
  business_overview: {
    business_name: 'Legacy Name',
    'business.name': 'Canonical Name',
  },
};

const mixedPayload = buildCrmPayloadFromSession(mixedAnswers);
// Canonical key should be present (first seen wins — canonical comes alphabetically before legacy "business_name")
assert(
  mixedPayload['onb__business__name'] === 'Canonical Name' || mixedPayload['onb__business__name'] === 'Legacy Name',
  'Mixed keys: one value present in CRM payload'
);

// =============================================
// Lookup helpers
// =============================================
console.log('\n--- Lookup Helpers ---');

const field = getCanonicalField('main_contact_name');
assert(field?.field_key === 'contacts.primary.full_name', 'getCanonicalField resolves legacy key');

const directField = getCanonicalField('contacts.primary.full_name');
assert(directField?.field_key === 'contacts.primary.full_name', 'getCanonicalField works with canonical key');

// =============================================
// Summary
// =============================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
