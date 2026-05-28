import { createServiceRoleClient } from '@/lib/supabase/server';
import { hasFirecrawlKey, hasWappalyzerKey, hasBuiltWithKey, hasPageSpeedKey } from './config';
import type { SiteIntelligenceProvider, ProviderResult } from './providers/types';
import type { Branding, SiteInsights, TechStack, Metrics, Evidence, SiteIntelligenceRecord } from './schemas';
import { siteInsightsSchema, brandingSchema, techStackSchema, metricsSchema } from './schemas';
import { buildPrefillMap } from './field-mapping';
import { buildQuestionOverrides } from './question-overrides';

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
}

function normalizeUrl(url: string): string {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

function mergeProviderResults(results: ProviderResult[]): {
  branding: Branding;
  insights: SiteInsights;
  techStack: TechStack;
  metrics: Metrics;
  evidence: Evidence[];
} {
  let branding: Partial<Branding> = {};
  const insights: Partial<SiteInsights> = {};
  const techStack: Partial<TechStack> = {};
  let metrics: Partial<Metrics> = {};
  const evidence: Evidence[] = [];

  for (const result of results) {
    if (result.branding) {
      branding = { ...branding, ...result.branding };
      // Merge arrays instead of overwriting
      if (result.branding.colors?.length) {
        branding.colors = [...new Set([...(branding.colors || []), ...result.branding.colors])];
      }
      if (result.branding.fonts?.length) {
        branding.fonts = [...new Set([...(branding.fonts || []), ...result.branding.fonts])];
      }
    }

    if (result.insights) {
      // For object fields, prefer first non-empty value
      if (result.insights.brand_name && !insights.brand_name) {
        insights.brand_name = result.insights.brand_name;
      }
      if (result.insights.business_summary && !insights.business_summary) {
        insights.business_summary = result.insights.business_summary;
      }
      // Merge arrays
      if (result.insights.primary_services?.length) {
        insights.primary_services = [
          ...(insights.primary_services || []),
          ...result.insights.primary_services,
        ];
      }
      if (result.insights.secondary_services?.length) {
        insights.secondary_services = [
          ...(insights.secondary_services || []),
          ...result.insights.secondary_services,
        ];
      }
      if (result.insights.primary_locations?.length) {
        insights.primary_locations = [
          ...(insights.primary_locations || []),
          ...result.insights.primary_locations,
        ];
      }
      if (result.insights.secondary_locations?.length) {
        insights.secondary_locations = [
          ...(insights.secondary_locations || []),
          ...result.insights.secondary_locations,
        ];
      }
      if (result.insights.contact_public && !insights.contact_public) {
        insights.contact_public = result.insights.contact_public;
      }
      if (result.insights.social_links?.length) {
        insights.social_links = [
          ...(insights.social_links || []),
          ...result.insights.social_links,
        ];
      }
      if (result.insights.key_pages?.length) {
        insights.key_pages = [
          ...(insights.key_pages || []),
          ...result.insights.key_pages,
        ];
      }
    }

    if (result.tech_stack) {
      // Prefer first non-empty value for scalars
      if (result.tech_stack.cms && !techStack.cms) techStack.cms = result.tech_stack.cms;
      if (result.tech_stack.ecommerce && !techStack.ecommerce) techStack.ecommerce = result.tech_stack.ecommerce;
      if (result.tech_stack.hosting && !techStack.hosting) techStack.hosting = result.tech_stack.hosting;
      // Merge arrays
      if (result.tech_stack.analytics?.length) {
        techStack.analytics = [...new Set([...(techStack.analytics || []), ...result.tech_stack.analytics])];
      }
      if (result.tech_stack.frameworks?.length) {
        techStack.frameworks = [...new Set([...(techStack.frameworks || []), ...result.tech_stack.frameworks])];
      }
      if (result.tech_stack.other?.length) {
        techStack.other = [...new Set([...(techStack.other || []), ...result.tech_stack.other])];
      }
    }

    if (result.metrics) {
      metrics = { ...metrics, ...result.metrics };
    }

    evidence.push(...result.evidence);
  }

  // Parse through Zod to fill defaults
  return {
    branding: brandingSchema.parse(branding),
    insights: siteInsightsSchema.parse(insights),
    techStack: techStackSchema.parse(techStack),
    metrics: metricsSchema.parse(metrics),
    evidence,
  };
}

// =============================================
// Create a site intelligence record
// =============================================

export async function createSiteIntelligenceRecord(websiteUrl: string): Promise<string> {
  const supabase = createServiceRoleClient();
  const url = normalizeUrl(websiteUrl);
  const domain = extractDomain(url);

  const { data, error } = await supabase
    .from('onboarding_site_intelligence')
    .insert({
      website_url: url,
      domain,
      status: 'queued',
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create site intelligence record: ${error?.message}`);
  }

  return data.id;
}

// =============================================
// Run the analysis pipeline
// =============================================

export async function runSiteAnalysis(recordId: string): Promise<void> {
  const supabase = createServiceRoleClient();

  // Mark as running
  await supabase
    .from('onboarding_site_intelligence')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', recordId);

  // Get the record
  const { data: record } = await supabase
    .from('onboarding_site_intelligence')
    .select('*')
    .eq('id', recordId)
    .single();

  if (!record) {
    throw new Error('Site intelligence record not found');
  }

  const websiteUrl = record.website_url;

  try {
    // Build provider list
    const providers: SiteIntelligenceProvider[] = [];
    const providersUsed = { firecrawl: false, wappalyzer: false, builtwith: false, pagespeed: false };

    if (hasFirecrawlKey()) {
      const { FirecrawlProvider } = await import('./providers/firecrawl');
      providers.push(new FirecrawlProvider());
      providersUsed.firecrawl = true;
    }

    if (hasWappalyzerKey()) {
      const { WappalyzerProvider } = await import('./providers/wappalyzer');
      providers.push(new WappalyzerProvider());
      providersUsed.wappalyzer = true;
    }

    if (hasBuiltWithKey()) {
      const { BuiltWithProvider } = await import('./providers/builtwith');
      providers.push(new BuiltWithProvider());
      providersUsed.builtwith = true;
    }

    if (hasPageSpeedKey()) {
      const { PageSpeedProvider } = await import('./providers/pagespeed');
      providers.push(new PageSpeedProvider());
      providersUsed.pagespeed = true;
    }

    if (providers.length === 0) {
      throw new Error('No intelligence providers available. Set FIRECRAWL_API_KEY at minimum.');
    }

    // Run all providers concurrently
    const results = await Promise.allSettled(
      providers.map(p => p.run(websiteUrl))
    );

    const successfulResults: ProviderResult[] = [];
    const errors: string[] = [];

    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        successfulResults.push(result.value);
      } else {
        errors.push(`${providers[i].name}: ${result.reason}`);
        console.error(`Provider ${providers[i].name} failed:`, result.reason);
      }
    });

    if (successfulResults.length === 0) {
      throw new Error(`All providers failed: ${errors.join('; ')}`);
    }

    // Merge results
    const merged = mergeProviderResults(successfulResults);

    // Bug #1 fix: a "completed" analysis must contain ACTUAL business
    // signals. The old test (successfulResults.length > 0) treated any
    // fulfilled provider result as success — but Firecrawl returns
    // fulfilled-with-empty-content for non-resolving domains, robots.txt-
    // blocked URLs, and domain-parking pages. Those previously wrote
    // status='completed' with garbage data, and the public analyze
    // route's link-only-on-completed guard would then trust the status
    // and overwrite a session's prior good prefill with the garbage.
    //
    // The first attempt at this fix used { brand_name OR primary_services
    // OR primary_locations }. Verification against
    // https://invalid-domain-xyz.invalid surfaced a hole: Firecrawl
    // SYNTHESIZES brand_name from the URL slug ("Invalid Domain Xyz")
    // and produces a template business_summary ("X is a local
    // business...") even when no real content was extracted. Both of
    // those fields are bypassable by URL crafting and must NOT be
    // trusted as gating signals.
    //
    // Tightened predicate — gate on signals that REQUIRE real-page
    // content to populate. Any ONE of these is enough; the breadth
    // is the safety margin against false-rejection of legitimately
    // sparse sites:
    //   - primary_services entries (Firecrawl needs to parse pages)
    //   - primary_locations entries (needs schema or address text)
    //   - a non-empty contact_public.phone (page text or schema)
    //   - a non-empty contact_public.address (page text or schema)
    //   - key_pages entries (Firecrawl found at least one real page)
    //
    // Explicit trim() on phone/address: an empty/whitespace contact
    // object must not pass; matches the pattern used for brand_name
    // checks elsewhere.
    //
    // Note: this changes admin /new flow behavior too — a previously
    // "completed but empty" admin analysis now shows as 'failed' with
    // the plain-language error below. SiteIntelligencePanel already
    // has a failed-state render (red banner + Retry button at
    // lines 175-198) so no admin UI change is needed.
    const hasUsableContent =
      (merged.insights.primary_services?.length ?? 0) > 0 ||
      (merged.insights.primary_locations?.length ?? 0) > 0 ||
      (typeof merged.insights.contact_public?.phone === 'string' &&
        merged.insights.contact_public.phone.trim().length > 0) ||
      (typeof merged.insights.contact_public?.address === 'string' &&
        merged.insights.contact_public.address.trim().length > 0) ||
      (merged.insights.key_pages?.length ?? 0) > 0;

    if (!hasUsableContent) {
      // Preserve provider-level error detail in console logs for
      // operator debugging (Vercel logs). The record's `error` column
      // gets the plain-language line so admin + client UIs render a
      // useful message uniformly.
      if (errors.length > 0) {
        console.error(
          '[runSiteAnalysis] Discarding empty-content analysis for record',
          recordId,
          '— providers failed:',
          errors.join('; ')
        );
      } else {
        console.error(
          '[runSiteAnalysis] Discarding empty-content analysis for record',
          recordId,
          '— providers fulfilled but extracted no brand_name, primary_services, or primary_locations.'
        );
      }
      throw new Error(
        'Could not extract usable information from this website. It may be unreachable, blocked, or have no readable content.'
      );
    }

    // Build prefill map and question overrides
    const prefillMap = buildPrefillMap(merged.insights, merged.techStack, merged.branding);
    const questionOverrides = buildQuestionOverrides(merged.insights, merged.techStack.cms, merged.techStack);

    // Save results
    await supabase
      .from('onboarding_site_intelligence')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        providers_used: providersUsed,
        branding: merged.branding,
        insights: merged.insights,
        tech_stack: merged.techStack,
        metrics: merged.metrics,
        prefill_map: prefillMap,
        question_overrides: questionOverrides,
        evidence: merged.evidence,
        error: errors.length > 0 ? `Partial failure: ${errors.join('; ')}` : null,
      })
      .eq('id', recordId);

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown analysis error';
    console.error('Site analysis failed:', errorMessage);

    await supabase
      .from('onboarding_site_intelligence')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: errorMessage,
      })
      .eq('id', recordId);
  }
}

// =============================================
// Get site intelligence record
// =============================================

export async function getSiteIntelligence(recordId: string): Promise<SiteIntelligenceRecord | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('onboarding_site_intelligence')
    .select('*')
    .eq('id', recordId)
    .single();

  if (error || !data) return null;
  return data as SiteIntelligenceRecord;
}

// =============================================
// Link site intelligence to session and snapshot
// =============================================

export async function linkSiteIntelligenceToSession(
  sessionId: string,
  siId: string,
): Promise<void> {
  const supabase = createServiceRoleClient();

  // Get the intelligence record
  const si = await getSiteIntelligence(siId);
  if (!si || si.status !== 'completed') {
    throw new Error('Site intelligence record not found or not completed');
  }

  // Update session with reference and snapshots
  const { error } = await supabase
    .from('onboarding_sessions')
    .update({
      site_intelligence_id: siId,
      si_prefill_snapshot: si.prefill_map,
      si_overrides_snapshot: si.question_overrides,
      si_branding_snapshot: si.branding,
      si_insights_snapshot: si.insights,
    })
    .eq('id', sessionId);

  if (error) {
    throw new Error(`Failed to link site intelligence: ${error.message}`);
  }
}
