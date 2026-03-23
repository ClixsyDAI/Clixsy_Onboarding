import { NextRequest, NextResponse } from 'next/server';
import { getSessionByToken, getSessionAnswers, getSignedLogoUrl, createAuditEvent, getClientById } from '@/lib/supabase/server';
import { getStepsForVersion } from '@/lib/onboarding/flow-version';
import { getSiteIntelligenceSnapshots } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token');

    if (!token) {
      return NextResponse.json(
        { error: 'Token is required' },
        { status: 400 }
      );
    }

    // Get session by token
    const session = await getSessionByToken(token);

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Get client info for personalization
    const client = await getClientById(session.client_id);

    // Get all answers for this session
    const answers = await getSessionAnswers(session.id);

    // Get signed logo URL if exists
    let logoUrl = session.logo_url;
    if (session.logo_path && !logoUrl) {
      logoUrl = await getSignedLogoUrl(session.logo_path);
    }

    // Get site intelligence snapshots (from session snapshots)
    const siteIntelligence = await getSiteIntelligenceSnapshots(session.id);

    // Create audit event for session access
    await createAuditEvent(session.id, 'session_accessed', {
      ip: request.headers.get('x-forwarded-for') || 'unknown',
      userAgent: request.headers.get('user-agent') || 'unknown',
    });

    // Format answers by step key
    const answersByStep: Record<string, { answers: Record<string, unknown>; completed: boolean }> = {};
    answers.forEach(answer => {
      answersByStep[answer.step_key] = {
        answers: answer.answers,
        completed: answer.completed,
      };
    });

    const steps = getStepsForVersion(session.flow_version);

    return NextResponse.json({
      session: {
        id: session.id,
        status: session.status,
        currentStep: session.current_step,
        flowVersion: session.flow_version || 'v1',
        logoUrl,
        lastSavedAt: session.last_saved_at,
        submittedAt: session.submitted_at,
      },
      client: {
        name: client?.client_name || '',
        contactName: client?.primary_contact_name || '',
      },
      answers: answersByStep,
      steps: steps.map(step => ({
        key: step.key,
        title: step.title,
        description: step.description,
        estimatedTime: step.estimatedTime,
      })),
      totalSteps: steps.length,
      siteIntelligence: siteIntelligence || null,
    });
  } catch (error) {
    console.error('Error fetching session:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
