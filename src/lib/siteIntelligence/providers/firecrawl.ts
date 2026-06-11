import type { SiteIntelligenceProvider, ProviderResult } from './types';
import type { Evidence } from '../schemas';
import { getFirecrawlKey } from '../config';
import { extractColorsFromHtml, extractFontsFromHtml } from '../branding-extractor';
import { extractPhoneFromHtml } from '../phone-extractor';
import { sanitiseBrandName } from '../brand-name-sanitiser';
import {
  sanitiseLocations,
  sanitiseBusinessSummary,
  passesSummaryHygiene,
  passesProseShape,
  passesServiceHygiene,
} from '../extraction-sanitisers';
import { parse as parseHtml } from 'node-html-parser';

/**
 * Pull the first sensible `<h1>` text out of an HTML document.
 *
 * Previously a greedy regex (`/<h1[^>]*>([\s\S]*?)<\/h1>/i`) — which the
 * Walk fixture broke against: the homepage's first `<h1>` was an SVG-wrapped
 * logo (text inside `<svg><foreignObject>…<h1>…</h1></foreignObject></svg>`).
 * The regex's tag-strip stripped the SVG markup but the inner text was
 * SEO-prose, not the brand label. A real parser also lets us skip H1s
 * whose textContent is empty (icon-only headings, screen-reader-hidden
 * decorative H1s) and walk to the next candidate.
 */
function extractFirstUsableH1(html: string): string | null {
  try {
    const root = parseHtml(html, { comment: false });
    const headings = root.querySelectorAll('h1');
    for (const h of headings) {
      const text = h.text.replace(/\s+/g, ' ').trim();
      if (text.length > 0) return text;
    }
    return null;
  } catch {
    return null;
  }
}

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';

const PRIORITY_PATTERNS = [
  '', 'about', 'about-us', 'about-our-firm',
  'services', 'practice-areas', 'what-we-do',
  'locations', 'service-area', 'offices', 'areas-we-serve',
  'contact', 'contact-us',
  'team', 'attorneys', 'our-team', 'staff',
];

/**
 * Strip markdown and raw-URL noise from a scraped paragraph before it
 * lands in business_summary / the WHAT WE FOUND panel. Handles:
 *   - `![alt](url)` markdown images           → removed entirely
 *   - `[text](url)` markdown links            → kept text, dropped url
 *   - bare http(s) URLs                       → removed
 *   - CDN tracking-pixel domains in plain text → removed
 *   - collapsed whitespace
 * S1.1: the WHAT WE FOUND panel was rendering `![](https://static.wixstatic
 * .com/…)` as raw text. Sanitise on the way in (and once more in the
 * renderer as a backstop).
 */
export function cleanProseForDisplay(input: string): string {
  return input
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')              // ![](url)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')           // [text](url) -> text
    .replace(/https?:\/\/\S+/g, '')                    // bare URLs
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url.replace(/^https?:\/\//, '').split('/')[0]; }
}

async function firecrawlFetch(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  const key = getFirecrawlKey();
  const res = await fetch(`${FIRECRAWL_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firecrawl ${endpoint} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function prioritizeUrls(urls: string[], baseUrl: string): string[] {
  const domain = extractDomain(baseUrl);
  const scored: { url: string; score: number }[] = [];
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== domain) continue;
      const path = parsed.pathname.toLowerCase().replace(/\/$/, '');
      let score = 100;
      for (let i = 0; i < PRIORITY_PATTERNS.length; i++) {
        const pattern = PRIORITY_PATTERNS[i];
        if (pattern === '' && path === '') { score = 0; break; }
        if (pattern && path.includes(pattern)) { score = i; break; }
      }
      scored.push({ url, score });
    } catch { /* skip */ }
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, 12).map(s => s.url);
}

// =============================================
// Parse structured data from markdown content
// =============================================
function parseMarkdownForInsights(
  allContent: string,
  pageTitle: string,
  websiteUrl: string,
) {
  const services: { name: string; confidence: number; evidence: Evidence[] }[] = [];
  const locations: { name: string; type: 'city' | 'state' | 'region' | 'country'; confidence: number; evidence: Evidence[] }[] = [];
  let phone: string | undefined;
  let email: string | undefined;
  let address: string | undefined;
  let businessSummary: string | undefined;

  // Extract phone numbers (US format)
  const phoneMatches = allContent.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g);
  if (phoneMatches) phone = phoneMatches[0];

  // Extract email
  const emailMatch = allContent.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) email = emailMatch[0];

  // Extract address patterns (number + street + city/state)
  const addressMatch = allContent.match(/\d{1,5}\s+[\w\s]+(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Ct|Pl|Pkwy|Hwy)[\w\s,]+(?:WA|CA|TX|NY|FL|IL|OH|PA|GA|NC|MI|NJ|VA|AZ|MA|TN|IN|MO|MD|WI|CO|MN|SC|AL|LA|KY|OR|OK|CT|UT|IA|NV|AR|MS|KS|NM|NE|HI|WV|ID|ME|NH|RI|MT|DE|SD|ND|AK|VT|WY|DC)\s+\d{5}/i);
  if (addressMatch) address = addressMatch[0].trim();

  // Extract services from headings and list items
  // Look for patterns like "## Services", "### Our Services", "Practice Areas"
  const serviceHeaders = allContent.match(/#{1,3}\s*(?:our\s+)?(?:services|practice\s*areas|what\s+we\s+(?:do|offer)|specialties|expertise)[^\n]*/gi) || [];

  // Get list items after service headers
  const serviceBlockMatch = allContent.match(/(?:services|practice\s*areas|what\s+we\s+(?:do|offer))[\s\S]*?(?=\n#{1,3}\s|\n\n\n|$)/gi);
  if (serviceBlockMatch) {
    for (const block of serviceBlockMatch) {
      // Extract bullet points and linked items
      const items = block.match(/(?:^|\n)\s*[-*]\s*\[?([^\]\n]+)\]?/g) || [];
      for (const item of items) {
        const cleaned = item.replace(/^\s*[-*]\s*\[?/, '').replace(/\].*$/, '').trim();
        if (cleaned.length > 2 && cleaned.length < 80 && !cleaned.match(/^(services|our|the|and|more|learn|read|view|see|contact|call|get)/i)) {
          services.push({
            name: cleaned,
            confidence: 0.75,
            evidence: [{ source_url: websiteUrl, excerpt: `Service found in page content` }],
          });
        }
      }
    }
  }

  // Also look for services in navigation-style links: [Service Name](/services/...)
  const navServices = allContent.match(/\[([^\]]+)\]\(\/(?:services|practice-areas)[^)]*\)/gi) || [];
  for (const match of navServices) {
    const name = match.match(/\[([^\]]+)\]/)?.[1]?.trim();
    if (name && name.length > 2 && name.length < 80 && !services.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      services.push({
        name,
        confidence: 0.80,
        evidence: [{ source_url: websiteUrl, excerpt: `Linked as service in site navigation` }],
      });
    }
  }

  // Extract locations from content
  // Look for "serving [city]", "located in [city]", or city names near state abbreviations
  const locationPatterns = allContent.match(/(?:serving|located\s+in|based\s+in|offices?\s+in|service\s+area[s]?\s*:?\s*)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:,\s*[A-Z]{2})?)/gi) || [];
  for (const match of locationPatterns) {
    const city = match.replace(/^(?:serving|located\s+in|based\s+in|offices?\s+in|service\s+area[s]?\s*:?\s*)\s*/i, '').trim();
    if (city.length > 2 && !locations.some(l => l.name.toLowerCase() === city.toLowerCase())) {
      locations.push({
        name: city,
        type: 'city',
        confidence: 0.75,
        evidence: [{ source_url: websiteUrl, excerpt: `Location mentioned in content: "${match.trim().slice(0, 80)}"` }],
      });
    }
  }

  // Extract from page title: "Business Name in City, State" or "City Service Provider"
  const titleLocationMatch = pageTitle.match(/in\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:,\s*[A-Z]{2})?)/i);
  if (titleLocationMatch) {
    const city = titleLocationMatch[1].trim();
    if (!locations.some(l => l.name.toLowerCase() === city.toLowerCase())) {
      locations.push({
        name: city,
        type: 'city',
        confidence: 0.85,
        evidence: [{ source_url: websiteUrl, excerpt: `City mentioned in page title` }],
      });
    }
  }

  // Try to build a summary from the first meaningful paragraph.
  // S1.1: previous version stripped `[text](url)` link syntax but left raw
  // `![](image-url)` image markdown intact, which then leaked through to
  // the "WHAT WE FOUND" panel as e.g. `![](https://static.wixstatic.com/…)`.
  // Reject paragraphs that are essentially URL/image salads, and strip any
  // remaining markdown image / raw URL noise from what's left.
  //
  // p4-1b: two further fixes from the the4x4store.co.za scan, where a
  // Shopify product-grid badge strip ("\- \| / Save up to % Save % …
  // Sold out In stock") shipped as the business description:
  //   1. The badge strip arrives as ESCAPED markdown — the leading
  //      backslash defeated every startsWith() check below. Unescape
  //      before the structural checks.
  //   2. Taking paragraphs[0] meant one junk paragraph ended the search.
  //      Iterate until a candidate passes prose shape; a page whose
  //      first paragraph is page furniture still yields its real intro.
  const paragraphs = allContent.split('\n\n');
  for (const raw of paragraphs) {
    const unescaped = raw.replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1').trim();
    if (unescaped.length < 50 || unescaped.length > 500) continue;
    if (
      unescaped.startsWith('#') || unescaped.startsWith('[') ||
      unescaped.startsWith('|') || unescaped.startsWith('!') ||
      /^\s*[-*]/.test(unescaped) ||
      /^(?:!?\[[^\]]*\]\([^)]+\)\s*)+$/.test(unescaped) // image+link salad
    ) {
      continue;
    }
    let candidate = cleanProseForDisplay(unescaped);
    if (candidate.length > 300) {
      candidate = candidate.slice(0, 297) + '...';
    }
    // Too little real prose after cleaning, or badge/nav shape — try
    // the next paragraph rather than ship a stub.
    if (candidate.replace(/\s/g, '').length < 30) continue;
    if (!passesProseShape(candidate)) continue;
    businessSummary = candidate;
    break;
  }

  return { services, locations, phone, email, address, businessSummary };
}

// =============================================
// Main provider
// =============================================
export class FirecrawlProvider implements SiteIntelligenceProvider {
  name = 'firecrawl';

  async run(websiteUrl: string): Promise<ProviderResult> {
    const evidence: Evidence[] = [];
    let brandName: string | undefined;
    // Stage 10 / Fix 1: capture every signal the sanitiser could use as
    // a fallback when the primary brand_name comes back meta-title-shaped.
    let ogSiteName: string | undefined;
    let firstH1: string | undefined;
    let businessSummary: string | undefined;
    let screenshotUrl: string | undefined;
    let logoUrl: string | undefined;
    const colors: string[] = [];
    const fonts: string[] = [];
    let services: { name: string; confidence: number; evidence: Evidence[] }[] = [];
    let locations: { name: string; type: 'city' | 'state' | 'region' | 'country'; confidence: number; evidence: Evidence[] }[] = [];
    const socialLinks: { platform: string; url: string }[] = [];
    const keyPages: { url: string; title: string; reason: string }[] = [];
    let phone: string | undefined;
    let email: string | undefined;
    let address: string | undefined;
    let cmsDetected: string | undefined;

    // Step 1: Map the site to discover URLs
    let urlsToScrape: string[] = [websiteUrl];
    try {
      const mapResult = await firecrawlFetch('/map', {
        url: websiteUrl,
        limit: 50,
      }) as { success: boolean; links?: string[] };

      if (mapResult.success && mapResult.links?.length) {
        urlsToScrape = prioritizeUrls(mapResult.links, websiteUrl);
        console.log(`[Firecrawl] /map found ${mapResult.links.length} URLs, selected ${urlsToScrape.length}`);
      }
    } catch (err) {
      console.warn('[Firecrawl] /map failed:', err);
    }

    // Step 2: Scrape homepage for markdown + screenshot + metadata
    let homepageMarkdown = '';
    let homepageHtml = '';
    let pageTitle = '';
    try {
      // Single combined call — `rawHtml` plus the existing markdown/screenshot.
      // `onlyMainContent: false` is required so we keep <head> (theme-color
      // meta, Google/Bunny Fonts <link>s) and inline <style> blocks intact
      // for the deterministic branding extractor. Markdown is unaffected in
      // practice for our downstream uses.
      const scrapeResult = await firecrawlFetch('/scrape', {
        url: websiteUrl,
        formats: ['markdown', 'rawHtml', 'screenshot'],
        onlyMainContent: false,
      }) as { success: boolean; data?: Record<string, unknown> };

      console.log(`[Firecrawl] /scrape homepage success=${scrapeResult.success}`);

      if (scrapeResult.success && scrapeResult.data) {
        const d = scrapeResult.data;

        if (d.screenshot && typeof d.screenshot === 'string') screenshotUrl = d.screenshot;
        if (d.markdown && typeof d.markdown === 'string') homepageMarkdown = d.markdown;
        if (d.rawHtml && typeof d.rawHtml === 'string') homepageHtml = d.rawHtml;
        // Firecrawl sometimes returns `html` (cleaned) instead of/in addition
        // to `rawHtml` depending on plan. Take whichever's longer.
        if (d.html && typeof d.html === 'string' && d.html.length > homepageHtml.length) {
          homepageHtml = d.html;
        }

        const metadata = d.metadata as Record<string, unknown> | undefined;
        if (metadata) {
          if (metadata.title && typeof metadata.title === 'string') {
            pageTitle = metadata.title;
            // Stage 10 / Fix 1: keep the naive first-segment-of-title as
            // a SEED candidate only — `brandName` here will be re-checked
            // (and possibly overridden) by the sanitiser before we return.
            // Previously this was the final value for a lot of sites and
            // produced meta-title-style brand names on goarco, belred, etc.
            const titleParts = metadata.title.split(/[|\-–—:]/);
            brandName = titleParts[0]?.trim();
          }
          if (metadata.ogImage && typeof metadata.ogImage === 'string') logoUrl = metadata.ogImage;
          if (metadata.sourceURL && typeof metadata.sourceURL === 'string') {
            keyPages.push({ url: metadata.sourceURL, title: pageTitle || 'Homepage', reason: 'Homepage' });
          }
          // Stage 10 / Fix 1: og:site_name is the meta tag operators
          // actually populate with the short brand label (vs <title>
          // which they fill with SEO copy). Firecrawl flattens og: tags
          // into ogSiteName / og:site_name / ogsitename depending on
          // plan; check all three.
          for (const k of ['ogSiteName', 'og:site_name', 'ogsitename']) {
            const v = metadata[k];
            if (typeof v === 'string' && v.trim().length > 0) {
              ogSiteName = v.trim();
              break;
            }
          }
        }

        // Stage 10 / Fix 1: pull the first <h1> from the homepage HTML
        // as another sanitiser candidate. Brand is occasionally the H1
        // when the title tag is SEO-prose ("Welcome to ACME Plumbing").
        if (homepageHtml && !firstH1) {
          const candidate = extractFirstUsableH1(homepageHtml);
          if (candidate) firstH1 = candidate;
        }

        // Check for WordPress indicators in the HTML/markdown
        if (homepageMarkdown.includes('wp-content') || homepageMarkdown.includes('wordpress')) {
          cmsDetected = 'WordPress';
        }

        // Social links
        const links = d.links as string[] | undefined;
        if (Array.isArray(links)) {
          for (const link of links) {
            if (typeof link !== 'string') continue;
            const lower = link.toLowerCase();
            if (lower.includes('facebook.com')) socialLinks.push({ platform: 'Facebook', url: link });
            else if (lower.includes('twitter.com') || lower.includes('x.com')) socialLinks.push({ platform: 'X/Twitter', url: link });
            else if (lower.includes('linkedin.com')) socialLinks.push({ platform: 'LinkedIn', url: link });
            else if (lower.includes('instagram.com')) socialLinks.push({ platform: 'Instagram', url: link });
            else if (lower.includes('youtube.com')) socialLinks.push({ platform: 'YouTube', url: link });
            else if (lower.includes('yelp.com')) socialLinks.push({ platform: 'Yelp', url: link });
          }
        }
      }
    } catch (err) {
      console.warn('[Firecrawl] /scrape homepage failed:', err);
    }

    // Step 3: Try /extract with domain wildcard
    try {
      const domain = extractDomain(websiteUrl);
      const extractResult = await firecrawlFetch('/extract', {
        urls: [`https://${domain}/*`],
        // Stage 10 / Fix 1: brand_name guidance. Previous prompt
        // (`Extract … the business name, …`) consistently returned the
        // meta-title sentence ("BelRed Heating, Cooling, Plumbing &
        // Electrical Services in Seattle, WA") instead of the short
        // brand label. Three real-world fixtures the operator hit:
        //   goarco.com         → "HVAC, Plumbing & Electrical Services in Ohio"
        //   belred.com         → "BelRed Heating, … in Seattle, WA"
        //   goodguysinjurylaw  → "Utah Personal Injury Attorney"
        //
        // This longer prompt anchors the LLM on logo / footer / About-page
        // signals + explicit anti-patterns. The post-process sanitiser in
        // brand-name-sanitiser.ts is the belt + braces — if the LLM still
        // returns junk, the sanitiser falls through to og:site_name →
        // title segments → H1 → domain.
        prompt: `Extract structured business information from this website.

For business_name: extract ONLY the short brand name as it appears in
the site logo, footer copyright, or the About page header. The brand
name is the company's identity — typically 1-4 words — NOT a
description of what they sell.

Do NOT use the page <title> tag, the meta title, or the H1 heading as
the brand name. Those are usually SEO copy that combines services and
geography.

Examples of CORRECT brand_name extraction:
  Page title: "BelRed Heating, Cooling, Plumbing & Electrical Services in Seattle, WA"
  → brand_name: "BelRed"
  Page title: "Utah Personal Injury Attorney - Good Guys Injury Law"
  → brand_name: "Good Guys Injury Law"
  Page title: "HVAC, Plumbing & Electrical Services in Ohio"
  → brand_name: whatever the logo or footer copyright says (e.g. "ARCO Comfort Air")

If you cannot find a short brand label in the logo or footer, return
the shortest non-meta-title candidate you can find. Never return a
string longer than 40 characters or one that contains commas separating
service categories.

For business_summary (Stage 11 / Fix 3): write a 1-2 sentence factual
summary of what this business does. Use the homepage hero, About page,
or services page as primary sources. Do NOT use footer text, terms of
service, privacy policy, marketing-consent checkboxes, or compliance
disclaimers as source material. Never include phrases like "by
checking this box", "consent to receive", "marketing and promotional",
"opt out", "data rates apply", "privacy policy", "terms of service".
If you can't find a clean summary in those primary sources, return an
empty string — downstream code will supply a generic fallback.

For locations_cities (Stage 11 / Fix 3): return geographic locations
ONLY. Each entry must be a city, region, county, state, or country
name. Reject sentence fragments with prepositions ("the Pacific
Northwest for"), partial sentences, and any candidate containing "and
pay", "required to", "taxes", "compliance", "license", or other
business-license boilerplate. Each location is 1-4 words. If the only
candidates are fragments, return an empty array — better empty than
junk.

For primary_services / secondary_services (p4-1b): list what the
business DOES or SELLS as 1-5 word noun phrases. If the site is an
online store, these are its main product categories. NEVER include
promotional text, sale badges, discount percentages, prices, or stock
labels ("Save up to", "Sale", "Sold out", "In stock") — those are page
furniture, not services. The same applies to business_summary:
promotional sale badges and product-card labels are NOT a business
summary.

Also include: phone, email, address, brand_colors, fonts, and
cms_platform per the schema.`,
        // p4-1b: per-field guidance lives on the schema properties too
        // (Firecrawl feeds property descriptions to its extraction LLM).
        // Belt + braces with the prompt above: the prompt carries the
        // worked examples, the descriptions carry the per-field rules —
        // what the field MEANS, WHERE to look, and what's PLAUSIBLE.
        schema: {
          type: 'object',
          properties: {
            business_name: {
              type: 'string',
              description:
                'The short brand name (1-4 words) exactly as it appears in the site logo, footer copyright, or About page header. NEVER the page title, meta title, or H1 — those are SEO copy.',
            },
            business_summary: {
              type: 'string',
              description:
                'A 1-2 sentence factual prose summary of what this business does, sourced from the homepage hero, About page, or services page. NEVER from promo/sale badges, discount or stock labels ("Save up to", "Sold out", "In stock"), prices, footer text, terms of service, or consent text. Empty string if no clean summary exists.',
            },
            primary_services: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The 3-8 main services the business offers — or, for an online store, its main product categories. Each entry a 1-5 word noun phrase (e.g. "Personal Injury Law", "4x4 Suspension Kits"). Never prices, percentages, promo text, or stock labels.',
            },
            secondary_services: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Additional or less prominent services/product categories, same rules as primary_services.',
            },
            locations_cities: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Geographic places the business serves: city, region, county, state, or country names only, 1-4 words each. Never sentence fragments or license/compliance boilerplate.',
            },
            phone: {
              type: 'string',
              description:
                "The business's main public phone number, from the site header, contact page, or footer.",
            },
            email: {
              type: 'string',
              description:
                "The business's public contact email, from the contact page or footer.",
            },
            address: {
              type: 'string',
              description:
                "The business's physical street address, from the contact page, footer, or schema markup.",
            },
            brand_colors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Primary brand colors as hex codes.',
            },
            fonts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Font family names the site uses.',
            },
            cms_platform: {
              type: 'string',
              description:
                'The CMS or platform the site runs on (e.g. WordPress, Shopify), if detectable.',
            },
          },
          required: ['business_name'],
        },
      }) as { success: boolean; data?: Record<string, unknown> };

      console.log(`[Firecrawl] /extract success=${extractResult.success}, keys=${extractResult.data ? Object.keys(extractResult.data).join(',') : 'none'}`);

      if (extractResult.success && extractResult.data) {
        const d = extractResult.data;
        if (d.business_name && typeof d.business_name === 'string') brandName = d.business_name;
        if (d.business_summary && typeof d.business_summary === 'string') {
          // LLM occasionally echoes markdown image/link syntax back into
          // the summary field. Same sanitisation as the fallback parser.
          // Stage 11 / Fix 3: also run the hygiene check — drop summaries
          // that are marketing-consent / terms-of-service boilerplate
          // rather than actual business descriptions. The catch-all
          // fallback at the end of run() supplies a generic line when
          // every path comes up empty.
          const cleaned = cleanProseForDisplay(d.business_summary);
          if (passesSummaryHygiene(cleaned)) businessSummary = cleaned;
        }
        if (d.cms_platform && typeof d.cms_platform === 'string') cmsDetected = d.cms_platform;

        // p4-1b: per-ITEM hygiene — junk entries (badge text, prices,
        // percentages) are dropped individually; the rest of the scan
        // is untouched, so a sparse-but-real site can't flip to failed
        // because of this filter.
        if (Array.isArray(d.primary_services)) {
          for (const svc of d.primary_services) {
            if (typeof svc === 'string' && svc.trim() && passesServiceHygiene(svc)) {
              services.push({ name: svc.trim(), confidence: 0.85, evidence: [{ source_url: websiteUrl, excerpt: 'Primary service from website' }] });
            }
          }
        }
        if (Array.isArray(d.secondary_services)) {
          for (const svc of d.secondary_services) {
            if (typeof svc === 'string' && svc.trim() && passesServiceHygiene(svc)) {
              services.push({ name: svc.trim(), confidence: 0.60, evidence: [{ source_url: websiteUrl, excerpt: 'Secondary service from website' }] });
            }
          }
        }
        if (Array.isArray(d.locations_cities)) {
          // Stage 11 / Fix 3: hygiene-filter the LLM output before
          // ingesting. The LLM has occasionally returned sentence
          // fragments ("the Pacific Northwest for", "and pay all
          // necessary taxes and fees…") that surfaced as location pills.
          // sanitiseLocations drops the obvious junk; the prompt update
          // above tells the LLM to stop producing them in the first place.
          const cleanLocs = sanitiseLocations(
            d.locations_cities.filter((v): v is string => typeof v === 'string')
          );
          for (let i = 0; i < cleanLocs.length; i++) {
            const loc = cleanLocs[i];
            if (loc) {
              locations.push({ name: loc.trim(), type: 'city', confidence: i === 0 ? 0.85 : 0.70, evidence: [{ source_url: websiteUrl, excerpt: 'Location from website' }] });
            }
          }
        }
        if (d.phone && typeof d.phone === 'string') phone = d.phone;
        if (d.email && typeof d.email === 'string') email = d.email;
        if (d.address && typeof d.address === 'string') address = d.address;
        if (Array.isArray(d.brand_colors)) for (const c of d.brand_colors) { if (typeof c === 'string') colors.push(c); }
        if (Array.isArray(d.fonts)) for (const f of d.fonts) { if (typeof f === 'string') fonts.push(f); }

        evidence.push({ source_url: websiteUrl, excerpt: `Structured extraction via Firecrawl /extract` });
      }
    } catch (err) {
      console.warn('[Firecrawl] /extract failed:', err);
    }

    // Step 4: If /extract didn't give us services/locations, scrape priority pages and parse markdown
    if (services.length === 0 || locations.length === 0) {
      console.log(`[Firecrawl] Missing data (services=${services.length}, locations=${locations.length}), scraping priority pages...`);

      const pagesContent: string[] = homepageMarkdown ? [homepageMarkdown] : [];

      // Scrape up to 4 additional priority pages
      for (const pageUrl of urlsToScrape.slice(1, 5)) {
        try {
          const pageResult = await firecrawlFetch('/scrape', {
            url: pageUrl,
            formats: ['markdown'],
            onlyMainContent: true,
          }) as { success: boolean; data?: { markdown?: string } };

          if (pageResult.success && pageResult.data?.markdown) {
            pagesContent.push(pageResult.data.markdown);
            console.log(`[Firecrawl] Scraped ${pageUrl} (${pageResult.data.markdown.length} chars)`);
          }
        } catch {
          // skip failed pages
        }
      }

      if (pagesContent.length > 0) {
        const allContent = pagesContent.join('\n\n');
        const parsed = parseMarkdownForInsights(allContent, pageTitle, websiteUrl);

        if (services.length === 0 && parsed.services.length > 0) {
          // p4-1b: same per-item hygiene as the LLM path — the markdown
          // parser's own checks are structural (length, lead words) and
          // let promo/badge text through.
          services = parsed.services.filter((s) => passesServiceHygiene(s.name));
          console.log(`[Firecrawl] Parsed ${parsed.services.length} services from markdown (${services.length} after hygiene)`);
        }
        if (locations.length === 0 && parsed.locations.length > 0) {
          // Stage 11 / Fix 3: same hygiene filter for the markdown
          // fallback path. The "serving the Pacific Northwest for"
          // shape came from this branch on Belred.
          const cleanParsedLocs = parsed.locations.filter((l) =>
            // sanitiseLocations works on raw strings; the markdown
            // parser produces structured {name, type, ...} entries.
            // Reuse the per-string hygiene check directly.
            !!l.name && sanitiseLocations([l.name]).length > 0
          );
          locations = cleanParsedLocs;
          console.log(`[Firecrawl] Parsed ${locations.length} locations from markdown (after sanitise)`);
        }
        if (!phone && parsed.phone) phone = parsed.phone;
        if (!email && parsed.email) email = parsed.email;
        if (!address && parsed.address) address = parsed.address;
        if (!businessSummary && parsed.businessSummary) {
          // Stage 11 / Fix 3: gate the markdown-fallback summary on the
          // same hygiene check so consent-boilerplate paragraphs don't
          // sneak through this path either.
          if (passesSummaryHygiene(parsed.businessSummary)) {
            businessSummary = parsed.businessSummary;
          }
        }

        evidence.push({ source_url: websiteUrl, excerpt: `Parsed ${pagesContent.length} pages for business data` });
      }
    }

    // Detect WordPress from logo URL or known patterns
    if (!cmsDetected && logoUrl?.includes('wp-content')) {
      cmsDetected = 'WordPress';
    }

    // Build key pages list
    for (const url of urlsToScrape.slice(1, 8)) {
      try {
        const path = new URL(url).pathname;
        const pageName = path.split('/').filter(Boolean).pop() || 'page';
        const title = pageName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        keyPages.push({ url, title, reason: 'High-signal page' });
      } catch { /* skip */ }
    }

    const primaryServices = services.filter(s => s.confidence >= 0.75);
    const secondaryServices = services.filter(s => s.confidence < 0.75);
    const primaryLocations = locations.filter(l => l.confidence >= 0.75);
    const secondaryLocations = locations.filter(l => l.confidence < 0.75);

    // Deterministic brand-color & font extraction from the homepage HTML.
    // Runs after the LLM /extract so we can merge: deterministic results
    // take precedence (their confidence is higher than the LLM 0.80), but
    // any LLM-only finds are preserved so we don't regress on sites where
    // the LLM happens to nail it. De-dupe is case-insensitive on the value.
    // We also build parallel `color_sources` / `font_sources` arrays so
    // field-mapping.ts can read the per-entry confidence instead of the
    // hard-coded 0.85 / 0.80 fallback it used pre-Stage-5.
    const colorSources: { hex: string; source: 'theme-color' | 'css' | 'llm'; confidence: number }[] = [];
    const fontSources: { family: string; source: 'google-fonts' | 'bunny-fonts' | 'css' | 'llm'; confidence: number }[] = [];
    // Seed the source arrays with whatever the LLM had so far.
    for (const c of colors) colorSources.push({ hex: c, source: 'llm', confidence: 0.8 });
    for (const f of fonts) fontSources.push({ family: f, source: 'llm', confidence: 0.8 });

    if (homepageHtml) {
      // S3.1: deterministic precedence-aware phone extraction. Header-first,
      // then hero/above-fold, then tel: links, then footer. Beats the prior
      // first-match-wins behaviour that surfaced back-office / fax numbers
      // on most law-firm sites because the footer was first to match in
      // markdown order on some renders. Deterministic top result OVERRIDES
      // the LLM phone if it disagrees — the precedence rules give us a
      // stronger signal than the LLM's prose-level guess.
      try {
        const detPhones = extractPhoneFromHtml(homepageHtml);
        if (detPhones.length > 0) {
          const top = detPhones[0];
          if (!phone || phone.replace(/\D/g, '').slice(-10) !== top.digits) {
            console.log(
              `[Firecrawl] Phone override: deterministic ${top.phone} (${top.source} @ ${top.confidence}) replaces LLM ${phone || '(none)'}`
            );
            phone = top.phone;
          }
        }
      } catch (err) {
        console.warn('[Firecrawl] Deterministic phone extraction failed:', err);
      }

      try {
        const detColors = extractColorsFromHtml(homepageHtml);
        const detFonts = extractFontsFromHtml(homepageHtml);
        const seenColors = new Set(colors.map((c) => c.toLowerCase()));
        // Prepend deterministic results in order so the higher-confidence
        // theme-color / CSS-frequency hits land at the front of the array.
        for (let i = detColors.length - 1; i >= 0; i--) {
          const c = detColors[i];
          if (!seenColors.has(c.hex.toLowerCase())) {
            colors.unshift(c.hex);
            colorSources.unshift({ hex: c.hex, source: c.source, confidence: c.confidence });
            seenColors.add(c.hex.toLowerCase());
          }
        }
        const seenFonts = new Set(fonts.map((f) => f.toLowerCase()));
        for (let i = detFonts.length - 1; i >= 0; i--) {
          const f = detFonts[i];
          if (!seenFonts.has(f.family.toLowerCase())) {
            fonts.unshift(f.family);
            fontSources.unshift({ family: f.family, source: f.source, confidence: f.confidence });
            seenFonts.add(f.family.toLowerCase());
          }
        }
        console.log(
          `[Firecrawl] Deterministic extractor merged: ${detColors.length} colors, ${detFonts.length} fonts. Final: ${colors.length} colors, ${fonts.length} fonts.`
        );
      } catch (err) {
        console.warn('[Firecrawl] Deterministic branding extraction failed:', err);
      }
    }

    // Stage 10 / Fix 1: post-process brand_name through the sanitiser so
    // meta-title-shaped values get replaced with cleaner fallbacks
    // (og:site_name → title segments → H1 → domain). Logs what was
    // chosen so we can spot-check on real onboardings.
    const brandBeforeSanitise = brandName;
    brandName = sanitiseBrandName({
      rawCandidate: brandName,
      ogSiteName,
      pageTitle: pageTitle || undefined,
      h1: firstH1,
      websiteUrl,
    });
    if (brandBeforeSanitise !== brandName) {
      console.log(`[Firecrawl] brand_name sanitised: "${brandBeforeSanitise}" → "${brandName}"`);
    }

    // Stage 11 / Fix 3: catch-all summary fallback. If we got nothing or
    // the LLM produced boilerplate, sanitiseBusinessSummary returns a
    // generic "[Brand] is a local business." line so downstream surfaces
    // (welcome wizard, WHAT WE FOUND panel, admin analysis pane) always
    // have something readable. Vertical is unknown at scrape time —
    // session vertical is set later in the admin Create flow — so the
    // fallback uses the neutral "local business" form rather than a
    // vertical-specific one.
    const summaryBeforeFallback = businessSummary;
    businessSummary = sanitiseBusinessSummary(businessSummary, brandName || '');
    if (summaryBeforeFallback !== businessSummary) {
      console.log(
        `[Firecrawl] business_summary fallback applied: was=${summaryBeforeFallback ? `"${summaryBeforeFallback.slice(0, 40)}…"` : '(empty)'} → "${businessSummary}"`,
      );
    }

    console.log(`[Firecrawl] Final: brand="${brandName}", services=${services.length}, locations=${locations.length}, screenshot=${!!screenshotUrl}, cms=${cmsDetected || 'none'}, colors=${colors.length}, fonts=${fonts.length}`);

    return {
      branding: {
        screenshot_url: screenshotUrl,
        logo_url: logoUrl,
        colors,
        fonts,
        color_sources: colorSources,
        font_sources: fontSources,
      },
      insights: {
        brand_name: brandName,
        business_summary: businessSummary,
        primary_services: primaryServices,
        secondary_services: secondaryServices,
        primary_locations: primaryLocations,
        secondary_locations: secondaryLocations,
        contact_public: (phone || email || address) ? { phone, email, address } : undefined,
        social_links: socialLinks,
        key_pages: keyPages,
      },
      tech_stack: cmsDetected ? { cms: cmsDetected } : undefined,
      evidence,
    };
  }
}
