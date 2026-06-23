// =============================================================
// Brand-name sanitiser
// =============================================================
//
// Stage 10 / Fix 1. The Firecrawl LLM /extract result frequently
// returned `business_name` as a meta-title-style sentence instead of
// the short brand label — observed on real onboardings:
//
//   goarco.com         → "HVAC, Plumbing & Electrical Services in Ohio"
//   belred.com         → "BelRed Heating, Cooling, Plumbing & Electrical
//                         Services in Seattle, WA"
//   goodguysinjurylaw  → "Utah Personal Injury Attorney"
//
// Approach: tighter LLM prompt at the source (see firecrawl.ts) PLUS
// this guardrail. The guardrail tries every candidate it can find in
// order of preference, returns the first one that passes hygiene, and
// falls back to the domain root as a last resort.
//
// Hygiene rules are conservative — a string that passes is "almost
// certainly a brand label." Strings that fail aren't necessarily junk;
// they just don't pass the brand-label sniff test (too long, has commas,
// contains 2+ service-category keywords, embeds a US state name, etc.).

export interface SanitiseInputs {
  /** Highest-trust structured source: the "name" of the first
   *  Organization / LocalBusiness / MedicalBusiness / *Business / *Clinic
   *  node found in the homepage's JSON-LD. Populated by the Firecrawl
   *  provider via extractJsonLdName(homepageHtml). */
  jsonLdName?: string;
  /** Whatever the LLM or markdown extractor produced as a brand_name. */
  rawCandidate?: string;
  /** og:site_name tag content if present in the page metadata. */
  ogSiteName?: string;
  /** Full <title> tag content. The sanitiser will try splitting on
   *  separators (`-`, `–`, `—`, `|`, `:`) to find a clean segment. */
  pageTitle?: string;
  /** First H1 on the page if known. */
  h1?: string;
  /** Original URL — used to derive a fallback brand from the domain. */
  websiteUrl: string;
}

// Service-category / qualifier keywords that, when present in
// abundance, strongly suggest a meta-title rather than a brand label.
// Lowercase, no punctuation. Order doesn't matter.
const GENERIC_KEYWORDS = [
  'hvac', 'plumbing', 'electrical', 'heating', 'cooling',
  'air conditioning', 'furnace', 'water heater',
  'attorney', 'attorneys', 'lawyer', 'lawyers',
  'law firm', 'law office', 'law offices',
  'services', 'service', 'repair', 'repairs', 'installation', 'maintenance',
  'roofing', 'pest control', 'garage door', 'garage doors',
];

// US state names + DC. Strings ending or containing " in <state>" almost
// always indicate a meta-title pattern ("HVAC … in Ohio", "… in Seattle, WA").
// We include both the long names and the postal codes so " WA" / " OH"
// pattern hits as well.
const US_STATE_TOKENS = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
];
const US_STATE_POSTALS = [
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id',
  'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms',
  'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok',
  'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv',
  'wi', 'wy', 'dc',
];

const MAX_BRAND_LENGTH = 40;
const MAX_GENERIC_HITS_BEFORE_REJECT = 1;
const MAX_COMMA_CLAUSES_BEFORE_REJECT = 2;

// Single-word LLM junk. When the extractor returns ONE token and that token
// is a common UI / CTA / nav / section word, it is never a brand — this is
// the "Walk" bug (LLM grabbed "Walk" from "Walk-In" homepage copy for
// Midwest Express Clinic). Lowercase, exact single-token match only, so
// real multi-word brands containing these words ("Walk Family Dental") are
// unaffected.
const SINGLE_WORD_STOPWORDS = new Set([
  'walk', 'call', 'click', 'home', 'about', 'contact', 'services', 'service',
  'menu', 'search', 'login', 'book', 'open', 'now', 'here', 'more', 'learn',
  'get', 'view', 'see', 'read', 'welcome', 'hours', 'location', 'locations',
  'directions', 'reviews', 'careers', 'blog', 'news',
]);
// A one-word brand shorter than this is almost certainly noise.
const MIN_SINGLE_WORD_LENGTH = 3;

/**
 * Hygiene check: returns true if `name` looks like a brand label and
 * false if it looks like a meta-title / service-description sentence.
 */
export function passesBrandHygiene(name: string | undefined | null): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BRAND_LENGTH) return false;

  // 3+ comma-separated clauses is the "service A, service B, service C"
  // signature. Two clauses ("Smith, Jones & Associates") can still be a
  // valid brand, so the threshold is > MAX_COMMA_CLAUSES.
  if (trimmed.split(',').length > MAX_COMMA_CLAUSES_BEFORE_REJECT) return false;

  // Single-token guards (the "Walk" bug). A one-word candidate must clear a
  // higher bar: not a UI/CTA stopword, >= 3 chars, and capitalised — real
  // one-word brands render capitalised ("BelRed", "ARCO", "Acme"); an
  // all-lowercase single word is almost always scraped body copy.
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    const token = tokens[0];
    const tokenLc = token.toLowerCase();
    if (SINGLE_WORD_STOPWORDS.has(tokenLc)) return false;
    if (token.length < MIN_SINGLE_WORD_LENGTH) return false;
    if (token === tokenLc) return false; // all-lowercase single word
  }

  const lc = trimmed.toLowerCase();

  // Count generic-keyword hits. Multiple service category mentions in a
  // single string strongly suggests a service-line listing rather than
  // a brand name. "Smith Plumbing" has 1 hit and passes; "HVAC, Plumbing
  // & Electrical Services" has 4 and fails.
  let genericHits = 0;
  for (const kw of GENERIC_KEYWORDS) {
    if (lc.includes(kw)) {
      genericHits++;
      if (genericHits > MAX_GENERIC_HITS_BEFORE_REJECT) return false;
    }
  }

  // State names in any of: " in <state>", trailing " <state>", or as a
  // leading prefix ("Utah Personal Injury Attorney"). All three are dead
  // giveaways for meta-title / service-category-with-geo shapes — the
  // brand label itself almost never starts with a US state name.
  for (const state of US_STATE_TOKENS) {
    if (
      lc.includes(` in ${state}`) ||
      lc.endsWith(` ${state}`) ||
      lc === state ||
      lc.startsWith(`${state} `)
    ) {
      return false;
    }
  }
  for (const postal of US_STATE_POSTALS) {
    // Match ", WA" or " WA" trailing the string (not just any "wa" substring).
    if (lc.endsWith(`, ${postal}`) || lc.endsWith(` ${postal}`)) return false;
  }

  return true;
}

/**
 * Strip the TLD and `www.` prefix from a URL's hostname and title-case
 * the remaining root. Used as the final fallback when no other candidate
 * passes hygiene.
 *
 * Examples:
 *   https://www.belred.com           → "Belred"
 *   https://goarco.com               → "Goarco"
 *   https://example.co.uk            → "Example"
 *   https://abc-law-firm.net         → "Abc Law Firm"
 */
export function domainBrandName(websiteUrl: string): string {
  let host: string;
  try {
    host = new URL(websiteUrl).hostname;
  } catch {
    // Fall back to a naive trim if the URL wasn't parseable.
    host = websiteUrl.replace(/^https?:\/\//, '').split('/')[0];
  }
  host = host.replace(/^www\./, '');
  // Drop the TLD(s). Most domains are one TLD; for co.uk-style we drop two
  // if the SLD looks like a country-code attempt (very short).
  const parts = host.split('.');
  let rootIdx = parts.length - 1;
  // Greedy: drop trailing labels until we're left with the first one
  // (the SLD). We don't try to be clever about country-code-second-level
  // domains — the goal is a label to title-case, not perfect hostname parsing.
  if (parts.length > 2 && parts[parts.length - 2].length <= 3) {
    rootIdx = parts.length - 3;
  } else {
    rootIdx = parts.length - 2;
  }
  if (rootIdx < 0) rootIdx = 0;
  const root = parts[rootIdx] || '';
  // Convert kebab/snake to spaced title-case.
  return root
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Walk the title segments left-to-right AND right-to-left, returning the
 * first one that passes hygiene. Pages frequently put the brand in the
 * LAST segment (e.g. "Utah Personal Injury Attorney - Good Guys Injury
 * Law") so we deliberately check both directions.
 */
function titleSegmentCandidates(pageTitle: string): string[] {
  // Split on common title separators. Whitespace around separators is
  // intentional — we don't want to split "ARCO-Comfort" apart.
  const segments = pageTitle
    .split(/\s+[\-–—|:]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return [pageTitle.trim()];
  // De-dup while preserving order, longest first inside ties (so we don't
  // pull just the trivial last word out of multi-word brands).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of segments) {
    if (!seen.has(seg)) {
      seen.add(seg);
      out.push(seg);
    }
  }
  return out;
}

/**
 * Top-level: choose the best brand-label candidate from the available
 * signals, falling back through them in order of trust.
 *
 *   1. JSON-LD Organization/LocalBusiness/*Business/*Clinic "name".
 *   2. og:site_name from the page metadata, if it passes.
 *   3. The original LLM / markdown extractor result, if it passes.
 *   4. Each segment of the page title, if any pass.
 *   5. The H1, if it passes.
 *   6. Domain-derived name (always returns SOMETHING).
 */
export function sanitiseBrandName(inputs: SanitiseInputs): string {
  const candidates: { source: string; value: string }[] = [];

  // Trust order: structured JSON-LD name → operator-set og:site_name → raw
  // LLM candidate → title segments → H1 → (domain fallback below).
  if (inputs.jsonLdName) {
    candidates.push({ source: 'json-ld', value: inputs.jsonLdName });
  }
  if (inputs.ogSiteName) {
    candidates.push({ source: 'og:site_name', value: inputs.ogSiteName });
  }
  if (inputs.rawCandidate) {
    candidates.push({ source: 'raw', value: inputs.rawCandidate });
  }
  if (inputs.pageTitle) {
    for (const seg of titleSegmentCandidates(inputs.pageTitle)) {
      candidates.push({ source: 'title-segment', value: seg });
    }
  }
  if (inputs.h1) {
    candidates.push({ source: 'h1', value: inputs.h1 });
  }

  for (const c of candidates) {
    if (passesBrandHygiene(c.value)) {
      return c.value.trim();
    }
  }
  return domainBrandName(inputs.websiteUrl);
}

// =============================================================
// JSON-LD organization-name extractor
// =============================================================
//
// Highest-trust brand source: structured data the site operator (or their
// CMS / SEO plugin) published. Scans every <script type="application/ld+json">
// block, JSON.parse-with-try/catch, walks single objects, arrays, and @graph
// containers, and returns the `name` of the first node whose @type is an
// Organization / LocalBusiness / MedicalBusiness / any *Business or *Clinic
// subtype. Pure + dependency-free so it unit-tests cleanly; the Firecrawl
// provider calls it with the homepage rawHtml and threads the result into
// SanitiseInputs.jsonLdName.

function isOrganizationType(rawType: unknown): boolean {
  const types = Array.isArray(rawType) ? rawType : [rawType];
  return types.some((t) => {
    if (typeof t !== 'string') return false;
    const lc = t.toLowerCase();
    return (
      lc === 'organization' ||
      lc.endsWith('business') || // LocalBusiness, MedicalBusiness, HomeAndConstructionBusiness…
      lc.endsWith('clinic') || // MedicalClinic, Clinic…
      lc === 'hospital' ||
      lc === 'physician' ||
      lc === 'dentist' ||
      lc === 'medicalorganization'
    );
  });
}

export function extractJsonLdName(html: string | undefined | null): string | undefined {
  if (!html) return undefined;
  const blockRe =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null) {
    let data: unknown;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue; // malformed JSON-LD — skip, never throw
    }
    const nodes: Record<string, unknown>[] = [];
    const collect = (d: unknown) => {
      if (Array.isArray(d)) {
        d.forEach(collect);
      } else if (d && typeof d === 'object') {
        const obj = d as Record<string, unknown>;
        nodes.push(obj);
        if (Array.isArray(obj['@graph'])) (obj['@graph'] as unknown[]).forEach(collect);
      }
    };
    collect(data);
    for (const node of nodes) {
      if (isOrganizationType(node['@type']) && typeof node.name === 'string' && node.name.trim()) {
        return node.name.trim();
      }
    }
  }
  return undefined;
}
