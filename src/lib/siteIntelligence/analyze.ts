import {
  createServiceRoleClient,
  logSupabaseFailure,
  logUpstreamFailure,
  normaliseAuditFault,
  normaliseThrownFault,
  BOUNDED_STAGE_FAILURE_TAG,
  SUPABASE_READ_FAILURE_TAG,
  SUPABASE_WRITE_FAILURE_TAG,
  SUPABASE_READ_TIMEOUT_MS_AFTER,
} from '@/lib/supabase/server';
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

/**
 * Canonical form for idempotency comparison: scheme-prefixed, trailing
 * slashes stripped, lowercased. This is the key both analyze routes use
 * to decide whether an existing scan covers the same URL — it must match
 * on both sides regardless of how the caller cased or slash-terminated
 * the input. (The stored `website_url` keeps its original case via
 * normalizeUrl; this is only for comparison, never for storage.)
 */
export function canonicalUrl(url: string): string {
  return normalizeUrl(url.trim()).replace(/\/+$/, '').toLowerCase();
}

const REUSABLE_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'queued',
  'running',
]);

/**
 * Dedup helper shared by the public + admin analyze routes. Given the
 * record currently linked to a session (its `site_intelligence_id`) and
 * the URL the caller wants to analyze, decide whether that linked record
 * can be REUSED instead of paying for a fresh scan.
 *
 * Reusable when the linked record covers the same canonical URL AND is
 * either completed (return it) or still in-flight — queued/running —
 * (attach/resume rather than start a duplicate). A terminal `failed`
 * record is NOT reusable: it should be retried with a new record.
 *
 * Returns null when there's nothing safe to reuse (no link, different
 * URL, missing record, or failed) so the caller starts a new scan.
 */
export async function findReusableScan(
  linkedRecordId: string | null | undefined,
  websiteUrl: string,
  /**
   * Threaded from the analyze route's `withDeadline`. Optional so the other
   * callers are unchanged; when present the underlying read is genuinely
   * CANCELLED at the deadline rather than merely abandoned.
   */
  opts?: { signal?: AbortSignal },
): Promise<{ recordId: string; status: SiteIntelligenceRecord['status'] } | null> {
  if (!linkedRecordId) return null;
  const existing = await getSiteIntelligence(linkedRecordId, opts);
  if (!existing) return null;
  if (!REUSABLE_STATUSES.has(existing.status)) return null;
  if (canonicalUrl(existing.website_url) !== canonicalUrl(websiteUrl)) return null;
  return { recordId: existing.id, status: existing.status };
}

/** Resolve a session's currently-linked site-intelligence record id. */
export async function getSessionScanLink(
  sessionId: string,
): Promise<string | null> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from('onboarding_sessions')
    .select('site_intelligence_id')
    .eq('id', sessionId)
    .single();
  return data?.site_intelligence_id ?? null;
}

/**
 * Eagerly point a session at an in-flight scan record so a reload (or a
 * second analyze click) can DISCOVER it and resume/dedup instead of
 * starting a duplicate. Unlike linkSiteIntelligenceToSession, this sets
 * ONLY the FK — no snapshots — because the record isn't completed yet.
 *
 * The bug-#2 invariant is preserved: we never clobber a still-good
 * COMPLETED link. We attach only when the prior link is empty or points
 * at a non-completed (queued/running/failed) record — i.e. there is no
 * good prefill data to lose. When the prior link is completed, we skip
 * (the new scan runs unlinked and link-on-completion swaps it in only if
 * it succeeds, exactly as the re-analyze path did before).
 */
export async function attachPendingScanToSession(
  sessionId: string,
  recordId: string,
  priorLinkedId: string | null | undefined,
  /**
   * Threaded from the analyze route's `withDeadline`. Optional so the admin
   * route is unchanged. BOTH round trips take it — this helper is a read and
   * then a write, so bounding only the read would leave the write able to
   * outlive the caller's deadline on its own.
   */
  opts?: { signal?: AbortSignal },
): Promise<void> {
  if (priorLinkedId) {
    const prior = await getSiteIntelligence(priorLinkedId, opts);
    if (prior && prior.status === 'completed') return; // preserve good data
  }
  // ONE SENTENCE PER CONDITION. If we are here because the caller's deadline
  // already fired, the caller has ALREADY emitted its own
  // `attach_pending_scan` line; issuing the update on an aborted signal purely
  // to report that it was aborted would be a second line for one event.
  if (opts?.signal?.aborted) return;
  const supabase = createServiceRoleClient();
  let update = supabase
    .from('onboarding_sessions')
    .update({ site_intelligence_id: recordId })
    .eq('id', sessionId);
  if (opts?.signal) update = update.abortSignal(opts.signal);
  const { error, status } = await update;
  if (error) {
    // Non-fatal: dedup/resume degrades to the prior behaviour (the
    // wizard polls by the recordId returned to the caller, and a reload
    // mid-scan falls back to the manual button). Don't fail the analyze.
    //
    // TAGGED, not concatenated. This was the third untagged emitter that
    // pasted remote text into a template — the same class as the two D5 named
    // in sheet-export.ts, in a file the D5 note did not cover. Routed through
    // the shared emitter so a newline in the refusal cannot fragment it and so
    // the fault kind, status and SQLSTATE are all present.
    logSupabaseFailure(
      SUPABASE_WRITE_FAILURE_TAG,
      {
        route: 'attachPendingScanToSession',
        table: 'onboarding_sessions',
        eventType: 'attach_pending_scan_fk',
        sessionId,
        clientId: null,
        succeeded:
          'the analysis record exists and the scan still runs; only the dedup FK was not set, so a reload or a second Analyze click may start a duplicate scan',
      },
      normaliseAuditFault(status, error, 'the FK attach was refused with no error body'),
    );
  }
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

export async function createSiteIntelligenceRecord(
  websiteUrl: string,
  /**
   * Threaded from the analyze route's `withDeadline`. Optional so the admin
   * route is unchanged. Without it the route's bound stopped us WAITING but
   * left the INSERT in flight against a stub that never answers — the
   * documented abandonment cost, paid here rather than merely named.
   */
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const supabase = createServiceRoleClient();
  const url = normalizeUrl(websiteUrl);
  const domain = extractDomain(url);

  let insert = supabase
    .from('onboarding_site_intelligence')
    .insert({
      website_url: url,
      domain,
      status: 'queued',
    })
    .select('id');
  if (opts?.signal) insert = insert.abortSignal(opts.signal);
  const { data, error } = await insert.single();

  if (error || !data) {
    throw new Error(`Failed to create site intelligence record: ${error?.message}`);
  }

  return data.id;
}

// =============================================
// Run the analysis pipeline
// =============================================

export async function runSiteAnalysis(
  recordId: string,
  /**
   * Only so the failure line below can name the session an operator would
   * search by. Optional because the admin route analyses a record that is not
   * yet attached to any session, and a line that says `"session_id":null` is
   * honest where a line that repeats the record id there would not be.
   */
  opts?: { sessionId?: string | null },
): Promise<void> {
  const supabase = createServiceRoleClient();

  // Mark as running
  //
  // SURVIVING SILENT WRITE (1 of 3 in this file). `.error` is never read and
  // the result is discarded, so an RLS refusal, a schema fault or a dead
  // transport leaves this record stuck at 'queued' with nothing logged — the
  // wizard then polls a status that will never change. postgrest-js RESOLVES
  // all of those rather than throwing, which is why no try/catch above catches
  // it (src/lib/supabase/server.ts documents the resolved-value contract).
  // Out of scope for this PR: these are site-intelligence state writes, not
  // audit writes, so they are not among the seven sites the audit-surfacing
  // change covers, and their behaviour is deliberately UNCHANGED here.
  // The primitives to reach for when fixing this: `normaliseAuditFault` +
  // `AuditWriteError` + `logAuditWriteFailure`, or `recordAuditRow` /
  // `insertAuditRowOrThrow` (both table-agnostic) in
  // src/lib/supabase/server.ts, plus `.abortSignal(AbortSignal.timeout(ms))`,
  // which nothing in this file has either.
  await supabase
    .from('onboarding_site_intelligence')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', recordId);

  // Get the record.
  //
  // BOUNDED AND REPORTED, and it is a READ, so it is NOT one of the three
  // discarded-result WRITES annotated in this file — those are deliberately
  // unchanged. This read is the FIRST unbounded await inside the analyze
  // route's after() callback, so under a PostgREST that accepts and never
  // answers it froze the whole background task here: no analysis, no status
  // change, no line, and the 200 already shipped. The outer deadline in the
  // route would eventually end it, but only after SITE_ANALYSIS_DEADLINE_MS,
  // and it could not say WHICH await had stalled. Five seconds is the same
  // after()-path budget every other Supabase read on a background path uses.
  const {
    data: record,
    error: recordErr,
    status: recordStatus,
  } = await supabase
    .from('onboarding_site_intelligence')
    .select('*')
    .eq('id', recordId)
    .abortSignal(AbortSignal.timeout(SUPABASE_READ_TIMEOUT_MS_AFTER))
    .single();

  if (recordErr) {
    logSupabaseFailure(
      SUPABASE_READ_FAILURE_TAG,
      {
        route: `runSiteAnalysis(record ${recordId})`,
        table: 'onboarding_site_intelligence',
        eventType: 'analysis_record_lookup',
        sessionId: opts?.sessionId ?? '',
        clientId: null,
        succeeded:
          'nothing: the analysis never started, and the record is left at whatever status it already had',
      },
      normaliseAuditFault(
        recordStatus,
        recordErr,
        'the site-intelligence record read was refused with no error body',
      ),
    );
  }

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
    //
    // SURVIVING SILENT WRITE (2 of 3, and the worst of them). This is the
    // write that PERSISTS A COMPLETED ANALYSIS: the branding, insights, tech
    // stack, prefill map and question overrides the whole Anthropic spend just
    // produced. `.error` is never read, so if it is refused the record stays
    // 'running' forever, the paid-for result is dropped on the floor, and
    // nothing anywhere says so. Same silent class as the audit writes; same
    // reason (postgrest-js resolves faults instead of throwing).
    // NOT CHANGED IN THIS PR (not an audit write, outside the seven sites).
    // Primitives available for the fix: see the note in runSiteAnalysis above.
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

    // D4 — THE MOST COMMON BACKGROUND-SCAN FAILURE WAS THE UNTAGGED ONE.
    //
    // This catch is where a scan failure actually lands. Every provider
    // failing, an unusable-content discard, an Anthropic error, a Firecrawl
    // timeout: all of them are thrown above and caught HERE, the record is
    // marked failed, and nothing is rethrown. So the analyze route's own
    // `[bounded-stage][FAILURE]` line — which only fires when `runSiteAnalysis`
    // REJECTS — never fired for the ordinary case, and the only trace was
    // `console.error('Site analysis failed:', errorMessage)`: untagged, two
    // arguments (so a log table splits it), no session, no record id, no fault
    // kind, and CONCATENATING a message that may have come from a remote.
    //
    // Routed through the same emitter as everything else. `target` names the
    // record rather than a URL, which is the field's documented second meaning
    // (a bounded stage's name); `normaliseThrownFault` gives the same fault
    // vocabulary, so a Firecrawl abort here reads 'timeout' exactly as a
    // stalled Supabase read does.
    logUpstreamFailure(
      BOUNDED_STAGE_FAILURE_TAG,
      {
        route: `runSiteAnalysis(record ${recordId})`,
        target: `site_analysis (onboarding_site_intelligence ${recordId})`,
        eventType: 'site_analysis_failed',
        sessionId: opts?.sessionId ?? '',
        clientId: null,
        succeeded:
          'nothing from this scan: no branding, insights, tech stack or prefill was written. The record is marked failed below, so the wizard shows its retry affordance rather than polling forever',
      },
      normaliseThrownFault(err),
    );

    // SURVIVING SILENT WRITE (3 of 3). The failure-marking write is itself
    // silent, so a refused update leaves the record stuck at 'running' and the
    // wizard polling a scan that has already failed. The tagged line above is
    // now the trace, and it is explicit that the retry affordance depends on
    // THIS write landing — which this write still does not report.
    // NOT CHANGED IN THIS PR (not an audit write, outside the seven sites).
    // Primitives available for the fix: see the note in runSiteAnalysis above.
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

export async function getSiteIntelligence(
  recordId: string,
  opts?: { signal?: AbortSignal },
): Promise<SiteIntelligenceRecord | null> {
  const supabase = createServiceRoleClient();

  // `.abortSignal` precedes `.single()`, which returns a PostgrestBuilder and
  // does not carry it.
  let query = supabase
    .from('onboarding_site_intelligence')
    .select('*')
    .eq('id', recordId);
  if (opts?.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query.single();

  if (error || !data) return null;
  return data as SiteIntelligenceRecord;
}

// =============================================
// Link site intelligence to session and snapshot
// =============================================

export async function linkSiteIntelligenceToSession(
  sessionId: string,
  siId: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const supabase = createServiceRoleClient();

  // Get the intelligence record
  const si = await getSiteIntelligence(siId, opts);
  if (!si || si.status !== 'completed') {
    throw new Error('Site intelligence record not found or not completed');
  }

  // Update session with reference and snapshots. BOTH halves take the signal:
  // this helper is TWO round trips, so bounding only the read would leave the
  // write able to hang the caller on its own.
  let update = supabase
    .from('onboarding_sessions')
    .update({
      site_intelligence_id: siId,
      si_prefill_snapshot: si.prefill_map,
      si_overrides_snapshot: si.question_overrides,
      si_branding_snapshot: si.branding,
      si_insights_snapshot: si.insights,
    })
    .eq('id', sessionId);
  if (opts?.signal) update = update.abortSignal(opts.signal);
  const { error } = await update;

  if (error) {
    throw new Error(`Failed to link site intelligence: ${error.message}`);
  }
}
