-- =============================================
-- Site Intelligence - Data Model
-- =============================================

-- Site Intelligence records
CREATE TABLE onboarding_site_intelligence (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    website_url TEXT NOT NULL,
    domain TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    providers_used JSONB NOT NULL DEFAULT '{"firecrawl": false, "wappalyzer": false, "builtwith": false, "pagespeed": false}',
    branding JSONB,
    insights JSONB,
    tech_stack JSONB,
    metrics JSONB,
    prefill_map JSONB,
    question_overrides JSONB,
    evidence JSONB DEFAULT '[]',
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Link site intelligence to sessions (nullable — analysis is optional)
ALTER TABLE onboarding_sessions
    ADD COLUMN site_intelligence_id UUID REFERENCES onboarding_site_intelligence(id) ON DELETE SET NULL;

-- Snapshot columns on session so data is stable even if re-analysis happens
ALTER TABLE onboarding_sessions
    ADD COLUMN si_prefill_snapshot JSONB,
    ADD COLUMN si_overrides_snapshot JSONB,
    ADD COLUMN si_branding_snapshot JSONB,
    ADD COLUMN si_insights_snapshot JSONB;

-- Add website_url to clients table for convenience
ALTER TABLE clients
    ADD COLUMN website_url TEXT;

-- Indexes
CREATE INDEX idx_si_domain ON onboarding_site_intelligence(domain);
CREATE INDEX idx_si_status ON onboarding_site_intelligence(status);
CREATE INDEX idx_sessions_si_id ON onboarding_sessions(site_intelligence_id);

-- RLS
ALTER TABLE onboarding_site_intelligence ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (tool uses service role key)
-- No user-facing RLS policies needed since all access is via service role
