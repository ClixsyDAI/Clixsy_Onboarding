// =============================================================
// Extraction sanitisers — location + business summary
// =============================================================
//
// Stage 11 / Fix 3. The Firecrawl LLM /extract pipeline frequently
// returned sentence-fragment garbage as primary_market entries and
// marketing-consent / terms-of-service boilerplate as business_summary.
// Real-world observed values on belred.com:
//
//   primary_market: ["the Pacific Northwest for",
//                    "and pay all necessary taxes and fees required to
//                    work in those areas"]
//   business_summary: "Belred focuses on History, Awards and Certifications,
//                      and Core Values serving the Pacific Northwest for and
//                      and pay all necessary taxes and fees required to work in"
//
// These leaked into the welcome wizard, the admin Create analysis
// panel, and the Step 3 WHAT WE FOUND panel. Both sanitisers run
// AFTER the LLM extract step and drop low-quality candidates; the
// business_summary one additionally provides a generic vertical-
// appropriate fallback when everything gets rejected so the panel
// always has something readable.

// ---------------------------------------------------------------
// Location sanitiser
// ---------------------------------------------------------------

const MAX_LOCATION_LENGTH = 30;

// Words that strongly suggest a sentence-fragment rather than a place
// name. Lowercased; substring match.
const LOCATION_REJECT_WORDS = [
  'pay', 'tax', 'taxes',
  'required to', 'compliance', 'license', 'licensed', 'regulation',
  'permit', 'permits',
  // Stage 12 / Fix 4: user-type descriptors. Real-world failure on
  // reimerhvac.com — "local homeowners since" / "locals" surfaced as
  // location pills. A candidate containing any of these is a sentence
  // fragment about the audience, not a place name.
  'homeowners', 'residents', 'customers', 'clients', 'businesses',
];

// Trailing prepositions — if a candidate ENDS with one of these (after
// whitespace), it's almost certainly a mid-sentence fragment.
const TRAILING_PREPOSITIONS = ['for', 'to', 'in', 'of', 'with', 'by', 'and', 'or', 'on', 'at'];

// Stage 12 / Fix 4: US state + DC + Canadian-province abbreviations.
// Used to whitelist short comma-segments ("Buffalo, NY" passes; "Buffalo,
// Ro" fails because "Ro" isn't on this list). Lowercased — comparison
// is case-insensitive on the comma segments below.
const VALID_REGION_ABBREVS = new Set([
  // US states
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga',
  'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
  'dc',
  // Canadian provinces / territories
  'ab', 'bc', 'mb', 'nb', 'nl', 'ns', 'nt', 'nu', 'on', 'pe', 'qc', 'sk', 'yt',
]);

// Stage 12 / Fix 4: short-word whitelist for in-name abbreviations
// — "St. Louis", "Mt Vernon", "Ft Worth" should pass even though "St"
// / "Mt" / "Ft" are 2 chars. Case-insensitive; punctuation stripped
// for the comparison.
const SHORT_WORD_WHITELIST = new Set(['st', 'mt', 'ft']);

/**
 * Hygiene check on a single primary_market / location candidate.
 * Returns true if the string looks like a real place name (city, region,
 * county, state, country) and false if it looks like a sentence fragment
 * or boilerplate substring.
 */
export function passesLocationHygiene(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOCATION_LENGTH) return false;

  const lc = trimmed.toLowerCase();

  // Sentence fragments often start with the article "the" — real place
  // names don't ("The Bronx" being the rare exception, but it's a
  // borough not a service area in any of our fixture verticals).
  if (lc.startsWith('the ')) return false;

  // Stage 12 / Fix 4: "local " as a leading word almost always introduces
  // descriptive copy about the audience, not a place name. Reimer scrape
  // surfaced "local homeowners since" / "local residents in" as location
  // pills. "Local" alone is not a city/region.
  if (lc.startsWith('local ')) return false;

  // Substring rejects — any of the boilerplate license/tax/regulation
  // words or user-type descriptors in the candidate kills it.
  for (const w of LOCATION_REJECT_WORDS) {
    if (lc.includes(w)) return false;
  }

  // Trailing preposition → mid-sentence fragment. Skip this check when
  // the trailing token is preceded by a comma — that pattern is always
  // "City, <state/province abbrev>", and some abbreviations happen to
  // collide with preposition words ("ON" for Ontario vs "on" the prep,
  // "AT" if it ever lands here, etc.). The comma-segment check below
  // handles those cases properly.
  for (const prep of TRAILING_PREPOSITIONS) {
    if (lc === prep) return false;
    if (lc.endsWith(` ${prep}`) && !lc.endsWith(`, ${prep}`)) return false;
  }

  // " and " as a connector word inside the candidate suggests it's a
  // sentence fragment ("services and locations"). Real multi-word
  // place names don't use "and" as a connector (no "Smith and Jones,
  // OH"). Allow it only when the whole candidate is short and ends
  // with a proper noun pattern — but the easier guardrail is: reject
  // any candidate containing " and " as a standalone token.
  if (/\s+and\s+/i.test(trimmed)) return false;

  // Stage 12 / Fix 4: comma-segment validation. Real failure on Reimer
  // — "Buffalo, Ro" came through, truncated mid-state-name. Whitelist
  // approach: each comma segment beyond the first that's 1-3 chars
  // must be a real US state / Canadian province abbreviation. Longer
  // segments aren't checked here (handled by the word-length rule
  // below).
  const commaSegments = trimmed.split(',').map((s) => s.trim());
  if (commaSegments.length > 1) {
    for (let i = 1; i < commaSegments.length; i++) {
      const seg = commaSegments[i];
      if (seg.length === 0) return false;
      if (seg.length <= 3 && !VALID_REGION_ABBREVS.has(seg.toLowerCase())) {
        return false;
      }
    }
  }

  // Stage 12 / Fix 4: 1-2 char word check. Same Reimer failure shape
  // — "locals, ou" had "ou" as a truncated word. Walk every whitespace-
  // separated token in the candidate (ignoring commas/dots/etc.); any
  // token that's 1-2 chars must be on the SHORT_WORD_WHITELIST (St,
  // Mt, Ft) or a state abbreviation. Otherwise it's mid-word noise.
  const tokens = trimmed.split(/[\s.,]+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok.length <= 2) {
      const tokLc = tok.toLowerCase().replace(/\W/g, '');
      if (
        tokLc.length > 0 &&
        !SHORT_WORD_WHITELIST.has(tokLc) &&
        !VALID_REGION_ABBREVS.has(tokLc)
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Filter an array of LLM-extracted location candidates down to the ones
 * that pass hygiene. Order preserved.
 */
export function sanitiseLocations(candidates: readonly string[]): string[] {
  return candidates.filter((c) => passesLocationHygiene(c));
}

// ---------------------------------------------------------------
// Business summary sanitiser
// ---------------------------------------------------------------

// Phrases / substrings that flag a summary candidate as
// terms-of-service / marketing-consent / privacy boilerplate rather
// than an actual business description. Lowercased. Stage 12 / Fix 3
// extended this with promotional/coupon disclaimers after the Reimer
// HVAC scrape pulled in "Cannot be combined with other offers or
// memberships. Must be presented at time of proposal. Some exclusions
// may apply. Offers expire on 6/30/26" as the business summary.
const SUMMARY_REJECT_PHRASES = [
  // Original Stage 11 set — marketing-consent / privacy / TOS
  'consent',
  'agree to receive',
  'marketing and promotional',
  'promotional texts',
  'promotional calls',
  'privacy policy',
  'terms of service',
  'terms and conditions',
  'data rates',
  'opt out',
  'opt-out',
  'stop to opt',
  'reply stop',
  'by checking this box',
  'by clicking this box',
  'msg & data',
  'message and data',
  // Stage 12 / Fix 3 — promotional / coupon disclaimer copy
  'cannot be combined',
  'with other offers',
  'memberships',
  'presented at time',
  'exclusions may apply',
  'exclusions apply',
  'offers expire',
  'offer expires',
  'valid at participating',
  'limited time',
  'while supplies last',
  'see store for details',
  'see dealer for details',
  'restrictions apply',
  'void where prohibited',
  'additional terms',
];

const MIN_SUMMARY_LENGTH = 30;
const MAX_SUMMARY_LENGTH = 400;

/**
 * Hygiene check on a candidate business_summary. Returns true if the
 * text reads like a description of what the business does and false if
 * it looks like consent boilerplate or another flavour of legal copy.
 */
export function passesSummaryHygiene(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (trimmed.length < MIN_SUMMARY_LENGTH || trimmed.length > MAX_SUMMARY_LENGTH) {
    return false;
  }

  const lc = trimmed.toLowerCase();
  for (const phrase of SUMMARY_REJECT_PHRASES) {
    if (lc.includes(phrase)) return false;
  }

  // Heuristic: a summary that's > 50% conjunction-and-fragment ("Belred
  // focuses on … serving the Pacific Northwest for and and pay all
  // necessary taxes…") tends to have repeated " and " patterns. Reject
  // anything with "and and" or three+ " and "s in a 200-char window.
  if (/\band\s+and\b/i.test(trimmed)) return false;
  const andCount = (trimmed.match(/\band\b/gi) ?? []).length;
  if (trimmed.length < 200 && andCount >= 4) return false;

  return true;
}

/**
 * Generic vertical-appropriate fallback for business_summary when the
 * LLM result fails hygiene and we have nothing else to fall back to.
 * Better to ship "[Brand] is a [vertical] business." than the consent
 * boilerplate.
 */
export function genericSummaryFallback(brandName: string, vertical?: 'law_firm' | 'home_services'): string {
  const safeBrand = brandName.trim() || 'This business';
  if (vertical === 'home_services') {
    return `${safeBrand} is a home services business.`;
  }
  if (vertical === 'law_firm') {
    return `${safeBrand} is a law firm.`;
  }
  return `${safeBrand} is a local business.`;
}

/**
 * Top-level sanitiser for business_summary. If the LLM-produced summary
 * passes hygiene, returns it. Otherwise returns the generic fallback so
 * downstream surfaces always have SOMETHING readable rather than a
 * paragraph of consent boilerplate or an empty string.
 */
export function sanitiseBusinessSummary(
  candidate: string | undefined,
  brandName: string,
  vertical?: 'law_firm' | 'home_services',
): string {
  if (passesSummaryHygiene(candidate)) {
    return (candidate as string).trim();
  }
  return genericSummaryFallback(brandName, vertical);
}
