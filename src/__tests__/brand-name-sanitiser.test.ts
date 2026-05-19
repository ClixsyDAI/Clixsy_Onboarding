import {
  sanitiseBrandName,
  passesBrandHygiene,
  domainBrandName,
} from '../lib/siteIntelligence/brand-name-sanitiser';

function assert(cond: boolean, label: string) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

console.log('--- passesBrandHygiene ---');
// Should PASS (clean brand labels)
assert(passesBrandHygiene('BelRed'), 'BelRed passes');
assert(passesBrandHygiene('ARCO'), 'ARCO passes');
assert(passesBrandHygiene('Good Guys Injury Law'), 'Good Guys Injury Law passes (1 generic hit, short)');
assert(passesBrandHygiene('Jungle Law'), 'Jungle Law passes');
assert(passesBrandHygiene('Smith & Associates'), 'Smith & Associates passes');
assert(passesBrandHygiene('Smith, Jones & Associates'), 'Smith, Jones & Associates passes (2 clauses ok)');
assert(passesBrandHygiene('ARCO Comfort Air'), 'ARCO Comfort Air passes');
// Should FAIL (meta-title shapes the operator reported)
assert(!passesBrandHygiene('BelRed Heating, Cooling, Plumbing & Electrical Services in Seattle, WA'), 'BelRed meta-title rejected (length + clauses + state)');
assert(!passesBrandHygiene('HVAC, Plumbing & Electrical Services in Ohio'), 'goarco meta-title rejected (clauses + Ohio)');
assert(!passesBrandHygiene('Utah Personal Injury Attorney'), 'Utah Personal Injury Attorney rejected (Utah state + attorney generic)');
assert(!passesBrandHygiene(''), 'empty string rejected');
assert(!passesBrandHygiene(undefined), 'undefined rejected');
assert(!passesBrandHygiene(null), 'null rejected');
assert(!passesBrandHygiene('A really really really really really really really long brand name'), 'overlong rejected');

console.log('\n--- domainBrandName ---');
assert(domainBrandName('https://www.belred.com') === 'Belred', 'belred.com → Belred');
assert(domainBrandName('https://goarco.com') === 'Goarco', 'goarco.com → Goarco');
assert(domainBrandName('https://junglelaw.com') === 'Junglelaw', 'junglelaw.com → Junglelaw');
assert(domainBrandName('https://www.good-guys-injury-law.com') === 'Good Guys Injury Law', 'kebab-case domain title-cased');
assert(domainBrandName('https://example.co.uk') === 'Example', 'co.uk handled');
assert(domainBrandName('not-a-url') === 'Not A Url', 'non-URL trimmed + title-cased');

console.log('\n--- sanitiseBrandName: real fixtures ---');

// Fixture 1: Belred. Raw LLM result is meta-title shape. og:site_name
// could be cleaner OR absent. Title segments have nothing useful (no
// separators). Domain fallback should yield "Belred".
const belredNoOg = sanitiseBrandName({
  rawCandidate: 'BelRed Heating, Cooling, Plumbing & Electrical Services in Seattle, WA',
  pageTitle: 'BelRed Heating, Cooling, Plumbing & Electrical Services in Seattle, WA',
  websiteUrl: 'https://www.belred.com',
});
console.log(`  Belred (no og:site_name) → "${belredNoOg}"`);
assert(belredNoOg === 'Belred', 'Belred falls back to domain');

const belredWithOg = sanitiseBrandName({
  rawCandidate: 'BelRed Heating, Cooling, Plumbing & Electrical Services in Seattle, WA',
  ogSiteName: 'BelRed',
  pageTitle: 'BelRed Heating, Cooling, Plumbing & Electrical Services in Seattle, WA',
  websiteUrl: 'https://www.belred.com',
});
console.log(`  Belred (og:site_name = "BelRed") → "${belredWithOg}"`);
assert(belredWithOg === 'BelRed', 'Belred picks up og:site_name when present');

// Fixture 2: goarco. Raw is meta-title. og:site_name might be "ARCO" if
// well-configured. Title has no useful separator. Domain yields "Goarco".
const goarcoNoOg = sanitiseBrandName({
  rawCandidate: 'HVAC, Plumbing & Electrical Services in Ohio',
  pageTitle: 'HVAC, Plumbing & Electrical Services in Ohio',
  websiteUrl: 'https://goarco.com',
});
console.log(`  goarco (no og:site_name) → "${goarcoNoOg}"`);
assert(goarcoNoOg === 'Goarco', 'goarco falls back to domain');

const goarcoWithOg = sanitiseBrandName({
  rawCandidate: 'HVAC, Plumbing & Electrical Services in Ohio',
  ogSiteName: 'ARCO Comfort Air',
  pageTitle: 'HVAC, Plumbing & Electrical Services in Ohio',
  websiteUrl: 'https://goarco.com',
});
console.log(`  goarco (og:site_name = "ARCO Comfort Air") → "${goarcoWithOg}"`);
assert(goarcoWithOg === 'ARCO Comfort Air', 'goarco picks up og:site_name');

// Fixture 3: Good Guys Injury Law. Title has the brand in the LAST
// segment after " - ". Should be picked up by title-segment fallback.
const goodGuysFromTitle = sanitiseBrandName({
  rawCandidate: 'Utah Personal Injury Attorney',
  pageTitle: 'Utah Personal Injury Attorney - Good Guys Injury Law',
  websiteUrl: 'https://goodguysinjurylaw.com',
});
console.log(`  Good Guys (rawCandidate junk, last title segment clean) → "${goodGuysFromTitle}"`);
assert(goodGuysFromTitle === 'Good Guys Injury Law', 'Good Guys picked up from second title segment');

// Edge case: clean raw candidate is preferred over every fallback.
const cleanRawWins = sanitiseBrandName({
  rawCandidate: 'Jungle Law',
  ogSiteName: 'Some Other Name',
  pageTitle: 'Jungle Law - Personal Injury Attorneys',
  websiteUrl: 'https://junglelaw.com',
});
console.log(`  Clean raw wins → "${cleanRawWins}"`);
assert(cleanRawWins === 'Jungle Law', 'Clean raw candidate wins over fallbacks');

// Edge case: every signal is junk → domain fallback always returns SOMETHING.
const allJunk = sanitiseBrandName({
  rawCandidate: 'HVAC, Plumbing & Electrical Services in Ohio',
  ogSiteName: 'Best HVAC Services in Cleveland, Ohio',
  pageTitle: 'HVAC, Plumbing & Electrical Services',
  h1: 'Welcome to our HVAC Services',
  websiteUrl: 'https://ohiohvacexperts.com',
});
console.log(`  All-junk signals → "${allJunk}"`);
assert(allJunk === 'Ohiohvacexperts', 'All-junk falls through to domain');

// Edge case: no signals at all → still returns domain.
const onlyUrl = sanitiseBrandName({ websiteUrl: 'https://example.com' });
console.log(`  Only websiteUrl → "${onlyUrl}"`);
assert(onlyUrl === 'Example', 'Empty inputs except URL still produces domain-based brand');

console.log('\n=========================================');
const passed = process.exitCode !== 1;
console.log(`  ${passed ? 'ALL TESTS PASS' : 'ONE OR MORE TESTS FAILED'}`);
console.log('=========================================');
