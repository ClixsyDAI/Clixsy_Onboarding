import type { SiteIntelligenceProvider, ProviderResult } from './types';
import type { Evidence } from '../schemas';
import { getFirecrawlKey } from '../config';

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';

// Priority pages to scrape (ordered by importance)
const PRIORITY_PATTERNS = [
  '', // homepage
  'about', 'about-us', 'about-our-firm',
  'services', 'practice-areas', 'what-we-do',
  'locations', 'service-area', 'offices', 'areas-we-serve',
  'contact', 'contact-us',
  'team', 'attorneys', 'our-team', 'staff',
];

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
}

async function firecrawlFetch(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  const key = getFirecrawlKey();
  const res = await fetch(`${FIRECRAWL_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
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
        if (pattern === '' && path === '') {
          score = 0;
          break;
        }
        if (pattern && path.includes(pattern)) {
          score = i;
          break;
        }
      }
      scored.push({ url, score });
    } catch {
      // skip invalid URLs
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, 12).map(s => s.url);
}

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
    const services: { name: string; confidence: number; evidence: Evidence[] }[] = [];
    const locations: { name: string; type: 'city' | 'state' | 'region' | 'country'; confidence: number; evidence: Evidence[] }[] = [];
    const socialLinks: { platform: string; url: string }[] = [];
    const keyPages: { url: string; title: string; reason: string }[] = [];
    let phone: string | undefined;
    let email: string | undefined;
    let address: string | undefined;

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

    // Step 2: Scrape homepage for markdown content + metadata
    let homepageMarkdown = '';
    try {
      const scrapeResult = await firecrawlFetch('/scrape', {
        url: websiteUrl,
        formats: ['markdown', 'screenshot'],
        onlyMainContent: true,
      }) as { success: boolean; data?: Record<string, unknown> };

      console.log(`[Firecrawl] /scrape success=${scrapeResult.success}, hasData=${!!scrapeResult.data}`);

      if (scrapeResult.success && scrapeResult.data) {
        const d = scrapeResult.data;

        // Screenshot
        if (d.screenshot && typeof d.screenshot === 'string') {
          screenshotUrl = d.screenshot;
        }

        // Markdown content for later parsing
        if (d.markdown && typeof d.markdown === 'string') {
          homepageMarkdown = d.markdown;
        }

        // Metadata
        const metadata = d.metadata as Record<string, unknown> | undefined;
        if (metadata) {
          if (metadata.title && typeof metadata.title === 'string') {
            const titleParts = metadata.title.split(/[|\-–—:]/);
            brandName = titleParts[0]?.trim();
          }
          if (metadata.ogImage && typeof metadata.ogImage === 'string') {
            logoUrl = metadata.ogImage;
          }
          if (metadata.sourceURL && typeof metadata.sourceURL === 'string') {
            keyPages.push({
              url: metadata.sourceURL,
              title: (metadata.title as string) || 'Homepage',
              reason: 'Homepage',
            });
          }
        }

        // Links for social profiles
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
      console.warn('[Firecrawl] /scrape failed:', err);
    }

    // Step 3: Use /extract with the domain wildcard for structured extraction
    // This is the primary way to get business insights
    try {
      const domain = extractDomain(websiteUrl);
      const extractResult = await firecrawlFetch('/extract', {
        urls: [`https://${domain}/*`],
        prompt: `Extract structured business information from this website. Include: the business name, a 2-4 sentence client-friendly summary of what they do, their main services or practice areas, cities/areas they serve, contact details (phone, email, address), and any brand colors or fonts visible on the site.`,
        schema: {
          type: 'object',
          properties: {
            business_name: { type: 'string', description: 'The official business or company name' },
            business_summary: { type: 'string', description: 'A 2-4 sentence summary of what this business does, written in a friendly professional tone' },
            primary_services: {
              type: 'array',
              items: { type: 'string' },
              description: 'Main services, practice areas, or product categories offered',
            },
            secondary_services: {
              type: 'array',
              items: { type: 'string' },
              description: 'Additional or minor services mentioned on the site',
            },
            locations_cities: {
              type: 'array',
              items: { type: 'string' },
              description: 'Cities, metros, or geographic areas served or mentioned',
            },
            phone: { type: 'string', description: 'Main business phone number' },
            email: { type: 'string', description: 'Main contact email address' },
            address: { type: 'string', description: 'Physical business address' },
            brand_colors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Hex color codes (e.g. #1a2b3c) used prominently on the site',
            },
            fonts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Font family names used on the site',
            },
            cms_platform: { type: 'string', description: 'The CMS or website platform (e.g. WordPress, Squarespace, Wix, custom)' },
          },
          required: ['business_name'],
        },
      }) as { success: boolean; data?: Record<string, unknown> };

      console.log(`[Firecrawl] /extract success=${extractResult.success}, hasData=${!!extractResult.data}, keys=${extractResult.data ? Object.keys(extractResult.data).join(',') : 'none'}`);

      if (extractResult.success && extractResult.data) {
        const d = extractResult.data;

        if (d.business_name && typeof d.business_name === 'string') {
          brandName = d.business_name;
        }
        if (d.business_summary && typeof d.business_summary === 'string') {
          businessSummary = d.business_summary;
        }

        if (Array.isArray(d.primary_services)) {
          for (const svc of d.primary_services) {
            if (typeof svc === 'string' && svc.trim()) {
              services.push({
                name: svc.trim(),
                confidence: 0.85,
                evidence: [{ source_url: websiteUrl, excerpt: 'Listed as primary service on website' }],
              });
            }
          }
        }

        if (Array.isArray(d.secondary_services)) {
          for (const svc of d.secondary_services) {
            if (typeof svc === 'string' && svc.trim()) {
              services.push({
                name: svc.trim(),
                confidence: 0.60,
                evidence: [{ source_url: websiteUrl, excerpt: 'Mentioned as additional service' }],
              });
            }
          }
        }

        if (Array.isArray(d.locations_cities)) {
          for (let i = 0; i < d.locations_cities.length; i++) {
            const loc = d.locations_cities[i];
            if (typeof loc === 'string' && loc.trim()) {
              locations.push({
                name: loc.trim(),
                type: 'city',
                confidence: i === 0 ? 0.85 : 0.70,
                evidence: [{ source_url: websiteUrl, excerpt: 'Location mentioned on website' }],
              });
            }
          }
        }

        if (d.phone && typeof d.phone === 'string') phone = d.phone;
        if (d.email && typeof d.email === 'string') email = d.email;
        if (d.address && typeof d.address === 'string') address = d.address;

        if (Array.isArray(d.brand_colors)) {
          for (const c of d.brand_colors) {
            if (typeof c === 'string') colors.push(c);
          }
        }
        if (Array.isArray(d.fonts)) {
          for (const f of d.fonts) {
            if (typeof f === 'string') fonts.push(f);
          }
        }

        evidence.push({
          source_url: websiteUrl,
          excerpt: `Structured extraction via Firecrawl /extract on ${domain}/*`,
        });
      }
    } catch (err) {
      console.warn('[Firecrawl] /extract failed:', err);
    }

    // Step 4: Fallback — if /extract gave us nothing, parse the homepage markdown
    if (!brandName && !businessSummary && services.length === 0 && homepageMarkdown) {
      console.log('[Firecrawl] /extract returned no data, falling back to markdown parsing');

      // Try to scrape a few more priority pages for content
      const pagesContent: string[] = [homepageMarkdown];
      for (const pageUrl of urlsToScrape.slice(1, 5)) {
        try {
          const pageResult = await firecrawlFetch('/scrape', {
            url: pageUrl,
            formats: ['markdown'],
            onlyMainContent: true,
          }) as { success: boolean; data?: { markdown?: string } };

          if (pageResult.success && pageResult.data?.markdown) {
            pagesContent.push(pageResult.data.markdown);
          }
        } catch {
          // skip failed pages
        }
      }

      // Basic extraction from markdown content
      const allContent = pagesContent.join('\n\n');

      // Extract phone numbers
      const phoneMatch = allContent.match(/(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      if (phoneMatch) phone = phoneMatch[0];

      // Extract email
      const emailMatch = allContent.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) email = emailMatch[0];

      evidence.push({
        source_url: websiteUrl,
        excerpt: `Fallback extraction from ${pagesContent.length} scraped pages`,
      });
    }

    // Build key pages list from scraped URLs
    for (const url of urlsToScrape.slice(1, 8)) {
      try {
        const path = new URL(url).pathname;
        const pageName = path.split('/').filter(Boolean).pop() || 'page';
        const title = pageName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        keyPages.push({ url, title, reason: 'High-signal page' });
      } catch {
        // skip
      }
    }

    const primaryServices = services.filter(s => s.confidence >= 0.75);
    const secondaryServices = services.filter(s => s.confidence < 0.75);
    const primaryLocations = locations.filter(l => l.confidence >= 0.75);
    const secondaryLocations = locations.filter(l => l.confidence < 0.75);

    console.log(`[Firecrawl] Final results: brand=${brandName || 'none'}, services=${services.length}, locations=${locations.length}, screenshot=${!!screenshotUrl}`);

    return {
      branding: {
        screenshot_url: screenshotUrl,
        logo_url: logoUrl,
        colors,
        fonts,
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
      evidence,
    };
  }
}
