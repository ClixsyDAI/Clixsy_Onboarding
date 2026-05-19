import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { computeAccessChecklist, generateMissingAccessText, AnswersByStep } from '@/lib/onboarding/accessChecklist';
import { computeAccessChecklistV2 } from '@/lib/onboarding/accessChecklist-v2';

interface AnswerRow {
  step_key: string;
  answers: Record<string, unknown>;
  completed: boolean;
  updated_at: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = createServiceRoleClient();

    // Fetch session — including the new account_manager / vertical
    // fields (P1) and the PIN-state columns (P2). pin_hash itself
    // is NEVER returned to the client; we surface a boolean `pin_set`
    // derived from it instead.
    const { data: sessionData, error: sessionError } = await supabase
      .from('onboarding_sessions')
      .select(`
        id,
        token,
        status,
        flow_version,
        current_step,
        last_saved_at,
        submitted_at,
        created_at,
        logo_url,
        account_manager,
        vertical,
        pin_hash,
        pin_attempts,
        pin_lockout_until,
        pin_locked_at,
        clients (
          client_name,
          primary_contact_name,
          primary_contact_email
        )
      `)
      .eq('id', id)
      .single();

    if (sessionError) {
      console.error('Error fetching session:', sessionError);
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Transform clients from array to single object + redact pin_hash.
    const { pin_hash, ...sessionWithoutHash } = sessionData as Record<string, unknown> & { pin_hash: string | null };
    const transformedSession = {
      ...sessionWithoutHash,
      pin_set: pin_hash !== null,
      clients: Array.isArray((sessionData as { clients: unknown }).clients)
        ? (sessionData as { clients: unknown[] }).clients[0] || null
        : (sessionData as { clients: unknown }).clients,
    };

    // Fetch answers
    const { data: answersData, error: answersError } = await supabase
      .from('onboarding_answers')
      .select('*')
      .eq('session_id', id)
      .order('updated_at', { ascending: true });

    if (answersError) {
      console.error('Error fetching answers:', answersError);
    }

    // Build answers by step for access checklist
    const answersByStep: AnswersByStep = {};
    ((answersData || []) as AnswerRow[]).forEach(answer => {
      answersByStep[answer.step_key] = answer.answers || {};
    });

    // Compute access checklist (version-aware)
    const flowVersion = (transformedSession as Record<string, unknown>).flow_version as string || 'v1';
    const accessChecklist = flowVersion === 'v2'
      ? computeAccessChecklistV2(answersByStep)
      : computeAccessChecklist(answersByStep);
    const missingAccessText = generateMissingAccessText(accessChecklist);

    return NextResponse.json({
      session: transformedSession,
      answers: answersData || [],
      accessChecklist: {
        items: accessChecklist.items,
        missingCount: accessChecklist.missingCount,
        presentCount: accessChecklist.presentCount,
        notApplicableCount: accessChecklist.notApplicableCount,
        missingKeys: accessChecklist.missingKeys,
        presentKeys: accessChecklist.presentKeys,
        missingAccessText,
      },
    });
  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = createServiceRoleClient();

    // First, get the session to find the client_id
    const { data: sessionData, error: sessionFetchError } = await supabase
      .from('onboarding_sessions')
      .select('client_id')
      .eq('id', id)
      .single();

    if (sessionFetchError) {
      console.error('Error fetching session:', sessionFetchError);
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    const clientId = sessionData.client_id;

    // Delete answers first (due to foreign key constraint)
    const { error: answersError } = await supabase
      .from('onboarding_answers')
      .delete()
      .eq('session_id', id);

    if (answersError) {
      console.error('Error deleting answers:', answersError);
      return NextResponse.json(
        { error: 'Failed to delete session answers' },
        { status: 500 }
      );
    }

    // Delete the session
    const { error: sessionError } = await supabase
      .from('onboarding_sessions')
      .delete()
      .eq('id', id);

    if (sessionError) {
      console.error('Error deleting session:', sessionError);
      return NextResponse.json(
        { error: 'Failed to delete session' },
        { status: 500 }
      );
    }

    // Delete the client (each client has one session in this tool)
    if (clientId) {
      const { error: clientError } = await supabase
        .from('clients')
        .delete()
        .eq('id', clientId);

      if (clientError) {
        console.error('Error deleting client:', clientError);
        // Don't fail the request, session is already deleted
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
