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

async function firecrawlGet(endpoint: string): Promise<unknown> {
  const key = getFirecrawlKey();
  const res = await fetch(`${FIRECRAWL_BASE}${endpoint}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${key}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firecrawl GET ${endpoint} failed (${res.status}): ${text}`);
  }

  return res.json();
}

interface MapResult {
  success: boolean;
  links?: string[];
}

interface ScrapeResult {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      ogImage?: string;
      sourceURL?: string;
    };
    screenshot?: string;
    links?: string[];
  };
}

interface ExtractResult {
  success: boolean;
  data?: Record<string, unknown>;
}

function prioritizeUrls(urls: string[], baseUrl: string): string[] {
  const domain = extractDomain(baseUrl);
  const scored: { url: string; score: number }[] = [];

  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== domain) continue;
      const path = parsed.pathname.toLowerCase().replace(/\/$/, '');

      let score = 100; // default low priority
      for (let i = 0; i < PRIORITY_PATTERNS.length; i++) {
        const pattern = PRIORITY_PATTERNS[i];
        if (pattern === '' && path === '') {
          score = 0; // homepage = highest priority
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
      }) as MapResult;

      if (mapResult.success && mapResult.links?.length) {
        urlsToScrape = prioritizeUrls(mapResult.links, websiteUrl);
      }
    } catch (err) {
      console.warn('Firecrawl /map failed, falling back to homepage only:', err);
    }

    // Step 2: Scrape homepage with screenshot + branding
    try {
      const homeScrape = await firecrawlFetch('/scrape', {
        url: websiteUrl,
        formats: ['markdown', 'screenshot', 'links'],
        onlyMainContent: true,
        screenshot: true,
      }) as ScrapeResult;

      if (homeScrape.success && homeScrape.data) {
        const d = homeScrape.data;
        screenshotUrl = d.screenshot || undefined;

        if (d.metadata?.title) {
          // Extract brand name from title (before | or - or :)
          const titleParts = d.metadata.title.split(/[|\-–—:]/);
          brandName = titleParts[0]?.trim();
        }

        if (d.metadata?.ogImage) {
          logoUrl = d.metadata.ogImage;
        }

        // Extract links for social profiles
        if (d.links) {
          for (const link of d.links) {
            const lower = typeof link === 'string' ? link.toLowerCase() : '';
            if (lower.includes('facebook.com')) socialLinks.push({ platform: 'Facebook', url: link });
            else if (lower.includes('twitter.com') || lower.includes('x.com')) socialLinks.push({ platform: 'X/Twitter', url: link });
            else if (lower.includes('linkedin.com')) socialLinks.push({ platform: 'LinkedIn', url: link });
            else if (lower.includes('instagram.com')) socialLinks.push({ platform: 'Instagram', url: link });
            else if (lower.includes('youtube.com')) socialLinks.push({ platform: 'YouTube', url: link });
            else if (lower.includes('yelp.com')) socialLinks.push({ platform: 'Yelp', url: link });
          }
        }

        if (d.metadata?.sourceURL) {
          keyPages.push({
            url: d.metadata.sourceURL,
            title: d.metadata.title || 'Homepage',
            reason: 'Homepage',
          });
        }
      }
    } catch (err) {
      console.warn('Firecrawl homepage scrape failed:', err);
    }

    // Step 3: Use extract for structured data
    try {
      const extractResult = await firecrawlFetch('/extract', {
        urls: urlsToScrape.slice(0, 8),
        prompt: 'Extract business information from this website.',
        schema: {
          type: 'object',
          properties: {
            business_name: { type: 'string', description: 'The business or company name' },
            business_summary: { type: 'string', description: 'A 2-4 sentence summary of what this business does, written in a friendly client-facing tone' },
            primary_services: {
              type: 'array',
              items: { type: 'string' },
              description: 'Main services or practice areas offered',
            },
            secondary_services: {
              type: 'array',
              items: { type: 'string' },
              description: 'Additional or minor services mentioned',
            },
            locations_cities: {
              type: 'array',
              items: { type: 'string' },
              description: 'Cities or geographic areas served or mentioned',
            },
            phone: { type: 'string', description: 'Main phone number' },
            email: { type: 'string', description: 'Main contact email' },
            address: { type: 'string', description: 'Physical address' },
            brand_colors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Hex color codes used prominently on the site',
            },
            fonts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Font families used on the site',
            },
          },
          required: ['business_name'],
        },
      }) as ExtractResult;

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
                evidence: [{ source_url: websiteUrl, excerpt: `Listed as primary service on website` }],
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
                evidence: [{ source_url: websiteUrl, excerpt: `Mentioned as additional service` }],
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
                evidence: [{ source_url: websiteUrl, excerpt: `Location mentioned on website` }],
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
          excerpt: `Structured extraction from ${urlsToScrape.length} pages via Firecrawl`,
        });
      }
    } catch (err) {
      console.warn('Firecrawl /extract failed:', err);

      // Fallback: if extract fails, at least we have homepage data
      if (brandName) {
        evidence.push({
          source_url: websiteUrl,
          excerpt: `Basic info extracted from homepage metadata`,
        });
      }
    }

    // Build key pages from scraped URLs
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

    // Separate primary vs secondary services by confidence
    const primaryServices = services.filter(s => s.confidence >= 0.75);
    const secondaryServices = services.filter(s => s.confidence < 0.75);

    // Separate primary vs secondary locations
    const primaryLocations = locations.filter(l => l.confidence >= 0.75);
    const secondaryLocations = locations.filter(l => l.confidence < 0.75);

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
