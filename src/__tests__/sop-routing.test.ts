/**
 * SOP Routing Unit Tests
 *
 * Run with: npx tsx src/__tests__/sop-routing.test.ts
 */

import { computeSops, extractSOPInputFromAnswers, ALL_SOPS } from '../lib/sopRouting/computeSops';
import { generateWorkOrder } from '../lib/sopRouting/workOrders';

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
// Test: Big 5 Routing Rules
// =============================================
console.log('\n--- Big 5 SOP Routing ---');

// All yes → no SOPs
const allYes = computeSops({
  big5: {
    own_domain: 'yes',
    control_dns: 'yes',
    is_wordpress: 'yes',
    own_written_content: 'yes',
    own_license_images: 'yes',
  },
  migration: { needs_migration: 'no' },
});
assert(allYes.required_sops.length === 0, 'All yes → no SOPs required');

// Own domain = no → Registrar Migration SOP
const noDomain = computeSops({
  big5: { own_domain: 'no', control_dns: 'yes', is_wordpress: 'yes', own_written_content: 'yes', own_license_images: 'yes' },
  migration: { needs_migration: 'no' },
});
assert(noDomain.required_sops.includes(ALL_SOPS.REGISTRAR_MIGRATION), 'No domain → Registrar Migration SOP');
assert(noDomain.required_sops.length === 1, 'Only 1 SOP for domain-only issue');

// Control DNS = no → DNS Migration SOP
const noDns = computeSops({
  big5: { own_domain: 'yes', control_dns: 'no', is_wordpress: 'yes', own_written_content: 'yes', own_license_images: 'yes' },
  migration: { needs_migration: 'no' },
});
assert(noDns.required_sops.includes(ALL_SOPS.DNS_MIGRATION), 'No DNS → DNS Migration SOP');

// Not WordPress → Website Rebuild SOP
const noWP = computeSops({
  big5: { own_domain: 'yes', control_dns: 'yes', is_wordpress: 'no', own_written_content: 'yes', own_license_images: 'yes' },
  migration: { needs_migration: 'no' },
});
assert(noWP.required_sops.includes(ALL_SOPS.WEBSITE_REBUILD), 'Not WordPress → Website Rebuild SOP');

// No written content → Written Content Replacement SOP
const noContent = computeSops({
  big5: { own_domain: 'yes', control_dns: 'yes', is_wordpress: 'yes', own_written_content: 'no', own_license_images: 'yes' },
  migration: { needs_migration: 'no' },
});
assert(noContent.required_sops.includes(ALL_SOPS.WRITTEN_CONTENT_REPLACEMENT), 'No content → Written Content Replacement SOP');

// No images → Image Replacement SOP
const noImages = computeSops({
  big5: { own_domain: 'yes', control_dns: 'yes', is_wordpress: 'yes', own_written_content: 'yes', own_license_images: 'no' },
  migration: { needs_migration: 'no' },
});
assert(noImages.required_sops.includes(ALL_SOPS.IMAGE_REPLACEMENT), 'No images → Image Replacement SOP');

// =============================================
// Test: Migration Routing
// =============================================
console.log('\n--- Migration Routing ---');

const needsMigration = computeSops({
  big5: { own_domain: 'yes', control_dns: 'yes', is_wordpress: 'yes', own_written_content: 'yes', own_license_images: 'yes' },
  migration: { needs_migration: 'yes' },
});
assert(needsMigration.required_sops.includes(ALL_SOPS.DNS_ACCESS), 'Migration → DNS Access SOP');
assert(needsMigration.required_sops.includes(ALL_SOPS.HOSTING_MIGRATION), 'Migration → Hosting Migration SOP');
assert(needsMigration.required_sops.length === 2, '2 SOPs for migration');

// =============================================
// Test: All No → Maximum SOPs
// =============================================
console.log('\n--- All No (worst case) ---');

const allNo = computeSops({
  big5: { own_domain: 'no', control_dns: 'no', is_wordpress: 'no', own_written_content: 'no', own_license_images: 'no' },
  migration: { needs_migration: 'yes' },
});
assert(allNo.required_sops.length === 7, 'All no + migration → 7 SOPs');
assert(allNo.required_sops.includes(ALL_SOPS.REGISTRAR_MIGRATION), 'Includes Registrar Migration');
assert(allNo.required_sops.includes(ALL_SOPS.DNS_MIGRATION), 'Includes DNS Migration');
assert(allNo.required_sops.includes(ALL_SOPS.WEBSITE_REBUILD), 'Includes Website Rebuild');
assert(allNo.required_sops.includes(ALL_SOPS.WRITTEN_CONTENT_REPLACEMENT), 'Includes Content Replacement');
assert(allNo.required_sops.includes(ALL_SOPS.IMAGE_REPLACEMENT), 'Includes Image Replacement');
assert(allNo.required_sops.includes(ALL_SOPS.DNS_ACCESS), 'Includes DNS Access');
assert(allNo.required_sops.includes(ALL_SOPS.HOSTING_MIGRATION), 'Includes Hosting Migration');

// =============================================
// Test: CMS Inference from detected_cms
// =============================================
console.log('\n--- CMS Inference ---');

const wpDetected = computeSops({
  big5: { own_domain: 'yes', control_dns: 'yes', is_wordpress: null, own_written_content: 'yes', own_license_images: 'yes' },
  migration: { needs_migration: 'no' },
  detected_cms: 'WordPress',
});
assert(!wpDetected.required_sops.includes(ALL_SOPS.WEBSITE_REBUILD), 'WordPress detected → no rebuild SOP');
assert(wpDetected.big5_summary.is_wordpress.answer === 'yes', 'WordPress inferred as yes');

const squarespaceDetected = computeSops({
  big5: { own_domain: 'yes', control_dns: 'yes', is_wordpress: null, own_written_content: 'yes', own_license_images: 'yes' },
  migration: { needs_migration: 'no' },
  detected_cms: 'Squarespace',
});
assert(squarespaceDetected.required_sops.includes(ALL_SOPS.WEBSITE_REBUILD), 'Squarespace detected → rebuild SOP');
assert(squarespaceDetected.big5_summary.is_wordpress.answer === 'no', 'Non-WP inferred as no');

// =============================================
// Test: Not Sure values → no SOPs triggered
// =============================================
console.log('\n--- Not Sure handling ---');

const allNotSure = computeSops({
  big5: { own_domain: 'not_sure', control_dns: 'not_sure', is_wordpress: 'not_sure', own_written_content: 'not_sure', own_license_images: 'not_sure' },
  migration: { needs_migration: 'not_sure' },
});
assert(allNotSure.required_sops.length === 0, 'All not_sure → no SOPs triggered');

// =============================================
// Test: Extract from answers
// =============================================
console.log('\n--- Extract from answers ---');

const answers = {
  technical_setup: { website_platform: 'wordpress', owns_domain: 'yes', controls_dns: 'no' },
  pre_contract_readiness: { own_written_content: 'no', own_license_images: 'yes', needs_website_migration: 'yes' },
};

const input = extractSOPInputFromAnswers(answers);
assert(input.big5.own_domain === 'yes', 'Extracts own_domain from technical_setup');
assert(input.big5.control_dns === 'no', 'Extracts control_dns from technical_setup');
assert(input.big5.is_wordpress === 'yes', 'Infers wordpress from platform field');
assert(input.big5.own_written_content === 'no', 'Extracts own_written_content');
assert(input.migration.needs_migration === 'yes', 'Extracts migration answer');

// =============================================
// Test: Work Order Generation
// =============================================
console.log('\n--- Work Order Generation ---');

const noSopTasks = generateWorkOrder([]);
assert(noSopTasks.length === 8, 'No SOPs → 8 default onboarding tasks');
assert(noSopTasks.every(t => t.category === 'onboarding'), 'All tasks are onboarding category');
assert(noSopTasks.every(t => t.status === 'pending'), 'All tasks start as pending');

const withSopTasks = generateWorkOrder([ALL_SOPS.WEBSITE_REBUILD, ALL_SOPS.DNS_MIGRATION]);
assert(withSopTasks.length === 10, '2 SOPs → 8 onboarding + 2 SOP tasks');
assert(withSopTasks.filter(t => t.category === 'sop').length === 2, '2 SOP category tasks');

// Check specific owners
const gtmTask = noSopTasks.find(t => t.key === 'gtm');
assert(gtmTask?.owner === 'Keith', 'GTM task assigned to Keith');

const hostingTask = noSopTasks.find(t => t.key === 'hosting_stack');
assert(hostingTask?.owner === 'Predrag', 'Hosting Stack assigned to Predrag');

const devOpsTask = noSopTasks.find(t => t.key === 'dev_ops');
assert(devOpsTask?.owner === 'Keith and Bogdan', 'Dev Ops assigned to Keith and Bogdan');

// =============================================
// Test: Explanations present for each SOP
// =============================================
console.log('\n--- Explanations ---');

const allNoResult = computeSops({
  big5: { own_domain: 'no', control_dns: 'no', is_wordpress: 'no', own_written_content: 'no', own_license_images: 'no' },
  migration: { needs_migration: 'yes' },
});
for (const sop of allNoResult.required_sops) {
  assert(!!allNoResult.explanations[sop], `Explanation exists for: ${sop}`);
}

// =============================================
// Summary
// =============================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
