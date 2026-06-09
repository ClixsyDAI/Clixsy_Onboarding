/**
 * CRM Payload Builder
 *
 * Converts session answers (stored with legacy or canonical keys) into a
 * deterministic CRM-ready payload using canonical field registry.
 *
 * Output format: { [crm_property]: normalized_value }
 * All keys are prefixed with "onb__" and use double-underscore for dots.
 */

import {
  CANONICAL_FIELDS,
  LEGACY_FIELD_ALIASES,
  getCrmPropertyName,
  normalizeAnswer,
} from '@/lib/onboarding/fieldRegistry';

type SessionAnswers = Record<string, Record<string, unknown>>;

interface CrmPayload {
  [crmProperty: string]: unknown;
}

/**
 * Build a CRM-ready payload from session answers.
 *
 * @param sessionAnswers - Answers keyed by step_key → { field_name: value }
 * @returns Object with CRM property names as keys and normalized values
 */
export function buildCrmPayloadFromSession(sessionAnswers: SessionAnswers): CrmPayload {
  const payload: CrmPayload = {};
  const canonicalKeySet = new Set(CANONICAL_FIELDS.map(f => f.field_key));

  for (const [_stepKey, stepAnswers] of Object.entries(sessionAnswers)) {
    if (!stepAnswers || typeof stepAnswers !== 'object') continue;

    for (const [fieldName, rawValue] of Object.entries(stepAnswers)) {
      // Skip empty/null values
      if (rawValue === null || rawValue === undefined || rawValue === '') continue;

      // Resolve to canonical key
      let canonicalKey: string;
      if (canonicalKeySet.has(fieldName)) {
        canonicalKey = fieldName;
      } else if (LEGACY_FIELD_ALIASES[fieldName]) {
        canonicalKey = LEGACY_FIELD_ALIASES[fieldName];
      } else {
        // Unknown key — skip for CRM (don't pollute payload with non-standard keys)
        continue;
      }

      // Get CRM property name
      const crmProp = getCrmPropertyName(canonicalKey);

      // Normalize value
      const normalizedValue = normalizeAnswer(canonicalKey, rawValue);

      // Don't overwrite if already set (first value wins — preserves canonical over legacy)
      if (!(crmProp in payload)) {
        payload[crmProp] = normalizedValue;
      }
    }
  }

  return payload;
}

/**
 * Get all CRM property names that are defined in the registry.
 * Useful for CRM schema setup.
 */
export function getAllCrmProperties(): { property: string; type: string; fieldKey: string }[] {
  return CANONICAL_FIELDS.map(f => ({
    property: getCrmPropertyName(f.field_key),
    type: f.field_type,
    fieldKey: f.field_key,
  }));
}
