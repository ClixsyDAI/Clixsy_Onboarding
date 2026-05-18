/**
 * Deterministic phone-number extraction from raw HTML, with precedence.
 *
 * S3.1: the prior fallback parser just took the first phone-shaped match
 * in the page markdown, which on most law-firm sites surfaced a back-
 * office or fax number from the footer instead of the prominent header
 * CTA. Layered precedence here matches the doc:
 *
 *   1. <header>, [role="banner"], or top-bar elements   conf 0.95
 *   2. Hero / above-fold sections (hero/banner/intro/   conf 0.85
 *      jumbotron-classed containers, or the first
 *      ~3000 chars of body after stripping header)
 *   3. Inline tel: links anywhere on the page           conf 0.80
 *   4. <footer>, [role="contentinfo"]                   conf 0.70
 *
 * Pure function. No DOM, no fetches. Tested with synthetic fixtures.
 */

export type PhoneSource = 'header' | 'hero' | 'tel-link' | 'footer';

export interface ExtractedPhone {
  /** Canonical display form, e.g. "(877) 517-2990". */
  phone: string;
  /** Raw digits-only form for de-dupe / programmatic comparison. */
  digits: string;
  source: PhoneSource;
  confidence: number;
}

const CONF: Record<PhoneSource, number> = {
  header: 0.95,
  hero: 0.85,
  'tel-link': 0.8,
  footer: 0.7,
};

/** US-format phone regex. Tolerates separators, optional +1, optional parens. */
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/g;

/** Normalise any raw match to canonical (NNN) NNN-NNNN. Returns null if not 10 digits. */
function normalise(raw: string): { display: string; digits: string } | null {
  const digits = raw.replace(/\D/g, '');
  const trimmed = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (trimmed.length !== 10) return null;
  // Skip obvious non-phone digit runs (e.g. zip codes followed by an
  // address number that happen to match the regex shape).
  if (/^0/.test(trimmed)) return null; // area codes never start with 0
  if (/^1/.test(trimmed)) return null; // area codes never start with 1 in NANP
  return {
    display: `(${trimmed.slice(0, 3)}) ${trimmed.slice(3, 6)}-${trimmed.slice(6)}`,
    digits: trimmed,
  };
}

/**
 * Pull phone-shaped TEXT matches out of one HTML chunk, in document order.
 * Requires at least one separator (space, dash, dot, paren) in the raw
 * match — pure 10-digit runs are almost always obfuscated CSS IDs or
 * data-* attribute values on Wix/Squarespace/etc, not real phone numbers.
 * Real phones in human-facing UI almost always carry formatting.
 */
function phonesInChunk(chunk: string): { display: string; digits: string }[] {
  const out: { display: string; digits: string }[] = [];
  let m: RegExpExecArray | null;
  // Reset regex state for each call (PHONE_RE is module-level).
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(chunk)) !== null) {
    // Require at least one separator. /^\d{10,11}$/ → reject.
    if (!/[ ().\-]/.test(m[0])) continue;
    const norm = normalise(m[0]);
    if (norm && !out.some((p) => p.digits === norm.digits)) out.push(norm);
  }
  return out;
}

/** Pull tel: links out of a specific chunk (rather than the full doc). */
function telLinksInChunk(chunk: string): { display: string; digits: string }[] {
  const out: { display: string; digits: string }[] = [];
  const telRe = /href\s*=\s*["']tel:([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = telRe.exec(chunk)) !== null) {
    const norm = normalise(m[1]);
    if (norm && !out.some((p) => p.digits === norm.digits)) out.push(norm);
  }
  return out;
}

/**
 * Extract all matches of a tag block from HTML, e.g. all `<header>…</header>`
 * and `<div role="banner">…</div>`. Returns inner-HTML strings.
 */
function extractRegions(html: string, patterns: RegExp[]): string[] {
  const regions: string[] = [];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) regions.push(m[1] ?? m[0]);
  }
  return regions;
}

/**
 * Find phone numbers in any tel: link inside the HTML.
 */
function telLinkPhones(html: string): { display: string; digits: string }[] {
  const out: { display: string; digits: string }[] = [];
  const telRe = /href\s*=\s*["']tel:([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = telRe.exec(html)) !== null) {
    const norm = normalise(m[1]);
    if (norm && !out.some((p) => p.digits === norm.digits)) out.push(norm);
  }
  return out;
}

/**
 * Approximate "above the fold": after stripping the header(s), take the
 * first ~3000 chars of remaining HTML. Also pulls explicit hero/banner/
 * intro/jumbotron containers so sites whose header is below a top-bar
 * still get covered.
 */
function heroRegions(html: string, headerRegions: string[]): string[] {
  let body = html;
  // Strip header chunks so the "above fold" window doesn't re-include them.
  for (const region of headerRegions) {
    body = body.replace(region, '');
  }
  // Drop everything before <body if present so we don't count <head>.
  const bodyOpen = body.search(/<body\b/i);
  if (bodyOpen >= 0) body = body.slice(bodyOpen);

  const regions: string[] = [];
  // First N chars of body — proxy for above-the-fold content.
  regions.push(body.slice(0, 3000));

  // Explicit hero-shaped containers.
  const heroRe =
    /<(?:section|div|aside)[^>]+class\s*=\s*["'][^"']*\b(?:hero|banner(?!s)|jumbotron|intro|cta[-_ ]?strip)\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div|aside)>/gi;
  let m: RegExpExecArray | null;
  while ((m = heroRe.exec(body)) !== null) regions.push(m[1]);
  return regions;
}

/**
 * Main entry. Returns ranked phone candidates by precedence + confidence.
 * Empty array if nothing usable. Caller can take `result[0]` as the best
 * pick and feed it to the prefill pipeline.
 */
export function extractPhoneFromHtml(html: string): ExtractedPhone[] {
  // 1. Header region(s)
  const headerRegions = extractRegions(html, [
    /<header\b[^>]*>([\s\S]*?)<\/header>/gi,
    /<(?:div|nav|section)[^>]+role\s*=\s*["']banner["'][^>]*>([\s\S]*?)<\/(?:div|nav|section)>/gi,
    /<(?:div|nav|section)[^>]+class\s*=\s*["'][^"']*\b(?:top[-_ ]?bar|topbar|header[-_ ]?bar|site[-_ ]?header)\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|nav|section)>/gi,
  ]);

  // 2. Footer region(s) — extracted up-front because hero detection strips
  // these so it doesn't double-count footer numbers as "above the fold".
  const footerRegions = extractRegions(html, [
    /<footer\b[^>]*>([\s\S]*?)<\/footer>/gi,
    /<(?:div|nav|section)[^>]+role\s*=\s*["']contentinfo["'][^>]*>([\s\S]*?)<\/(?:div|nav|section)>/gi,
  ]);

  // Strip footer regions from `html` for hero scanning so footer numbers
  // don't sneak into the "above the fold" window when the page is short.
  let bodyForHero = html;
  for (const fr of footerRegions) bodyForHero = bodyForHero.replace(fr, '');

  // 3. Hero / above-fold
  const heroChunks = heroRegions(bodyForHero, headerRegions);

  const seen = new Set<string>();
  const results: ExtractedPhone[] = [];

  const push = (cands: { display: string; digits: string }[], source: PhoneSource) => {
    for (const c of cands) {
      if (seen.has(c.digits)) continue;
      seen.add(c.digits);
      results.push({ phone: c.display, digits: c.digits, source, confidence: CONF[source] });
    }
  };

  // Layer 1a: tel: links INSIDE the header. These beat free-text matches
  // in the same region because on Wix/Squarespace sites the header is
  // full of obfuscated IDs whose digit runs LOOK like phones to a regex
  // but aren't. A tel: anchor is an unambiguous "this is the brand's
  // public phone" signal — give it the header confidence.
  for (const region of headerRegions) push(telLinksInChunk(region), 'header');

  // Layer 1b: phone-shaped text in the header (requires separator
  // characters; see phonesInChunk).
  for (const region of headerRegions) push(phonesInChunk(region), 'header');

  // Layer 2: hero / above the fold — tel: links first, then text.
  if (results.length === 0) {
    for (const region of heroChunks) push(telLinksInChunk(region), 'hero');
    for (const region of heroChunks) push(phonesInChunk(region), 'hero');
  }

  // Layer 3: tel: links anywhere else on the page.
  if (results.length === 0) push(telLinkPhones(html), 'tel-link');

  // Layer 4: footer (last resort) — tel: links first, then text.
  if (results.length === 0) {
    for (const region of footerRegions) push(telLinksInChunk(region), 'footer');
    for (const region of footerRegions) push(phonesInChunk(region), 'footer');
  }

  return results;
}
