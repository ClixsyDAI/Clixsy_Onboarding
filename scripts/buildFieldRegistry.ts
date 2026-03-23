/**
 * Build canonical field registry from schema JSON.
 * Produces: canonical_field_registry.json, canonical_field_registry.csv, field_to_crm_mapping.csv
 *
 * Run: npx tsx scripts/buildFieldRegistry.ts
 */

import fs from 'fs';
import path from 'path';

const SCHEMA_PATH = path.join(__dirname, '..', 'field-naming-standardization', '2026-03-23', 'inputs', 'Onboarding_field_schema.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'field-naming-standardization', '2026-03-23', 'outputs');

// Read schema
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));

interface CanonicalField {
  id: number;
  section: string;
  question: string;
  field_key: string;
  field_type: string;
  required: boolean;
  notes: string;
}

interface CrmMapping {
  field_key: string;
  field_type: string;
  crm_property: string;
  crm_type: string;
  notes: string;
}

// CRM type mapping
function toCrmType(fieldType: string): string {
  switch (fieldType) {
    case 'boolean': return 'bool';
    case 'number': return 'number';
    case 'date': return 'date';
    case 'multi-select': return 'string'; // JSON array as string
    case 'repeater': return 'string'; // JSON array as string
    case 'file_upload': return 'string'; // URL reference
    default: return 'string';
  }
}

// Convert field_key to CRM property name
function toCrmProperty(fieldKey: string): string {
  return 'onb__' + fieldKey.replace(/\./g, '__');
}

const allFields: CanonicalField[] = [];
const crmMappings: CrmMapping[] = [];

for (const [section, fields] of Object.entries(schema)) {
  for (const field of fields as any[]) {
    allFields.push({
      id: field.id,
      section,
      question: field.question,
      field_key: field.field_key,
      field_type: field.field_type,
      required: false, // schema doesn't specify required; UI config determines this
      notes: field.notes || '',
    });

    crmMappings.push({
      field_key: field.field_key,
      field_type: field.field_type,
      crm_property: toCrmProperty(field.field_key),
      crm_type: toCrmType(field.field_type),
      notes: field.notes || '',
    });
  }
}

// Write canonical registry JSON
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'canonical_field_registry.json'),
  JSON.stringify(allFields, null, 2)
);

// Write canonical registry CSV
const csvHeader = 'id,section,question,field_key,field_type,required,notes';
const csvRows = allFields.map(f =>
  `${f.id},"${f.section}","${f.question.replace(/"/g, '""')}","${f.field_key}","${f.field_type}",${f.required},"${f.notes.replace(/"/g, '""')}"`
);
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'canonical_field_registry.csv'),
  [csvHeader, ...csvRows].join('\n')
);

// Write CRM mapping CSV
const crmHeader = 'field_key,field_type,crm_property,crm_type,notes';
const crmRows = crmMappings.map(m =>
  `"${m.field_key}","${m.field_type}","${m.crm_property}","${m.crm_type}","${m.notes.replace(/"/g, '""')}"`
);
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'field_to_crm_mapping.csv'),
  [crmHeader, ...crmRows].join('\n')
);

console.log(`✓ Canonical registry: ${allFields.length} fields`);
console.log(`✓ CRM mappings: ${crmMappings.length} entries`);
console.log(`✓ Files written to ${OUTPUT_DIR}`);
