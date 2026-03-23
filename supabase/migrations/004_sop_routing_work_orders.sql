-- =============================================
-- SOP Routing + Work Orders
-- =============================================

-- SOP routing results per session
CREATE TABLE onboarding_sop_routing (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
    big5 JSONB NOT NULL DEFAULT '{}',
    migration JSONB NOT NULL DEFAULT '{}',
    required_sops TEXT[] NOT NULL DEFAULT '{}',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    UNIQUE(session_id)
);

-- Internal work orders generated after submission
CREATE TABLE onboarding_work_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
    tasks JSONB NOT NULL DEFAULT '[]',
    generated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    final_report_status TEXT DEFAULT 'pending' CHECK (final_report_status IN ('pending', 'in_progress', 'completed')),
    assignees_defaulted BOOLEAN DEFAULT TRUE,
    UNIQUE(session_id)
);

-- Indexes
CREATE INDEX idx_sop_routing_session ON onboarding_sop_routing(session_id);
CREATE INDEX idx_work_orders_session ON onboarding_work_orders(session_id);

-- RLS
ALTER TABLE onboarding_sop_routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_work_orders ENABLE ROW LEVEL SECURITY;
