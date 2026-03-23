# Type Mismatch Report

## Schema JSON vs XLSX Cross-Check

The XLSX file (`Onboarding_Field_Types.xlsx`) defines 12 field types with validation rules.
The JSON schema (`Onboarding_field_schema.json`) uses these same types consistently.

### Comparison Results

| JSON Field Type | XLSX Field Type | Match? | Notes |
|----------------|-----------------|--------|-------|
| text | text | Yes | Max 255 chars, trimmed |
| email | email | Yes | RFC 5322 format |
| phone | phone | Yes | E.164 format |
| url | url | Yes | Must include https:// |
| date | date | Yes | ISO 8601: YYYY-MM-DD |
| boolean | boolean | Yes | true/false |
| select | select | Yes | Value must match enum |
| multi-select | multi-select | Yes | String array from enum |
| textarea | textarea | Yes | No hard limit |
| repeater | repeater | Yes | Array of objects |
| file_upload | file_upload | Yes | Type-specific |
| number | number | Yes | Integer unless noted |

### Type Mismatches Found: **0**

Both sources use identical type names and are fully aligned. No resolution needed.

### Semantic Mismatches Between Schema and Codebase

The codebase (steps-v2.ts) uses HTML input types (`text`, `tel`, `email`, `url`, `textarea`, `select`, `multiselect`, `radio`, `checkbox`) while the schema uses semantic types (`text`, `phone`, `email`, `url`, `textarea`, `select`, `multi-select`, `boolean`, `repeater`).

Key mappings applied in the field registry:
| Codebase Type | Schema Type | Notes |
|---------------|-------------|-------|
| `tel` | `phone` | Same semantics, different name |
| `radio` (yes/no) | `boolean` | Radio with yes/no maps to boolean |
| `radio` (multi-option) | `select` | Radio with >2 options maps to select |
| `multiselect` | `multi-select` | Hyphen difference |
| `checkbox` | `boolean` | Single checkbox maps to boolean |

These are handled by the `normalizeAnswer()` function in the field registry.
