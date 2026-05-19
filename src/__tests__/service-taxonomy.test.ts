/**
 * Service-taxonomy unit tests.
 *
 * Run with: npx tsx src/__tests__/service-taxonomy.test.ts
 *
 * Covers:
 *   - getServicesForTrade / getTradeForService correctness
 *   - pruneOrphanServices drops services whose trade was unticked
 *   - getAllTradesWithSelections builds the render-ready view
 *   - matchScrapedServiceToTaxonomy handles exact + fuzzy labels
 *   - graceful no-op behaviour on unknown IDs
 */

import {
  HOME_SERVICES_TAXONOMY,
  ALL_TRADE_IDS,
  ALL_SERVICE_IDS,
  getServicesForTrade,
  getTradeForService,
  pruneOrphanServices,
  getAllTradesWithSelections,
  matchScrapedServiceToTaxonomy,
} from '../lib/onboarding/service-taxonomy';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    console.error(`  FAIL  ${message}`);
  }
}

console.log('\n--- ALL_TRADE_IDS + ALL_SERVICE_IDS ---');
assert(ALL_TRADE_IDS.length === 6, 'six trades declared');
assert(
  ALL_TRADE_IDS.includes('hvac') &&
    ALL_TRADE_IDS.includes('plumbing') &&
    ALL_TRADE_IDS.includes('electrical') &&
    ALL_TRADE_IDS.includes('pest_control') &&
    ALL_TRADE_IDS.includes('roofing') &&
    ALL_TRADE_IDS.includes('garage_door'),
  'all six trade IDs present'
);
const hvacServiceCount = HOME_SERVICES_TAXONOMY.hvac.services.length;
const plumbingServiceCount = HOME_SERVICES_TAXONOMY.plumbing.services.length;
const expectedTotal = ALL_TRADE_IDS.reduce((n, id) => n + HOME_SERVICES_TAXONOMY[id].services.length, 0);
assert(ALL_SERVICE_IDS.length === expectedTotal, 'ALL_SERVICE_IDS length matches sum of per-trade service counts');
assert(hvacServiceCount === 10, 'HVAC has 10 services');
assert(plumbingServiceCount === 10, 'Plumbing has 10 services');

console.log('\n--- getServicesForTrade ---');
assert(getServicesForTrade('hvac').length === hvacServiceCount, 'hvac returns its service list');
assert(getServicesForTrade('garage_door').length === 5, 'garage_door has 5 services');
assert(getServicesForTrade('nonsense').length === 0, 'unknown trade returns [] (no throw)');

console.log('\n--- getTradeForService ---');
assert(getTradeForService('hvac.ac_repair') === 'hvac', 'hvac.ac_repair → hvac');
assert(getTradeForService('plumbing.tankless') === 'plumbing', 'plumbing.tankless → plumbing');
assert(getTradeForService('garage.opener') === 'garage_door', 'garage.opener → garage_door (handles prefix-trade name mismatch)');
assert(getTradeForService('pest.termite') === 'pest_control', 'pest.termite → pest_control (handles prefix-trade name mismatch)');
assert(getTradeForService('hvac.does_not_exist') === null, 'hvac prefix but unknown service → null');
assert(getTradeForService('not-a-real-id') === null, 'completely unknown ID → null');
assert(getTradeForService('') === null, 'empty string → null');

console.log('\n--- pruneOrphanServices ---');
{
  const trades = ['hvac', 'plumbing'];
  const services = ['hvac.ac_repair', 'plumbing.tankless', 'electrical.panel_upgrade', 'unknown.id'];
  const result = pruneOrphanServices(trades, services);
  console.log('   result ->', result);
  assert(result.length === 2, 'two services kept');
  assert(result.includes('hvac.ac_repair'), 'hvac.ac_repair kept (hvac selected)');
  assert(result.includes('plumbing.tankless'), 'plumbing.tankless kept');
  assert(!result.includes('electrical.panel_upgrade'), 'electrical service purged (trade unticked)');
  assert(!result.includes('unknown.id'), 'unknown ID purged');
}
{
  // Empty trades → everything pruned
  const result = pruneOrphanServices([], ['hvac.ac_repair']);
  assert(result.length === 0, 'no trades selected → all services purged');
}
{
  // Empty services → empty result
  const result = pruneOrphanServices(['hvac'], []);
  assert(result.length === 0, 'no services selected → empty result');
}

console.log('\n--- getAllTradesWithSelections ---');
{
  const view = getAllTradesWithSelections(
    ['hvac', 'electrical'],
    ['hvac.ac_repair', 'hvac.furnace_repair', 'electrical.panel_upgrade']
  );
  console.log('   view ->', JSON.stringify(view.map((v) => ({ trade: v.tradeId, n: v.selectedServiceIds.length }))));
  assert(view.length === 2, 'two trades in expanded view');
  assert(view[0].tradeId === 'hvac', 'hvac first (declaration order)');
  assert(view[0].selectedServiceIds.length === 2, 'hvac has 2 ticked services');
  assert(view[1].tradeId === 'electrical', 'electrical second');
  assert(view[1].selectedServiceIds.length === 1, 'electrical has 1 ticked service');
  assert(view[0].services === HOME_SERVICES_TAXONOMY.hvac.services, 'services list is the canonical taxonomy ref');
}
{
  // Unknown trade ID is silently skipped
  const view = getAllTradesWithSelections(['hvac', 'fake_trade'], ['hvac.ac_repair']);
  assert(view.length === 1, 'unknown trade silently dropped from view');
}

console.log('\n--- matchScrapedServiceToTaxonomy ---');
{
  assert(matchScrapedServiceToTaxonomy('A/C Repair') === 'hvac.ac_repair', 'exact label "A/C Repair"');
  assert(matchScrapedServiceToTaxonomy('A/C repair') === 'hvac.ac_repair', 'case-insensitive');
  assert(matchScrapedServiceToTaxonomy('ac repair') === 'hvac.ac_repair', 'punctuation-insensitive');
  assert(matchScrapedServiceToTaxonomy('A/C Install') === 'hvac.ac_install', 'A/C Install → hvac.ac_install');
  assert(matchScrapedServiceToTaxonomy('Furnace Repair') === 'hvac.furnace_repair', 'Furnace Repair → hvac.furnace_repair');
  // Fuzzy / substring matching
  const miniSplit = matchScrapedServiceToTaxonomy('Mini-Split Service');
  assert(miniSplit === 'hvac.mini_split', `mini-split fuzzy match (got ${miniSplit})`);
  // Junk → null
  assert(matchScrapedServiceToTaxonomy('') === null, 'empty string → null');
  assert(matchScrapedServiceToTaxonomy('ab') === null, 'too-short string → null');
  assert(matchScrapedServiceToTaxonomy('completely unrelated phrase about astronomy') === null, 'unmatched phrase → null');
}

console.log(`\n=========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`=========================================`);
if (failed > 0) process.exit(1);
