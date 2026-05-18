import type { SiteIntelligenceProvider, ProviderResult } from './types';
import type { Evidence } from '../schemas';
import { getFirecrawlKey } from '../config';
import { extractColorsFromHtml, extractFontsFromHtml } from '../branding-extractor';

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';

const PRIORITY_PATTERNS = [
  '', 'about', 'about-us', 'about-our-firm',
  'services', 'practice-areas', 'what-we-do',
  'locations', 'service-area', 'offices', 'areas-we-serve',
  'contact', 'contact-us',
  'team', 'attorneys', 'our-team', 'staff',
];

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

  // Try to build a summary from the first meaningful paragraph
  const paragraphs = allContent.split('\n\n').filter(p =>
    p.length > 50 && p.length < 500 &&
    !p.startsWith('#') && !p.startsWith('[') && !p.startsWith('|') &&
    !p.match(/^\s*[-*]/)
  );
  if (paragraphs.length > 0) {
    businessSummary = paragraphs[0].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
    if (businessSummary.length > 300) {
      businessSummary = businessSummary.slice(0, 297) + '...';
    }
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
            const titleParts = metadata.title.split(/[|\-–—:]/);
            brandName = titleParts[0]?.trim();
          }
          if (metadata.ogImage && typeof metadata.ogImage === 'string') logoUrl = metadata.ogImage;
          if (metadata.sourceURL && typeof metadata.sourceURL === 'string') {
            keyPages.push({ url: metadata.sourceURL, title: pageTitle || 'Homepage', reason: 'Homepage' });
          }
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
        prompt: `Extract structured business information from this website. Include: the business name, a 2-4 sentence client-friendly summary of what they do, their main services or practice areas, cities/areas they serve, contact details (phone, email, address), brand colors, fonts, and CMS platform.`,
        schema: {
          type: 'object',
          properties: {
            business_name: { type: 'string' },
            business_summary: { type: 'string' },
            primary_services: { type: 'array', items: { type: 'string' } },
            secondary_services: { type: 'array', items: { type: 'string' } },
            locations_cities: { type: 'array', items: { type: 'string' } },
            phone: { type: 'string' },
            email: { type: 'string' },
            address: { type: 'string' },
            brand_colors: { type: 'array', items: { type: 'string' } },
            fonts: { type: 'array', items: { type: 'string' } },
            cms_platform: { type: 'string' },
          },
          required: ['business_name'],
        },
      }) as { success: boolean; data?: Record<string, unknown> };

      console.log(`[Firecrawl] /extract success=${extractResult.success}, keys=${extractResult.data ? Object.keys(extractResult.data).join(',') : 'none'}`);

      if (extractResult.success && extractResult.data) {
        const d = extractResult.data;
        if (d.business_name && typeof d.business_name === 'string') brandName = d.business_name;
        if (d.business_summary && typeof d.business_summary === 'string') businessSummary = d.business_summary;
        if (d.cms_platform && typeof d.cms_platform === 'string') cmsDetected = d.cms_platform;

        if (Array.isArray(d.primary_services)) {
          for (const svc of d.primary_services) {
            if (typeof svc === 'string' && svc.trim()) {
              services.push({ name: svc.trim(), confidence: 0.85, evidence: [{ source_url: websiteUrl, excerpt: 'Primary service from website' }] });
            }
          }
        }
        if (Array.isArray(d.secondary_services)) {
          for (const svc of d.secondary_services) {
            if (typeof svc === 'string' && svc.trim()) {
              services.push({ name: svc.trim(), confidence: 0.60, evidence: [{ source_url: websiteUrl, excerpt: 'Secondary service from website' }] });
            }
          }
        }
        if (Array.isArray(d.locations_cities)) {
          for (let i = 0; i < d.locations_cities.length; i++) {
            const loc = d.locations_cities[i];
            if (typeof loc === 'string' && loc.trim()) {
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
          services = parsed.services;
          console.log(`[Firecrawl] Parsed ${services.length} services from markdown`);
        }
        if (locations.length === 0 && parsed.locations.length > 0) {
          locations = parsed.locations;
          console.log(`[Firecrawl] Parsed ${locations.length} locations from markdown`);
        }
        if (!phone && parsed.phone) phone = parsed.phone;
        if (!email && parsed.email) email = parsed.email;
        if (!address && parsed.address) address = parsed.address;
        if (!businessSummary && parsed.businessSummary) businessSummary = parsed.businessSummary;

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
