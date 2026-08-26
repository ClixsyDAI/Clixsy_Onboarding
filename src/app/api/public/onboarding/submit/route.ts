import { NextRequest, NextResponse, after } from 'next/server';
import { fireDashboardClientBridge } from '@/lib/onboarding/dashboard-bridge';
import { exportSubmissionToSheet } from '@/lib/onboarding/sheet-export';
import {
  getSessionByToken as realGetSessionByToken,
  getSessionAnswers as realGetSessionAnswers,
  updateSessionStep as realUpdateSessionStep,
  recordAuditEvent as realRecordAuditEvent,
  upsertAnswer as realUpsertAnswer,
  type OnboardingSession,
  type OnboardingAnswer,
} from '@/lib/supabase/server';
import { getStepsForVersion } from '@/lib/onboarding/flow-version';
import { checkSessionGuard as realCheckSessionGuard, decideAccess, type GuardResult, type SessionRow } from '@/lib/onboarding/session-guard';
import { isAmBypassRequest } from '@/lib/onboarding/am-bypass';

// ---------------------------------------------------------------------------
// Test-mode shim
// ---------------------------------------------------------------------------
// Mirrors the GHL_RECEIVER_TEST_MODE pattern from PR #43. When
// process.env.ONBOARDING_SUBMIT_TEST_MODE === '1', the route swaps every
// Supabase call and the PIN/session-guard for in-memory fakes backed by
// __ONBOARDING_SUBMIT_TEST_STATE__ on globalThis. Tests seed that state
// before each call. NEVER enable this in production.
// ---------------------------------------------------------------------------
interface TestState {
  sessions: Record<string, OnboardingSession>;          // by token
  answers: Record<string, OnboardingAnswer[]>;          // by session id
  audits: Array<{ sessionId: string; eventType: string; payload?: Record<string, unknown> }>;
  guard: GuardResult;
}

declare global {
  // eslint-disable-next-line no-var
  var __ONBOARDING_SUBMIT_TEST_STATE__: TestState | undefined;
}

const TEST_MODE = process.env.ONBOARDING_SUBMIT_TEST_MODE === '1';

function getTestState(): TestState {
  if (!globalThis.__ONBOARDING_SUBMIT_TEST_STATE__) {
    throw new Error('ONBOARDING_SUBMIT_TEST_MODE enabled but no __ONBOARDING_SUBMIT_TEST_STATE__ provided');
  }
  return globalThis.__ONBOARDING_SUBMIT_TEST_STATE__;
}

const getSessionByToken: typeof realGetSessionByToken = TEST_MODE
  ? async (token) => getTestState().sessions[token] ?? null
  : realGetSessionByToken;

const getSessionAnswers: typeof realGetSessionAnswers = TEST_MODE
  ? async (sessionId) => getTestState().answers[sessionId] ?? []
  : realGetSessionAnswers;

const upsertAnswer: typeof realUpsertAnswer = TEST_MODE
  ? async (sessionId, stepKey, answersPayload, completed) => {
      const state = getTestState();
      const rows = state.answers[sessionId] ?? [];
      const existing = rows.find((r) => r.step_key === stepKey);
      const now = new Date().toISOString();
      if (existing) {
        existing.answers = answersPayload;
        existing.completed = completed;
        existing.updated_at = now;
        return existing;
      }
      const created: OnboardingAnswer = {
        id: `test-${stepKey}-${Date.now()}`,
        session_id: sessionId,
        step_key: stepKey,
        answers: answersPayload,
        completed,
        updated_at: now,
      };
      state.answers[sessionId] = [...rows, created];
      return created;
    }
  : realUpsertAnswer;

const updateSessionStep: typeof realUpdateSessionStep = TEST_MODE
  ? async (sessionId, currentStep, status) => {
      const state = getTestState();
      const session = Object.values(state.sessions).find((s) => s.id === sessionId);
      if (!session) return false;
      session.current_step = currentStep;
      session.last_saved_at = new Date().toISOString();
      if (status) {
        session.status = status;
        if (status === 'submitted') session.submitted_at = new Date().toISOString();
      }
      return true;
    }
  : realUpdateSessionStep;

const recordAuditEvent: typeof realRecordAuditEvent = TEST_MODE
  ? async (sessionId, eventType, payload) => {
      getTestState().audits.push({ sessionId, eventType, payload });
    }
  : realRecordAuditEvent;

const checkSessionGuard: (s: SessionRow) => Promise<GuardResult> = TEST_MODE
  ? async () => getTestState().guard
  : realCheckSessionGuard;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token } = body;

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

    // Stage 7 + Sprint 2 / #4: PIN gate, AM-bypass-aware. Uses decideAccess
    // with the (possibly test-shimmed) checkSessionGuard so the same
    // lock-always / PIN-skippable rule applies without bypassing the
    // submit route's in-memory test guard. Submission writes real data;
    // only the session_submitted audit below is suppressed under bypass.
    const access = decideAccess(
      await checkSessionGuard(session),
      isAmBypassRequest(session.id, request),
    );
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

    // Check if already submitted
    if (session.status === 'submitted') {
      return NextResponse.json(
        { error: 'Session has already been submitted' },
        { status: 400 }
      );
    }

    // Get all answers to verify completion
    const answers = await getSessionAnswers(session.id);

    // Self-heal: the semantic meaning of POST /submit is "user is submitting now," so the
    // submit step row is by definition complete. This eliminates a client-side race condition
    // where autosave could clobber the submit row's completed flag (see fix/onboarding-submit-race PR).
    const existingSubmitAnswer = answers.find(a => a.step_key === 'submit');
    const submitPayload = (existingSubmitAnswer?.answers as Record<string, unknown> | undefined) ?? {};
    const healed = await upsertAnswer(session.id, 'submit', submitPayload, true);
    if (!healed) {
      return NextResponse.json(
        { error: 'Failed to mark submit step complete', details: 'upsertAnswer returned null' },
        { status: 500 }
      );
    }

    const answeredSteps = new Set(
      answers.filter(a => a.completed).map(a => a.step_key)
    );
    answeredSteps.add('submit');

    // Check required steps are completed (at minimum, first step and final review)
    const flowVersion = session.flow_version || 'v1';
    const requiredSteps = flowVersion === 'v2'
      ? ['primary_contact', 'submit']
      : ['business_basics', 'final_review'];
    const missingSteps = requiredSteps.filter(step => !answeredSteps.has(step));

    if (missingSteps.length > 0) {
      return NextResponse.json(
        {
          error: 'Required steps not completed',
          missingSteps,
        },
        { status: 400 }
      );
    }

    const steps = getStepsForVersion(flowVersion);

    // Update session status to submitted
    const success = await updateSessionStep(session.id, steps.length, 'submitted');

    if (!success) {
      return NextResponse.json(
        { error: 'Failed to submit session' },
        { status: 500 }
      );
    }

    // Onboarding→dashboard bridge: reconcile this client into the
    // dashboard's projects.json. Runs via after() AFTER the response is
    // sent, so it never blocks the client submit and never alters the
    // response shape below. Failures are logged + audited and safely
    // retryable (the dashboard endpoint is idempotent on workbook_id).
    // Skipped under the in-memory test-mode shim (no real network).
    //
    // REGISTERED BEFORE THE AUDIT WRITE, on purpose. The two sides are not
    // symmetric. The audit row is bookkeeping and is reconstructable from the
    // session row itself. The bridge and the sheet export are the ONLY things
    // that carry this submission out of Supabase, and the already-submitted
    // guard at :148-153 turns a re-submit into a 400 — so if an exception
    // between here and the response ever skipped them, the loss would be
    // permanent and unrecoverable behind that guard. Registering first is
    // cheap insurance against that; `after` only schedules, so nothing runs
    // any earlier than it did before.
    //
    // WHAT `after()` ACTUALLY GUARANTEES, corrected. Only REGISTRATION order
    // is ordered. It does NOT sequence execution: AfterContext builds its
    // queue as `new PQueue()` with no options
    // (next/dist/server/after/after-context.js), i.e. the p-queue default of
    // concurrency Infinity, so both callbacks below are started together and
    // run CONCURRENTLY. Nothing here may assume the bridge finishes, starts,
    // or even runs before the sheet export.
    //
    // THE ONE REAL DEPENDENCY, and why it holds anyway.
    // exportSubmissionToSheet re-reads submitted_at from the database
    // (sheet-export.ts:202-208, `select('submitted_at')`) rather than reading
    // the stale `session` object in scope. That read is satisfied by DB STATE
    // AT THE MOMENT IT RUNS, and `updateSessionStep(..., 'submitted')` above
    // is awaited to completion before either registration happens — so the
    // timestamp is already committed no matter which callback wins the race.
    // The export depends on the UPDATE, not on the bridge; there is no
    // ordering constraint between the two callbacks, and none is available.
    if (!TEST_MODE) {
      after(() => fireDashboardClientBridge(session));
      // Google Sheet roster export — same fire-and-forget contract as the
      // bridge: all failures are handled inside, nothing throws into the
      // submit path, and the two side effects stay independent.
      after(() => exportSubmissionToSheet(session));
    }

    // Create audit event — suppressed for AM-bypass submissions (#4).
    //
    // DEGRADE, LOUDLY. The submission itself is already committed and the two
    // exports are already scheduled, so failing the caller here would report a
    // failure that did not happen and invite a re-submit the 400 guard above
    // would refuse. `recordAuditEvent` never throws and logs at ERROR, so the
    // lost row is findable without the caller doing anything.
    if (!isAmBypass) {
      await recordAuditEvent(
        session.id,
        'session_submitted',
        {
          totalStepsCompleted: answeredSteps.size,
          totalSteps: steps.length,
        },
        {
          clientId: session.client_id,
          route: 'POST /api/public/onboarding/submit',
          succeeded:
            'the session is marked submitted and the dashboard bridge and sheet export are scheduled; only the audit row was lost',
        },
      );
    }

    return NextResponse.json({
      success: true,
      submittedAt: new Date().toISOString(),
      message: 'Thank you! Your onboarding has been submitted successfully.',
    });
  } catch (error) {
    console.error('Error submitting session:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
