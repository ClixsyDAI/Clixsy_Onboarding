import type { Branding, SiteInsights, TechStack, Metrics, Evidence } from '../schemas';

// =============================================
// Provider interface — pluggable data sources
// =============================================

export interface ProviderResult {
  branding?: Partial<Branding>;
  insights?: Partial<SiteInsights>;
  tech_stack?: Partial<TechStack>;
  metrics?: Partial<Metrics>;
  evidence: Evidence[];
}

export interface SiteIntelligenceProvider {
  name: string;
  run(websiteUrl: string): Promise<ProviderResult>;
}
