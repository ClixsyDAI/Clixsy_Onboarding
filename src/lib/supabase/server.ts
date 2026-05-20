import { createClient } from '@supabase/supabase-js';

// Server-side Supabase client with service role for bypassing RLS
// ONLY use this on the server side for public token-based access

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export function createServiceRoleClient() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Types for database operations
export interface OnboardingSession {
  id: string;
  agency_id: string;
  client_id: string;
  token: string;
  status: 'draft' | 'in_progress' | 'submitted';
  flow_version: 'v1' | 'v2';
  current_step: number;
  last_saved_at: string | null;
  submitted_at: string | null;
  logo_path: string | null;
  logo_url: string | null;
  created_at: string;
  // Stage 1 (migration 005) — PIN gate state.
  pin_hash: string | null;
  pin_attempts: number;
  pin_lockout_until: string | null;
  pin_locked_at: string | null;
  // Stage 7 (migration 006) — first-login welcome modal flag.
  welcome_wizard_seen: boolean;
}

export interface OnboardingAnswer {
  id: string;
  session_id: string;
  step_key: string;
  answers: Record<string, unknown>;
  completed: boolean;
  updated_at: string;
}

export interface Client {
  id: string;
  agency_id: string;
  client_name: string;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  created_at: string;
}

// Helper functions for common operations
export async function getClientById(clientId: string): Promise<Client | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (error || !data) {
    return null;
  }

  return data as Client;
}

export async function getSessionByToken(token: string): Promise<OnboardingSession | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('onboarding_sessions')
    .select('*')
    .eq('token', token)
    .single();

  if (error || !data) {
    return null;
  }

  return data as OnboardingSession;
}

export async function getSessionAnswers(sessionId: string): Promise<OnboardingAnswer[]> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('onboarding_answers')
    .select('*')
    .eq('session_id', sessionId)
    .order('updated_at', { ascending: true });

  if (error) {
    console.error('Error fetching answers:', error);
    return [];
  }

  return (data || []) as OnboardingAnswer[];
}

export async function upsertAnswer(
  sessionId: string,
  stepKey: string,
  answers: Record<string, unknown>,
  completed: boolean
): Promise<OnboardingAnswer | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('onboarding_answers')
    .upsert(
      {
        session_id: sessionId,
        step_key: stepKey,
        answers,
        completed,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: 'session_id,step_key',
      }
    )
    .select()
    .single();

  if (error) {
    console.error('Error upserting answer:', error);
    return null;
  }

  return data as OnboardingAnswer;
}

export async function updateSessionStep(
  sessionId: string,
  currentStep: number,
  status?: 'draft' | 'in_progress' | 'submitted'
): Promise<boolean> {
  const supabase = createServiceRoleClient();

  const updateData: Partial<OnboardingSession> = {
    current_step: currentStep,
    last_saved_at: new Date().toISOString(),
  };

  if (status) {
    updateData.status = status;
    if (status === 'submitted') {
      updateData.submitted_at = new Date().toISOString();
    }
  }

  const { error } = await supabase
    .from('onboarding_sessions')
    .update(updateData)
    .eq('id', sessionId);

  if (error) {
    console.error('Error updating session:', error);
    return false;
  }

  return true;
}

export async function createAuditEvent(
  sessionId: string,
  eventType: string,
  payload?: Record<string, unknown>
): Promise<void> {
  const supabase = createServiceRoleClient();

  await supabase.from('onboarding_audit_events').insert({
    session_id: sessionId,
    event_type: eventType,
    payload,
  });
}

/**
 * Append a row to `onboarding_open_events` (migration 008). One row per
 * resolution of the public token-load route — i.e. per page-load of the
 * client-facing onboarding form once the session is found.
 *
 * Fire-and-forget by design: the caller awaits this only so a failure can
 * be logged, never so it can fail the session response. Open-history is
 * a Phase-6.1 modal in the workbook spec; missing rows degrade the modal,
 * but the session-resolve path must NEVER block on this write.
 *
 * Both `userAgent` and `ipHash` are nullable in the schema — pass `null`
 * (or just omit) if the caller can't compute them.
 */
export async function createOpenEvent(
  sessionId: string,
  opts: { userAgent?: string | null; ipHash?: string | null } = {}
): Promise<void> {
  const supabase = createServiceRoleClient();

  await supabase.from('onboarding_open_events').insert({
    session_id: sessionId,
    user_agent: opts.userAgent ?? null,
    ip_hash: opts.ipHash ?? null,
  });
}

// Get site intelligence snapshots from session
export async function getSiteIntelligenceSnapshots(sessionId: string): Promise<{
  prefill_map: Record<string, unknown> | null;
  question_overrides: Record<string, unknown> | null;
  branding: Record<string, unknown> | null;
  insights: Record<string, unknown> | null;
} | null> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from('onboarding_sessions')
    .select('si_prefill_snapshot, si_overrides_snapshot, si_branding_snapshot, si_insights_snapshot, site_intelligence_id')
    .eq('id', sessionId)
    .single();

  if (error || !data) return null;

  // Return snapshots if they exist
  if (data.si_prefill_snapshot || data.si_branding_snapshot || data.si_insights_snapshot) {
    return {
      prefill_map: data.si_prefill_snapshot,
      question_overrides: data.si_overrides_snapshot,
      branding: data.si_branding_snapshot,
      insights: data.si_insights_snapshot,
    };
  }

  // If no snapshots but we have a linked record, try to fetch from the record
  if (data.site_intelligence_id) {
    const { data: si } = await supabase
      .from('onboarding_site_intelligence')
      .select('prefill_map, question_overrides, branding, insights')
      .eq('id', data.site_intelligence_id)
      .eq('status', 'completed')
      .single();

    if (si) {
      return {
        prefill_map: si.prefill_map,
        question_overrides: si.question_overrides,
        branding: si.branding,
        insights: si.insights,
      };
    }
  }

  return null;
}

// Generate signed URL for logo
export async function getSignedLogoUrl(logoPath: string): Promise<string | null> {
  if (!logoPath) return null;

  const supabase = createServiceRoleClient();

  const { data, error } = await supabase.storage
    .from('onboarding-logos')
    .createSignedUrl(logoPath, 3600); // 1 hour expiry

  if (error) {
    console.error('Error creating signed URL:', error);
    return null;
  }

  return data.signedUrl;
}
