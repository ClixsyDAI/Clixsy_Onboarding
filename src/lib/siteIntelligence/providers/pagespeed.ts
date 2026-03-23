import type { SiteIntelligenceProvider, ProviderResult } from './types';
import { getPageSpeedKey } from '../config';

interface PSIResponse {
  lighthouseResult?: {
    categories?: {
      performance?: { score: number };
      accessibility?: { score: number };
      seo?: { score: number };
      'best-practices'?: { score: number };
    };
    audits?: {
      'largest-contentful-paint'?: { numericValue: number };
      'first-input-delay'?: { numericValue: number };
      'cumulative-layout-shift'?: { numericValue: number };
    };
  };
}

export class PageSpeedProvider implements SiteIntelligenceProvider {
  name = 'pagespeed';

  async run(websiteUrl: string): Promise<ProviderResult> {
    const key = getPageSpeedKey();
    const encoded = encodeURIComponent(websiteUrl);

    const res = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encoded}&key=${encodeURIComponent(key)}&category=performance&category=accessibility&category=seo&category=best-practices&strategy=mobile`
    );

    if (!res.ok) {
      throw new Error(`PageSpeed Insights API failed (${res.status})`);
    }

    const data = await res.json() as PSIResponse;
    const cats = data.lighthouseResult?.categories;
    const audits = data.lighthouseResult?.audits;

    return {
      metrics: {
        performance_score: cats?.performance?.score ? Math.round(cats.performance.score * 100) : undefined,
        accessibility_score: cats?.accessibility?.score ? Math.round(cats.accessibility.score * 100) : undefined,
        seo_score: cats?.seo?.score ? Math.round(cats.seo.score * 100) : undefined,
        best_practices_score: cats?.['best-practices']?.score ? Math.round(cats['best-practices'].score * 100) : undefined,
        lcp_ms: audits?.['largest-contentful-paint']?.numericValue,
        cls: audits?.['cumulative-layout-shift']?.numericValue,
      },
      evidence: [{
        source_url: websiteUrl,
        excerpt: `PageSpeed Insights mobile analysis`,
      }],
    };
  }
}
