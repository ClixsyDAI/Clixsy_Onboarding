'use server';

// =============================================================
// GBP Server Actions — admin-only surface for GBP 5b
// =============================================================
//
// Server Actions instead of /api/admin routes for the same reason
// as admin-actions.ts (Phase 6 PR A): the admin UI invokes these
// in-process, the proxy's admin_token gate still covers the
// invocation (actions POST to the /admin/* page URL), and no
// bearer token leaks into the browser bundle.
//
// Writes are REAL form data — same rule as the AM-bypass design:
// no audit events fire from here, the data lands in
// onboarding_answers exactly as if the client typed it.

import { createServiceRoleClient, upsertAnswer } from '@/lib/supabase/server';
import { getGbpClient } from './config';
import type { GbpLocation } from './types';

const MAX_APPLY_ROWS = 200;

export type FetchGbpLocationsResult =
  | { ok: true; mode: 'mock' | 'real'; locations: GbpLocation[] }
  | { ok: false; error: string };

/**
 * Fetch all GBP locations visible to the agency account (mock
 * fixtures until the API access application is approved).
 */
export async function fetchGbpLocationsAction(): Promise<FetchGbpLocationsResult> {
  try {
    const client = getGbpClient();
    const locations = await client.listAllLocations();
    return { ok: true, mode: client.mode, locations };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to fetch GBP locations',
    };
  }
}

export type ApplyGbpLocationsResult =
  | { ok: true; rowCount: number; stepKey: string }
  | { ok: false; error: string };

/**
 * Write selected GBP location URLs into the session's answers as
 * `gbp_locations` rows (the 5a shape) and set has_gbp='yes' so the
 * wizard's dependsOn gate reveals them.
 *
 * Merge semantics: ADD — existing rows are kept, new URLs are
 * appended, deduped by URL. A legacy single-string
 * `gbp_listing_url` answer is folded in as a row so it isn't
 * visually dropped once gbp_locations exists (the 5a renderer
 * only falls back to the legacy key when gbp_locations is empty).
 */
export async function applyGbpLocationsAction(
  sessionId: string,
  selected: { url: string }[],
): Promise<ApplyGbpLocationsResult> {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, error: 'Missing session id' };
  }
  if (!Array.isArray(selected) || selected.length === 0) {
    return { ok: false, error: 'No locations selected' };
  }
  if (selected.length > MAX_APPLY_ROWS) {
    return { ok: false, error: `Too many rows (max ${MAX_APPLY_ROWS})` };
  }

  const incoming = selected
    .map((s) => (typeof s?.url === 'string' ? s.url.trim() : ''))
    .filter((u) => u.length > 0 && u.length < 2048 && /^https?:\/\//i.test(u));
  if (incoming.length === 0) {
    return { ok: false, error: 'No valid URLs in selection' };
  }

  const supabase = createServiceRoleClient();

  const { data: session, error: sessionErr } = await supabase
    .from('onboarding_sessions')
    .select('id, flow_version, status')
    .eq('id', sessionId)
    .single();

  if (sessionErr || !session) {
    return { ok: false, error: 'Session not found' };
  }

  // Post-submission immutability — same invariant the save-step and
  // submit routes enforce. Without this, the admin panel would be the
  // only answers-write path that can silently mutate a submitted
  // session (and with no audit events, undetectably so).
  if (session.status === 'submitted') {
    return { ok: false, error: 'Session has already been submitted' };
  }

  // v1 has a dedicated GBP step; v2 nests the fields in SEO Targeting.
  const stepKey =
    (session.flow_version as string | null) === 'v2' ? 'seo_targeting' : 'google_business';

  const { data: existingRow } = await supabase
    .from('onboarding_answers')
    .select('answers, completed')
    .eq('session_id', sessionId)
    .eq('step_key', stepKey)
    .maybeSingle();

  const existingAnswers = (existingRow?.answers ?? {}) as Record<string, unknown>;

  // Seed the merged set: existing array rows first, then the legacy
  // single-string answer (if any), then the incoming selection.
  const mergedUrls: string[] = [];
  const seen = new Set<string>();
  const push = (u: unknown) => {
    if (typeof u !== 'string') return;
    const trimmed = u.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    mergedUrls.push(trimmed);
  };

  const existingRows = existingAnswers.gbp_locations;
  if (Array.isArray(existingRows)) {
    for (const row of existingRows) push((row as { url?: unknown })?.url);
  }
  push(existingAnswers.gbp_listing_url);
  for (const u of incoming) push(u);

  const merged = {
    ...existingAnswers,
    has_gbp: 'yes',
    gbp_locations: mergedUrls.map((url) => ({ url })),
  };

  const result = await upsertAnswer(
    sessionId,
    stepKey,
    merged,
    existingRow?.completed ?? false,
  );

  if (!result) {
    return { ok: false, error: 'Failed to save GBP locations' };
  }

  return { ok: true, rowCount: mergedUrls.length, stepKey };
}
