# Acceptance Checklist

## Field Naming Standardization

### Registry & Mapping
- [x] Canonical field registry (`fieldRegistry.ts`) contains all 67 fields from schema
- [x] All field IDs are unique
- [x] All field_keys are unique
- [x] Every legacy alias maps to a valid canonical key
- [x] CRM property names are deterministic (same input → same output)
- [x] All CRM property names are ≤50 characters
- [x] All CRM property names are prefixed with `onb__`

### Backward Compatibility
- [x] Existing sessions still load (legacy keys recognized via alias map)
- [x] `resolveCanonicalKey()` maps legacy → canonical
- [x] `validateFieldKey()` accepts both legacy and canonical keys
- [x] Unknown keys pass through without error (graceful degradation)

### Normalization
- [x] Boolean values normalized (yes/no/true/false → true/false)
- [x] Email values trimmed and lowercased
- [x] Phone values trimmed
- [x] Number values parsed from strings
- [x] Multi-select values ensure array format

### CRM Payload
- [x] `buildCrmPayloadFromSession()` converts session answers to CRM format
- [x] Only recognized keys appear in CRM payload (no garbage)
- [x] Values are normalized before inclusion
- [x] Both legacy and canonical keys are handled

### Migration
- [x] Migration script (`scripts/migrateOnboardingFieldKeys.ts`) exists
- [x] Supports dry-run mode (`DRY_RUN=true`)
- [x] Never overwrites canonical keys if they already exist
- [x] Produces migration log with counts
- [x] Processes in batches (50 rows)

### Tests
- [x] 222 unit tests passing
- [x] Registry integrity (67 fields, unique IDs and keys)
- [x] CRM naming deterministic and within limits
- [x] Legacy alias mapping complete and valid
- [x] Value normalization correct per type
- [x] CRM payload builder correct
- [x] Migration safety (no canonical overwrite)

### Artifacts Produced
- [x] `outputs/canonical_field_registry.json`
- [x] `outputs/canonical_field_registry.csv`
- [x] `outputs/field_to_crm_mapping.csv`
- [x] `outputs/type_mismatch_report.md`
- [x] `notes/current_field_usage_map.md`
- [x] `outputs/acceptance_checklist.md`
