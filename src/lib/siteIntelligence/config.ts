// Site Intelligence + SOP Routing feature flags and configuration

export function isSiteIntelligenceEnabled(): boolean {
  return process.env.ENABLE_SITE_INTELLIGENCE !== 'false' &&
    process.env.ENABLE_SITE_INTELLIGENCE_PREFILL !== 'false';
}

export function isSOPRoutingEnabled(): boolean {
  return process.env.ENABLE_SOP_ROUTING !== 'false';
}

export function hasFirecrawlKey(): boolean {
  return !!process.env.FIRECRAWL_API_KEY;
}

export function hasWappalyzerKey(): boolean {
  return !!process.env.WAPPALYZER_API_KEY;
}

export function hasBuiltWithKey(): boolean {
  return !!process.env.BUILTWITH_API_KEY;
}

export function hasPageSpeedKey(): boolean {
  return !!process.env.PAGESPEED_API_KEY;
}

export function getFirecrawlKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set');
  return key;
}

export function getWappalyzerKey(): string {
  const key = process.env.WAPPALYZER_API_KEY;
  if (!key) throw new Error('WAPPALYZER_API_KEY is not set');
  return key;
}

export function getBuiltWithKey(): string {
  const key = process.env.BUILTWITH_API_KEY;
  if (!key) throw new Error('BUILTWITH_API_KEY is not set');
  return key;
}

export function getPageSpeedKey(): string {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) throw new Error('PAGESPEED_API_KEY is not set');
  return key;
}
