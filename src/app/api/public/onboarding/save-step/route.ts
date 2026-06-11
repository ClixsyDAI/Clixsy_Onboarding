import { NextRequest, NextResponse } from 'next/server';
import { getSessionByToken, upsertAnswer, updateSessionStep, createAuditEvent } from '@/lib/supabase/server';
import { validateStepDataForVersion } from '@/lib/onboarding/flow-version';
import { resolveSessionAccess } from '@/lib/onboarding/session-guard';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, stepKey, stepIndex, answers, completed } = body;

    // Validate required fields
    if (!token || !stepKey || typeof stepIndex !== 'number' || !answers) {
      return NextResponse.json(
        { error: 'Missing required fields: token, stepKey, stepIndex, answers' },
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

    // Stage 7 + Sprint 2 / #4: PIN gate, AM-bypass-aware. resolveSessionAccess
    // ALWAYS blocks a locked session (bypass skips the PIN, not the lock)
    // and waives only needs_pin under a valid x-am-bypass signature.
    // isAmBypass then gates the step_saved audit below — the answer write
    // itself is identical to a client save (AM-entered data is real).
    const access = await resolveSessionAccess(session, request);
    if (access.kind === 'locked') {
      return NextResponse.json(
        { error: 'Session is locked. Contact your Clixsy account manager.' },
        { status: access.lock === 'permanent' ? 423 : 429 }
      );
    }
    if (access.kind === 'needs_pin') {
      return NextResponse.json({ error: 'PIN verification required' }, { status: 401 });
    }
    const isAmBypass = access.isAmBypass;

    // Check if session is already submitted
    if (session.status === 'submitted') {
      return NextResponse.json(
        { error: 'Session has already been submitted' },
        { status: 400 }
      );
    }

    // Validate step data if marking as completed
    if (completed) {
      const validation = validateStepDataForVersion(session.flow_version || 'v1', stepKey, answers);
      if (!validation.success) {
        return NextResponse.json(
          { error: 'Validation failed', validationErrors: validation.errors },
          { status: 400 }
        );
      }
    }

    // Upsert the answer
    const savedAnswer = await upsertAnswer(session.id, stepKey, answers, completed || false);

    if (!savedAnswer) {
      return NextResponse.json(
        { error: 'Failed to save answers' },
        { status: 500 }
      );
    }

    // Update session current step if completed and moving forward
    let newCurrentStep = session.current_step;
    if (completed && stepIndex >= session.current_step) {
      newCurrentStep = stepIndex + 1;
      const newStatus = session.status === 'draft' ? 'in_progress' : session.status;
      await updateSessionStep(session.id, newCurrentStep, newStatus);
    }

    // Create audit event — suppressed for AM-bypass saves (#4): the
    // data write above is real, but the activity must not register as
    // client engagement.
    if (!isAmBypass) {
      await createAuditEvent(session.id, 'step_saved', {
        stepKey,
        stepIndex,
        completed,
        answersCount: Object.keys(answers).length,
      });
    }

    return NextResponse.json({
      success: true,
      currentStep: newCurrentStep,
      lastSavedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error saving step:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
