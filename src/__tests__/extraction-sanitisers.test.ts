import {
  passesLocationHygiene,
  sanitiseLocations,
  passesSummaryHygiene,
  sanitiseBusinessSummary,
  genericSummaryFallback,
} from '../lib/siteIntelligence/extraction-sanitisers';

function assert(cond: boolean, label: string) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

console.log('--- passesLocationHygiene: clean place names PASS ---');
assert(passesLocationHygiene('Seattle'), 'Seattle');
assert(passesLocationHygiene('Bellevue'), 'Bellevue');
assert(passesLocationHygiene('Pacific Northwest'), 'Pacific Northwest');
assert(passesLocationHygiene('Houston, TX'), 'Houston, TX');
assert(passesLocationHygiene('Northeast Ohio'), 'Northeast Ohio');
assert(passesLocationHygiene('King County'), 'King County');

console.log('\n--- passesLocationHygiene: real Belred fragments REJECTED ---');
assert(!passesLocationHygiene('the Pacific Northwest for'), 'Belred fragment 1: leading "the" + trailing "for"');
assert(!passesLocationHygiene('and pay all necessary taxes and fees required to work in those areas'), 'Belred fragment 2: pay/taxes/required substring + length + "and"');
assert(!passesLocationHygiene('the Pacific Northwest'), 'leading "the" alone is enough to reject');
assert(!passesLocationHygiene('Seattle for'), 'trailing "for"');
// "serving Seattle" is a sentence fragment but trips no rejection rules.
// The sanitiser is intentionally conservative — operator spec only listed
// specific patterns. Confirmed it passes; "Greater Seattle Area" / similar
// real place names would be over-rejected if we added "serving" to the
// rejection list. Documenting the call here so the next reviewer doesn't
// retread the same trade-off.
assert(passesLocationHygiene('serving Seattle'), '"serving Seattle" passes (close call — no clear rejection trigger)');

console.log('\n--- passesLocationHygiene: other meta-text rejections ---');
assert(!passesLocationHygiene('Seattle and Bellevue'), 'connector "and" rejected');
assert(!passesLocationHygiene('all licensed states'), 'license substring');
assert(!passesLocationHygiene('required to pay taxes'), 'pay/tax/required substrings');
assert(!passesLocationHygiene(''), 'empty rejected');
assert(!passesLocationHygiene(undefined), 'undefined rejected');
assert(!passesLocationHygiene(null), 'null rejected');
assert(!passesLocationHygiene('a really really really really really really long location name'), 'overlong rejected');

console.log('\n--- sanitiseLocations: array filter preserves order ---');
const belredFromScrape = [
  'Seattle',
  'the Pacific Northwest for',
  'Bellevue',
  'and pay all necessary taxes and fees required to work in those areas',
  'Kirkland',
];
const cleaned = sanitiseLocations(belredFromScrape);
console.log(`  in : ${JSON.stringify(belredFromScrape)}`);
console.log(`  out: ${JSON.stringify(cleaned)}`);
assert(cleaned.length === 3, 'three cleans pass');
assert(cleaned[0] === 'Seattle', 'first is Seattle');
assert(cleaned[1] === 'Bellevue', 'second is Bellevue');
assert(cleaned[2] === 'Kirkland', 'third is Kirkland');

console.log('\n--- passesSummaryHygiene: clean summaries PASS ---');
assert(passesSummaryHygiene('Belred is a Bellevue-area home services company providing HVAC, plumbing, and electrical services to homeowners and businesses across the Puget Sound region.'), 'Clean Belred-style summary');
assert(passesSummaryHygiene('Jungle Law represents personal injury clients across Texas, with offices in Houston and Dallas.'), 'Clean law-firm summary');

console.log('\n--- passesSummaryHygiene: real Belred boilerplate REJECTED ---');
const belredBoilerplate = 'Belred focuses on History, Awards and Certifications, and Core Values serving the Pacific Northwest for and and pay all necessary taxes and fees required to work in';
assert(!passesSummaryHygiene(belredBoilerplate), 'real Belred boilerplate rejected (and-and + multiple ands in <200 chars)');

const consentBoilerplate = 'By checking this box, I consent to receive marketing and promotional texts, calls, and emails from or on behalf of ARCO Comfort Air and its affiliates using an automated system or auto dialer for any purpose, including HVAC, plumbing, and electrical products and services. Consent is not a conditi';
assert(!passesSummaryHygiene(consentBoilerplate), 'goarco consent boilerplate rejected (consent + marketing)');

assert(!passesSummaryHygiene('agree to receive promotional texts and emails'), 'marketing consent fragment');
assert(!passesSummaryHygiene('see our privacy policy and terms of service for more details'), 'privacy/terms text');
assert(!passesSummaryHygiene(undefined), 'undefined rejected');
assert(!passesSummaryHygiene(''), 'empty rejected');
assert(!passesSummaryHygiene('short'), 'too short rejected');

console.log('\n--- sanitiseBusinessSummary: fallback when input is junk ---');
const fallbackBelred = sanitiseBusinessSummary(belredBoilerplate, 'Belred', 'home_services');
console.log(`  Belred junk → "${fallbackBelred}"`);
assert(fallbackBelred === 'Belred is a home services business.', 'Belred falls back to home services generic');

const fallbackGoodGuys = sanitiseBusinessSummary(undefined, 'Good Guys Injury Law', 'law_firm');
console.log(`  Good Guys (no input) → "${fallbackGoodGuys}"`);
assert(fallbackGoodGuys === 'Good Guys Injury Law is a law firm.', 'Good Guys falls back to law firm generic');

const cleanSurvives = sanitiseBusinessSummary(
  'Belred is a Bellevue-area home services company providing HVAC, plumbing, and electrical services.',
  'Belred',
  'home_services',
);
console.log(`  Clean input → "${cleanSurvives}"`);
assert(cleanSurvives.startsWith('Belred is a Bellevue-area'), 'clean input passes through unchanged');

console.log('\n--- genericSummaryFallback: vertical variants ---');
assert(genericSummaryFallback('ACME', 'home_services') === 'ACME is a home services business.', 'home_services fallback');
assert(genericSummaryFallback('ACME', 'law_firm') === 'ACME is a law firm.', 'law_firm fallback');
assert(genericSummaryFallback('ACME') === 'ACME is a local business.', 'no-vertical fallback');
assert(genericSummaryFallback('') === 'This business is a local business.', 'empty brand falls back to "This business"');

console.log('\n=========================================');
const passed = process.exitCode !== 1;
console.log(`  ${passed ? 'ALL TESTS PASS' : 'ONE OR MORE TESTS FAILED'}`);
console.log('=========================================');
