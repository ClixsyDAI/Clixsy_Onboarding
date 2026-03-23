import type { SiteIntelligenceProvider, ProviderResult } from './types';
import { getBuiltWithKey } from '../config';

interface BuiltWithTech {
  Name: string;
  Tag: string;
}

interface BuiltWithResult {
  Results?: Array<{
    Result?: {
      Paths?: Array<{
        Technologies?: BuiltWithTech[];
      }>;
    };
  }>;
}

export class BuiltWithProvider implements SiteIntelligenceProvider {
  name = 'builtwith';

  async run(websiteUrl: string): Promise<ProviderResult> {
    const key = getBuiltWithKey();
    const domain = new URL(websiteUrl).hostname;

    const res = await fetch(
      `https://api.builtwith.com/free1/api.json?KEY=${encodeURIComponent(key)}&LOOKUP=${encodeURIComponent(domain)}`
    );

    if (!res.ok) {
      throw new Error(`BuiltWith API failed (${res.status})`);
    }

    const data = await res.json() as BuiltWithResult;

    let cms: string | undefined;
    let ecommerce: string | undefined;
    let hosting: string | undefined;
    const analytics: string[] = [];
    const frameworks: string[] = [];
    const other: string[] = [];

    const techs = data.Results?.[0]?.Result?.Paths?.[0]?.Technologies || [];

    for (const tech of techs) {
      const tag = tech.Tag?.toLowerCase() || '';

      if (tag.includes('cms')) {
        cms = cms || tech.Name;
      } else if (tag.includes('shop') || tag.includes('ecommerce')) {
        ecommerce = ecommerce || tech.Name;
      } else if (tag.includes('analytics')) {
        analytics.push(tech.Name);
      } else if (tag.includes('hosting')) {
        hosting = hosting || tech.Name;
      } else if (tag.includes('framework') || tag.includes('javascript')) {
        frameworks.push(tech.Name);
      } else {
        other.push(tech.Name);
      }
    }

    return {
      tech_stack: { cms, ecommerce, analytics, hosting, frameworks, other },
      evidence: [{
        source_url: websiteUrl,
        excerpt: `Technology detection via BuiltWith: ${techs.length} technologies found`,
      }],
    };
  }
}
