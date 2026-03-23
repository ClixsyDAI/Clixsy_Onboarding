import type { SiteIntelligenceProvider, ProviderResult } from './types';
import { getWappalyzerKey } from '../config';

interface WappalyzerTech {
  name: string;
  categories: { name: string }[];
}

export class WappalyzerProvider implements SiteIntelligenceProvider {
  name = 'wappalyzer';

  async run(websiteUrl: string): Promise<ProviderResult> {
    const key = getWappalyzerKey();
    const encodedUrl = encodeURIComponent(websiteUrl);

    const res = await fetch(
      `https://api.wappalyzer.com/v2/lookup/?urls=${encodedUrl}`,
      {
        headers: { 'x-api-key': key },
      }
    );

    if (!res.ok) {
      throw new Error(`Wappalyzer API failed (${res.status})`);
    }

    const data = await res.json() as WappalyzerTech[][];
    const techs = Array.isArray(data) && data[0] ? data[0] : [];

    let cms: string | undefined;
    let ecommerce: string | undefined;
    let hosting: string | undefined;
    const analytics: string[] = [];
    const frameworks: string[] = [];
    const other: string[] = [];

    for (const tech of techs) {
      const categories = tech.categories.map(c => c.name.toLowerCase());

      if (categories.some(c => c.includes('cms'))) {
        cms = cms || tech.name;
      } else if (categories.some(c => c.includes('ecommerce'))) {
        ecommerce = ecommerce || tech.name;
      } else if (categories.some(c => c.includes('analytics'))) {
        analytics.push(tech.name);
      } else if (categories.some(c => c.includes('hosting'))) {
        hosting = hosting || tech.name;
      } else if (categories.some(c => c.includes('framework') || c.includes('javascript'))) {
        frameworks.push(tech.name);
      } else {
        other.push(tech.name);
      }
    }

    return {
      tech_stack: { cms, ecommerce, analytics, hosting, frameworks, other },
      evidence: [{
        source_url: websiteUrl,
        excerpt: `Technology detection via Wappalyzer: ${techs.length} technologies found`,
      }],
    };
  }
}
