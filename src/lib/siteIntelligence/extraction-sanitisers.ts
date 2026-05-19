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
];

// Trailing prepositions — if a candidate ENDS with one of these (after
// whitespace), it's almost certainly a mid-sentence fragment.
const TRAILING_PREPOSITIONS = ['for', 'to', 'in', 'of', 'with', 'by', 'and', 'or', 'on', 'at'];

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

  // Substring rejects — any of the boilerplate license/tax/regulation
  // words in the candidate kills it.
  for (const w of LOCATION_REJECT_WORDS) {
    if (lc.includes(w)) return false;
  }

  // Trailing preposition → mid-sentence fragment.
  for (const prep of TRAILING_PREPOSITIONS) {
    if (lc.endsWith(` ${prep}`) || lc === prep) return false;
  }

  // " and " as a connector word inside the candidate suggests it's a
  // sentence fragment ("services and locations"). Real multi-word
  // place names don't use "and" as a connector (no "Smith and Jones,
  // OH"). Allow it only when the whole candidate is short and ends
  // with a proper noun pattern — but the easier guardrail is: reject
  // any candidate containing " and " as a standalone token.
  if (/\s+and\s+/i.test(trimmed)) return false;

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
// than an actual business description. Lowercased.
const SUMMARY_REJECT_PHRASES = [
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
