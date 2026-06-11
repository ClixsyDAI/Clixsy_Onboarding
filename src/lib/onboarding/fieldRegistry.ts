/**
 * Canonical Field Registry — Single source of truth for onboarding field keys, types, and CRM mapping.
 *
 * Generated from Onboarding_field_schema.json.
 * All field keys, types, and CRM property names are deterministic and stable.
 */

// =============================================
// Types
// =============================================

export type CanonicalFieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'url'
  | 'date'
  | 'boolean'
  | 'select'
  | 'multi-select'
  | 'textarea'
  | 'repeater'
  | 'file_upload'
  | 'number';

export interface CanonicalField {
  id: number;
  field_key: string;
  field_type: CanonicalFieldType;
  question: string;
  section: string;
  notes?: string;
}

// =============================================
// Canonical Field Registry (from schema JSON)
// =============================================

export const CANONICAL_FIELDS: CanonicalField[] = [
  // s1_contacts
  { id: 1, field_key: 'contacts.primary.full_name', field_type: 'text', question: 'Primary contact full name', section: 's1_contacts' },
  { id: 2, field_key: 'contacts.primary.title', field_type: 'text', question: 'Primary contact title / role', section: 's1_contacts' },
  { id: 3, field_key: 'contacts.primary.email', field_type: 'email', question: 'Primary contact email', section: 's1_contacts' },
  { id: 4, field_key: 'contacts.primary.phone', field_type: 'phone', question: 'Primary contact phone', section: 's1_contacts', notes: 'E.164 format' },
  { id: 5, field_key: 'contacts.secondary.full_name', field_type: 'text', question: 'Secondary contact full name', section: 's1_contacts' },
  { id: 6, field_key: 'contacts.secondary.email', field_type: 'email', question: 'Secondary contact email', section: 's1_contacts' },
  { id: 7, field_key: 'contacts.secondary.phone', field_type: 'phone', question: 'Secondary contact phone', section: 's1_contacts', notes: 'E.164 format' },
  { id: 8, field_key: 'contacts.it.full_name', field_type: 'text', question: 'IT contact full name', section: 's1_contacts' },
  { id: 9, field_key: 'contacts.it.email', field_type: 'email', question: 'IT contact email', section: 's1_contacts' },
  { id: 10, field_key: 'contacts.it.phone', field_type: 'phone', question: 'IT contact phone', section: 's1_contacts', notes: 'E.164 format' },
  { id: 11, field_key: 'contacts.previous_agency_contact', field_type: 'repeater', question: 'Previous agency contact details', section: 's1_contacts', notes: 'fields: full_name, email, company' },

  // s2_business_profile
  { id: 12, field_key: 'business.name', field_type: 'text', question: 'Business name', section: 's2_business_profile' },
  { id: 13, field_key: 'business.main_url', field_type: 'url', question: 'Main website URL', section: 's2_business_profile', notes: 'Must include https://' },
  { id: 14, field_key: 'business.owner_names', field_type: 'repeater', question: 'Owner / partner full names', section: 's2_business_profile', notes: 'fields: full_name (string array)' },
  { id: 15, field_key: 'business.address', field_type: 'text', question: 'Physical address (GBP-exact)', section: 's2_business_profile', notes: 'Match GBP formatted_address exactly' },
  { id: 16, field_key: 'business.move_in_date', field_type: 'date', question: 'Move-in date at current location', section: 's2_business_profile', notes: 'YYYY-MM-DD' },
  { id: 17, field_key: 'business.main_phone', field_type: 'phone', question: 'Main business phone', section: 's2_business_profile', notes: 'E.164 format' },
  { id: 18, field_key: 'business.year_founded', field_type: 'number', question: 'Year founded', section: 's2_business_profile', notes: '4-digit year' },
  { id: 19, field_key: 'business.languages_spoken', field_type: 'multi-select', question: 'Languages spoken at firm', section: 's2_business_profile' },
  { id: 20, field_key: 'business.owner_license_number', field_type: 'text', question: 'Owner license number', section: 's2_business_profile' },
  { id: 21, field_key: 'business.license_issue_date', field_type: 'date', question: 'License issue date', section: 's2_business_profile', notes: 'YYYY-MM-DD' },
  { id: 22, field_key: 'business.ein', field_type: 'text', question: 'EIN', section: 's2_business_profile', notes: 'Format: XX-XXXXXXX' },

  // s3_vision_&_kpis
  { id: 23, field_key: 'strategy.success_definition_12mo', field_type: 'textarea', question: 'Success definition (12-month)', section: 's3_vision_&_kpis' },
  { id: 24, field_key: 'strategy.magic_wand_outcome', field_type: 'textarea', question: "'Magic wand' outcome", section: 's3_vision_&_kpis' },
  { id: 25, field_key: 'strategy.current_challenges', field_type: 'textarea', question: 'Current marketing challenges', section: 's3_vision_&_kpis' },
  { id: 26, field_key: 'strategy.kpis', field_type: 'multi-select', question: 'Key Performance Indicators', section: 's3_vision_&_kpis' },

  // s4_technical_assets
  { id: 27, field_key: 'technical.domain_owned_by_client', field_type: 'boolean', question: 'Domain owned by client?', section: 's4_technical_assets' },
  { id: 28, field_key: 'technical.dns_control', field_type: 'boolean', question: 'Client has DNS control?', section: 's4_technical_assets' },
  { id: 29, field_key: 'technical.other_domains', field_type: 'repeater', question: 'Other redirecting domains', section: 's4_technical_assets' },
  { id: 30, field_key: 'technical.cms', field_type: 'select', question: 'Website built on WordPress?', section: 's4_technical_assets' },
  { id: 31, field_key: 'technical.content_owned_by_client', field_type: 'boolean', question: 'Written content owned by client?', section: 's4_technical_assets' },
  { id: 32, field_key: 'technical.imagery_licensed', field_type: 'boolean', question: 'Imagery/video properly licensed', section: 's4_technical_assets' },
  { id: 33, field_key: 'technical.anti_spam_adequate', field_type: 'boolean', question: 'Anti-spam solution adequate?', section: 's4_technical_assets' },
  { id: 34, field_key: 'lead_management.form_submission_destinations', field_type: 'repeater', question: 'Form submission destinations', section: 's4_technical_assets' },
  { id: 35, field_key: 'lead_management.call_tracking_enabled', field_type: 'boolean', question: 'Call tracking in use?', section: 's4_technical_assets' },
  { id: 36, field_key: 'lead_management.call_tracking_provider', field_type: 'select', question: 'Call tracking provider', section: 's4_technical_assets' },
  { id: 37, field_key: 'lead_management.call_tracking_account_owner', field_type: 'select', question: 'Who owns call tracking account?', section: 's4_technical_assets' },
  { id: 38, field_key: 'agency_access.previous_agencies_can_be_removed', field_type: 'boolean', question: 'Can previous agency access be removed?', section: 's4_technical_assets' },
  { id: 39, field_key: 'agency_access.agencies_to_remove', field_type: 'repeater', question: 'Which agencies to remove?', section: 's4_technical_assets' },

  // s5_seo_targets
  { id: 40, field_key: 'seo.geo_targets', field_type: 'repeater', question: 'Main geographical targets', section: 's5_seo_targets' },
  { id: 41, field_key: 'seo.primary_case_types', field_type: 'multi-select', question: 'Primary case types & keywords', section: 's5_seo_targets' },
  { id: 42, field_key: 'seo.initial_focus_case_types', field_type: 'multi-select', question: 'Initial focus case types', section: 's5_seo_targets' },
  { id: 43, field_key: 'seo.secondary_gbp_locations', field_type: 'repeater', question: 'Secondary GBP locations', section: 's5_seo_targets' },
  { id: 44, field_key: 'seo.lsa_attorney_images_provided', field_type: 'file_upload', question: 'Attorney photos for LSA', section: 's5_seo_targets' },
  { id: 45, field_key: 'seo.additional_campaign_info', field_type: 'textarea', question: 'Additional campaign information', section: 's5_seo_targets' },

  // s6_legal_&_compliance
  { id: 46, field_key: 'compliance.state_bar_advertising_rules_url', field_type: 'url', question: 'State advertising restrictions URL', section: 's6_legal_&_compliance' },
  { id: 47, field_key: 'compliance.legal_disclaimers', field_type: 'repeater', question: 'Legal disclaimers required', section: 's6_legal_&_compliance' },
  { id: 48, field_key: 'compliance.forbidden_words', field_type: 'repeater', question: 'Forbidden words / phrases', section: 's6_legal_&_compliance' },
  { id: 49, field_key: 'compliance.forbidden_imagery', field_type: 'repeater', question: 'Imagery to avoid', section: 's6_legal_&_compliance' },
  { id: 50, field_key: 'compliance.forbidden_topics', field_type: 'repeater', question: 'Topics to avoid', section: 's6_legal_&_compliance' },
  { id: 51, field_key: 'compliance.content_approval_required', field_type: 'boolean', question: 'Content approval required?', section: 's6_legal_&_compliance' },

  // s7_communication
  { id: 52, field_key: 'contacts.reporting_distribution', field_type: 'repeater', question: 'Reporting distribution list', section: 's7_communication' },
  { id: 53, field_key: 'communication.missed_call_preference', field_type: 'select', question: 'Missed call preference', section: 's7_communication' },
  { id: 54, field_key: 'communication.call_frequency', field_type: 'select', question: 'Call frequency preference', section: 's7_communication' },

  // s8_platform_access
  { id: 55, field_key: 'access.wordpress.status', field_type: 'select', question: 'WordPress admin access', section: 's8_platform_access' },
  { id: 56, field_key: 'access.domain_registrar.registrar_name', field_type: 'select', question: 'Domain registrar', section: 's8_platform_access' },
  { id: 57, field_key: 'access.dns.dns_provider', field_type: 'select', question: 'DNS provider', section: 's8_platform_access' },
  { id: 58, field_key: 'access.gsc.property_url', field_type: 'url', question: 'Google Search Console property', section: 's8_platform_access' },
  { id: 59, field_key: 'access.ga.property_id', field_type: 'text', question: 'Google Analytics property ID', section: 's8_platform_access' },
  { id: 60, field_key: 'access.gbp.profiles', field_type: 'repeater', question: 'GBP profiles (all locations)', section: 's8_platform_access' },
  { id: 61, field_key: 'access.youtube.channel_id', field_type: 'url', question: 'YouTube channel', section: 's8_platform_access' },
  { id: 62, field_key: 'access.video_other', field_type: 'repeater', question: 'Wistia / Vimeo credentials', section: 's8_platform_access' },
  { id: 63, field_key: 'access.lsa.cids', field_type: 'repeater', question: 'LSA Customer IDs', section: 's8_platform_access' },
  { id: 64, field_key: 'access.social_and_ads', field_type: 'repeater', question: 'Other credentials (social/ads)', section: 's8_platform_access' },

  // s9_gifts_&_logistics
  { id: 65, field_key: 'gifts.office_gift', field_type: 'repeater', question: 'Office gift recipient + address', section: 's9_gifts_&_logistics' },
  { id: 66, field_key: 'gifts.individual_gift', field_type: 'repeater', question: 'Individual gift recipient + address', section: 's9_gifts_&_logistics' },
  { id: 67, field_key: 'gifts.delay_shipment', field_type: 'boolean', question: 'Delay shipment?', section: 's9_gifts_&_logistics' },
];

// =============================================
// Legacy → Canonical alias map
// Maps current codebase field names (step_key.field_name) to canonical dot-path keys
// =============================================

export const LEGACY_FIELD_ALIASES: Record<string, string> = {
  // s1_contacts: primary_contact step
  'main_contact_name': 'contacts.primary.full_name',
  'main_contact_title': 'contacts.primary.title',
  'main_contact_email': 'contacts.primary.email',
  'main_contact_phone': 'contacts.primary.phone',
  // s1_contacts: other_contacts step
  'secondary_contact_name': 'contacts.secondary.full_name',
  'secondary_contact_email': 'contacts.secondary.email',
  'secondary_contact_phone': 'contacts.secondary.phone',
  'tech_contact_name': 'contacts.it.full_name',
  'tech_contact_email': 'contacts.it.email',
  // s1_contacts: transition_wrapup step
  'previous_agency_contact': 'contacts.previous_agency_contact',
  'can_remove_agency_access': 'agency_access.previous_agencies_can_be_removed',

  // s2_business_profile: business_overview step
  'business_name': 'business.name',
  'website_url': 'business.main_url',
  'business_phone': 'business.main_phone',
  'physical_address': 'business.address',
  'languages': 'business.languages_spoken',
  'owner_names': 'business.owner_names',

  // s3_vision_&_kpis: goals_strategy step
  'success_definition': 'strategy.success_definition_12mo',
  'current_challenges': 'strategy.current_challenges',
  'important_metrics': 'strategy.kpis',

  // s4_technical_assets: technical_setup step
  'owns_domain': 'technical.domain_owned_by_client',
  'controls_dns': 'technical.dns_control',
  'website_platform': 'technical.cms',
  'uses_call_tracking': 'lead_management.call_tracking_enabled',
  'call_tracking_provider': 'lead_management.call_tracking_provider',
  'form_submission_destinations': 'lead_management.form_submission_destinations',
  'domain_registrar': 'access.domain_registrar.registrar_name',

  // s5_seo_targets: seo_targeting step
  'main_geographical_areas': 'seo.geo_targets',
  'primary_case_types_keywords': 'seo.primary_case_types',
  'case_priority': 'seo.initial_focus_case_types',
  // GBP 5a: legacy single-string key kept in this map so older sessions
  // whose answers blob still has the string form continue to alias
  // correctly. New canonical key for the multi-location array shape
  // (also maps to access.gbp.profiles since canonical field 60 was
  // always typed as `repeater`).
  'gbp_listing_url': 'access.gbp.profiles',
  'gbp_locations': 'access.gbp.profiles',

  // s6_legal_&_compliance: legal_content_comms step
  'advertising_regulations': 'compliance.state_bar_advertising_rules_url',
  'legal_disclaimers': 'compliance.legal_disclaimers',
  'words_phrases_to_avoid': 'compliance.forbidden_words',
  'topics_to_avoid': 'compliance.forbidden_topics',
  'content_approval_required': 'compliance.content_approval_required',

  // s7_communication: legal_content_comms step
  'call_frequency_preference': 'communication.call_frequency',

  // s8_platform_access: access_checklist step
  'ga_access_status': 'access.ga.property_id',
  'gsc_access_status': 'access.gsc.property_url',
  'gbp_access_status': 'access.gbp.profiles',
  'wordpress_access_status': 'access.wordpress.status',
  'domain_access_status': 'access.domain_registrar.registrar_name',
  'dns_access_status': 'access.dns.dns_provider',
  'youtube_access_status': 'access.youtube.channel_id',

  // s9_gifts_&_logistics: transition_wrapup step
  'gift_recipient_name': 'gifts.office_gift',
  'gift_shipping_address': 'gifts.individual_gift',
};

// Reverse map: canonical → legacy (for reading existing data)
export const CANONICAL_TO_LEGACY: Record<string, string[]> = {};
for (const [legacy, canonical] of Object.entries(LEGACY_FIELD_ALIASES)) {
  if (!CANONICAL_TO_LEGACY[canonical]) {
    CANONICAL_TO_LEGACY[canonical] = [];
  }
  CANONICAL_TO_LEGACY[canonical].push(legacy);
}

// =============================================
// CRM Property Naming
// =============================================

/**
 * Convert a canonical field_key to a deterministic CRM property name.
 * Rules: lowercase, snake_case, dots→__, prefixed with "onb__", max 50 chars
 */
// Special CRM name overrides for keys that would exceed 50 chars
const CRM_NAME_OVERRIDES: Record<string, string> = {
  'agency_access.previous_agencies_can_be_removed': 'onb__agency_access__prev_agencies_removable',
};

export function getCrmPropertyName(fieldKey: string): string {
  if (CRM_NAME_OVERRIDES[fieldKey]) return CRM_NAME_OVERRIDES[fieldKey];
  return 'onb__' + fieldKey.replace(/\./g, '__');
}

// =============================================
// Field Key Validation
// =============================================

const CANONICAL_KEY_SET = new Set(CANONICAL_FIELDS.map(f => f.field_key));
const LEGACY_KEY_SET = new Set(Object.keys(LEGACY_FIELD_ALIASES));

/**
 * Check if a field_key is recognized (canonical or legacy).
 * Returns { valid: true, canonical: string } or { valid: false }
 */
export function validateFieldKey(fieldKey: string): { valid: boolean; canonical?: string; isLegacy?: boolean } {
  if (CANONICAL_KEY_SET.has(fieldKey)) {
    return { valid: true, canonical: fieldKey, isLegacy: false };
  }
  if (LEGACY_KEY_SET.has(fieldKey)) {
    return { valid: true, canonical: LEGACY_FIELD_ALIASES[fieldKey], isLegacy: true };
  }
  return { valid: false };
}

/**
 * Resolve a key to its canonical form. Returns the key unchanged if not recognized.
 */
export function resolveCanonicalKey(fieldKey: string): string {
  return LEGACY_FIELD_ALIASES[fieldKey] || fieldKey;
}

// =============================================
// Value Normalization
// =============================================

/**
 * Normalize a value according to its canonical field type.
 * - boolean: convert "yes"/"no"/"true"/"false" strings to boolean
 * - phone: trim whitespace
 * - email: trim + lowercase
 * - url: trim, ensure https://
 * - multi-select: ensure array
 * - number: parse to number
 * - date: ensure YYYY-MM-DD format
 */
export function normalizeAnswer(fieldKey: string, value: unknown): unknown {
  const field = CANONICAL_FIELDS.find(f => f.field_key === fieldKey);
  if (!field) return value; // unknown field, pass through

  if (value === null || value === undefined || value === '') return value;

  switch (field.field_type) {
    case 'boolean':
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'yes' || lower === 'true') return true;
        if (lower === 'no' || lower === 'false') return false;
      }
      return Boolean(value);

    case 'email':
      return typeof value === 'string' ? value.trim().toLowerCase() : value;

    case 'phone':
    case 'text':
    case 'url':
    case 'textarea':
      return typeof value === 'string' ? value.trim() : value;

    case 'number':
      if (typeof value === 'string') {
        const parsed = Number(value);
        return isNaN(parsed) ? value : parsed;
      }
      return value;

    case 'multi-select':
      if (typeof value === 'string') {
        return value.split(',').map(s => s.trim()).filter(Boolean);
      }
      return Array.isArray(value) ? value : [value];

    case 'select':
      return typeof value === 'string' ? value.trim() : value;

    default:
      return value;
  }
}

// =============================================
// Lookup helpers
// =============================================

export function getCanonicalField(fieldKey: string): CanonicalField | undefined {
  const canonical = resolveCanonicalKey(fieldKey);
  return CANONICAL_FIELDS.find(f => f.field_key === canonical);
}

export function getFieldsBySection(section: string): CanonicalField[] {
  return CANONICAL_FIELDS.filter(f => f.section === section);
}
