// Run: npx tsx src/lib/onboarding/gbp-normalise.test.ts
import {
  dedupeGbpLocations,
  gbpDedupeKey,
  normaliseSeoTargetingAnswers,
} from './gbp-normalise';

function assert(cond: boolean, label: string) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

const j = (o: unknown) => JSON.stringify(o);

console.log('--- dedupeGbpLocations ---');

// Exact-duplicate shortlinks collapse to one; order preserved.
const dups = dedupeGbpLocations([
  { url: 'https://maps.app.goo.gl/3EZStwoEJbGSpyVK8' },
  { url: 'https://maps.app.goo.gl/3EZStwoEJbGSpyVK8' },
  { url: 'https://maps.app.goo.gl/OTHERcode99' },
]);
assert(dups.length === 2, 'duplicate shortlink collapsed (3 → 2)');
assert(dups[0].url === 'https://maps.app.goo.gl/3EZStwoEJbGSpyVK8', 'first-seen order preserved');

// Query/utm noise on full Google URLs collapses (same host+path).
const utm = dedupeGbpLocations([
  { url: 'https://www.google.com/maps/place/Clinic/@41.8,-87.7,15z?entry=ttu' },
  { url: 'https://www.google.com/maps/place/Clinic/@41.8,-87.7,15z?hl=en&g_ep=abc' },
]);
assert(utm.length === 1, 'same place, different query → deduped to 1');

// Blank / malformed rows dropped; bare strings + {url} objects both accepted.
const mixed = dedupeGbpLocations([
  'https://g.page/realone',
  { url: '   ' },
  { url: '' },
  {},
  null,
  'https://g.page/realone', // dup of the string above
  { url: 'https://example.com/x/' }, // trailing slash
  { url: 'https://example.com/x' }, // same as above sans slash
]);
assert(mixed.length === 2, 'blanks/junk dropped, string+object dedupe, trailing slash normalised (→ 2)');
assert(mixed.every((r) => typeof r.url === 'string' && r.url.length > 0), 'all rows are { url } strings');

// Non-empty array of all-blank rows → [].
assert(dedupeGbpLocations([{ url: '' }, { url: '  ' }, {}]).length === 0, 'all-blank → []');
assert(dedupeGbpLocations('not-an-array' as unknown).length === 0, 'non-array → []');

console.log('\n--- gbpDedupeKey ---');
assert(
  gbpDedupeKey('https://WWW.Google.com/maps/place/X/') === gbpDedupeKey('https://google.com/maps/place/X?utm=1'),
  'host-case + www + trailing slash + query all normalised to same key',
);
assert(
  gbpDedupeKey('https://maps.app.goo.gl/AAA') !== gbpDedupeKey('https://maps.app.goo.gl/BBB'),
  'distinct shortlink codes → distinct keys',
);

console.log('\n--- normaliseSeoTargetingAnswers ---');

// has_gbp gate: anything but "yes" forces [].
const gatedNo = normaliseSeoTargetingAnswers({
  has_gbp: 'no',
  gbp_locations: [{ url: 'https://g.page/x' }],
  main_geographical_areas: 'Chicago',
});
assert(j(gatedNo.gbp_locations) === '[]', 'has_gbp="no" → gbp_locations []');
assert(gatedNo.main_geographical_areas === 'Chicago', 'other answers preserved');

const gatedNotSure = normaliseSeoTargetingAnswers({ has_gbp: 'not_sure', gbp_locations: [{ url: 'https://g.page/x' }] });
assert(j(gatedNotSure.gbp_locations) === '[]', 'has_gbp="not_sure" → []');

// has_gbp="yes" → dedupe applied.
const yes = normaliseSeoTargetingAnswers({
  has_gbp: 'yes',
  gbp_locations: [
    { url: 'https://maps.app.goo.gl/dup' },
    { url: 'https://maps.app.goo.gl/dup' },
    { url: '' },
  ],
});
assert(Array.isArray(yes.gbp_locations) && (yes.gbp_locations as unknown[]).length === 1, 'has_gbp="yes" dedupes + drops blank (→ 1)');

// Does not mutate the input object.
const input = { has_gbp: 'no', gbp_locations: [{ url: 'https://g.page/x' }] };
normaliseSeoTargetingAnswers(input);
assert((input.gbp_locations as unknown[]).length === 1, 'input object not mutated');

console.log('\n=========================================');
console.log(`  ${process.exitCode !== 1 ? 'ALL TESTS PASS' : 'ONE OR MORE TESTS FAILED'}`);
console.log('=========================================');
