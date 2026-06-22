// =============================================================
// GBP locations normaliser (Phase 2 / Fix C — onboarding side)
// =============================================================
//
// The seo_targeting step stores `gbp_locations` as an array of { url }
// rows (the production repeater shape — see steps-v2.ts). Real submissions
// arrive with blank rows and many duplicates (one observed session had 53
// rows, mostly repeats of the same maps.app.goo.gl shortlink). This module
// normalises the array at save time:
//
//   - validates each row with Zod (string OR { url } object; junk dropped),
//   - drops empty / blank rows,
//   - de-duplicates by a normalised URL key (lower-cased host + path,
//     trailing slash + query/hash stripped so utm noise collapses);
//     opaque goo.gl shortlinks dedupe only on the full string,
//   - preserves first-seen order,
//   - and gates on has_gbp: if it isn't "yes", gbp_locations serialises to [].
//
// Pure + dependency-light (only Zod) so it unit-tests without a DB.

import { z } from 'zod';

/** A single GBP row on the wire: a bare string or a { url } object. */
const GbpRowSchema = z.union([
  z.string(),
  z.object({ url: z.string() }).passthrough(),
]);

/** The slice of seo_targeting answers this module cares about. */
const SeoTargetingSchema = z
  .object({
    has_gbp: z.string().optional(),
    gbp_locations: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Extract a usable URL string from a row, or undefined. */
function rowToUrl(row: unknown): string | undefined {
  const parsed = GbpRowSchema.safeParse(row);
  if (!parsed.success) return undefined;
  const url = typeof parsed.data === 'string' ? parsed.data : parsed.data.url;
  const trimmed = (url ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build a dedupe key for a URL. Normal URLs collapse on lower-cased
 * host+path with trailing slash and query/hash removed (kills utm/?entry
 * tracking noise). Opaque shortlinks (maps.app.goo.gl / *.goo.gl) carry
 * their identity in the short code, so they dedupe only on the full string.
 */
export function gbpDedupeKey(rawUrl: string): string {
  const s = rawUrl.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'maps.app.goo.gl' || host.endsWith('.goo.gl') || host === 'goo.gl') {
      // Opaque shortlink — distinct unless the full string matches.
      return s.toLowerCase().replace(/\/+$/, '');
    }
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}`; // query + hash intentionally dropped
  } catch {
    // Not a parseable URL — fall back to a trimmed, lower-cased literal.
    return s.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Validate, drop blanks, and de-duplicate a raw gbp_locations value into
 * the canonical wire shape `{ url: string }[]`, preserving first-seen order.
 */
export function dedupeGbpLocations(raw: unknown): { url: string }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: { url: string }[] = [];
  for (const row of raw) {
    const url = rowToUrl(row);
    if (!url) continue; // drop empty / blank / malformed rows
    const key = gbpDedupeKey(url);
    if (seen.has(key)) continue; // drop duplicate
    seen.add(key);
    out.push({ url }); // canonical { url } shape, original URL preserved
  }
  return out;
}

/**
 * Normalise a seo_targeting answers object before persisting it.
 * Returns a NEW object — never mutates the caller's. has_gbp is the gate:
 * anything other than "yes" forces gbp_locations to [].
 */
export function normaliseSeoTargetingAnswers(
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = SeoTargetingSchema.safeParse(answers);
  // Even if the optional fields fail, fall through with the raw object so we
  // never drop the client's other seo_targeting answers.
  const next: Record<string, unknown> = { ...answers };
  const hasGbp = parsed.success ? parsed.data.has_gbp : (answers.has_gbp as string | undefined);
  if (hasGbp !== 'yes') {
    next.gbp_locations = [];
    return next;
  }
  next.gbp_locations = dedupeGbpLocations(answers.gbp_locations);
  return next;
}
