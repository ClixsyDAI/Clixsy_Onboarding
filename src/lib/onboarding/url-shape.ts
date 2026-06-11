// =============================================================
// isLikelyUrl — cheap structural URL guard
// =============================================================
//
// Gate for the auto-prefill seed (create route) and, indirectly, the
// auto-scan trigger: does the value parse as an http(s) URL with a
// dotted host whose final label looks like a TLD? It rejects the junk
// GHL templating sends when a website field is unset or filler — "N/A",
// "tbd", "null", a bare word with no dot — so we never seed that into
// the form field or burn a Firecrawl/PageSpeed scan on it.
//
// This is NOT a reachability check (a well-formed but dead domain still
// passes — runSiteAnalysis's hasUsableContent gate handles those by
// marking the scan 'failed', which the wizard surfaces as a retry).
//
// NOTE: a behaviourally-identical copy lives in the dashboard repo's
// GHL webhook (app/api/webhooks/ghl/opportunity-onboarded/route.ts).
// The two repos don't share a package; keep them in sync by hand.
export function isLikelyUrl(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  let candidate = value.trim();
  if (!candidate) return false;

  // Prepend a scheme so bare hosts ("example.com") parse; mirrors the
  // normalizeUrl behaviour the analyzer applies before storing.
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = 'https://' + candidate;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname;
  if (!host.includes('.')) return false;

  // Reject empty labels ("foo.", ".com", "a..b") and a too-short TLD.
  const labels = host.split('.');
  if (labels.some((label) => label.length === 0)) return false;
  if (labels[labels.length - 1].length < 2) return false;

  return true;
}
