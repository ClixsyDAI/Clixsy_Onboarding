import { NextRequest, NextResponse } from 'next/server';
import { getSessionByToken, getSessionAnswers, getSignedLogoUrl, createAuditEvent, getClientById } from '@/lib/supabase/server';
import { getStepsForVersion } from '@/lib/onboarding/flow-version';
import { getSiteIntelligenceSnapshots } from '@/lib/supabase/server';
import { checkSessionGuard } from '@/lib/onboarding/session-guard';

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

    // Stage 7: PIN gate. Resolve whether the caller is authorised to see
    // the full session. Locked sessions / unauthenticated sessions get a
    // minimal payload — just enough for the page to render the right
    // screen (PIN entry / "locked" message) without leaking answers.
    const guard = await checkSessionGuard(session);

    // We still want to surface the client company name on the gated
    // screens because the PIN-entry page should show e.g. "Enter your
    // PIN to access the onboarding for Jungle Law" — so the user knows
    // they're at the right link. Same for the locked screen.
    const client = await getClientById(session.client_id);
    const clientName = client?.client_name || '';

    if (guard.kind === 'locked') {
      return NextResponse.json(
        {
          locked: guard.lock,
          retryAfter: guard.retryAfter ?? null,
          client: { name: clientName },
        },
        { status: guard.lock === 'permanent' ? 423 : 429 }
      );
    }

    if (guard.kind === 'needs_pin') {
      return NextResponse.json(
        {
          needsPin: true,
          client: { name: clientName },
        },
        { status: 401 }
      );
    }

    // guard.kind === 'ok' — proceed with full payload.

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
        // Stage 7: surface flags the client-side wizard uses to gate P3 + P4.
        pinSet: guard.pinSet,
        welcomeWizardSeen: (session as unknown as { welcome_wizard_seen?: boolean }).welcome_wizard_seen ?? false,
        // Stage 8 / S12.2: account-manager name for the rebuilt thank-you
        // screen copy. Defaults to "your account manager" client-side if
        // unset (legacy / pre-Stage-1 rows).
        accountManager: (session as unknown as { account_manager?: string | null }).account_manager ?? null,
        // Stage 9 / home-services PR: surface vertical so the Wizard can
        // branch Step 7 + per-vertical copy. Defaults to 'law_firm' on
        // the server side already (Stage 1 migration 005 set NOT NULL
        // DEFAULT 'law_firm'); the `?? 'law_firm'` here is belt + braces
        // for legacy rows seeded before the column existed.
        vertical: (session as unknown as { vertical?: string }).vertical ?? 'law_firm',
      },
      client: {
        name: clientName,
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
