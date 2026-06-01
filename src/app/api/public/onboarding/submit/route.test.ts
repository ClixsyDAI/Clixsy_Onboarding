/**
 * submit route — end-to-end tests for the fix/onboarding-submit-race
 * fixes.
 *
 * Run with:
 *   $env:ONBOARDING_SUBMIT_TEST_MODE='1'; npx tsx src/app/api/public/onboarding/submit/route.test.ts
 * or via the npm script:
 *   npm run test:submit
 *
 * Test mode is activated by ONBOARDING_SUBMIT_TEST_MODE=1 (see the shim
 * at the top of route.ts, mirroring the GHL_RECEIVER_TEST_MODE pattern
 * from PR #43). The shim swaps every Supabase call + the PIN guard for
 * in-memory fakes backed by globalThis.__ONBOARDING_SUBMIT_TEST_STATE__.
 *
 * The 3 cases exercise the three behaviours guaranteed by Phase 1:
 *   1. Happy path — submit row already completed=true → 200.
 *   2. Self-heal — submit row exists with completed=false → 200 and the
 *      row is upserted to completed=true (proves the race fix works).
 *   3. Non-submit gap — primary_contact missing → 400 with missingSteps
 *      (proves the self-heal does NOT mask missing non-submit steps).
 */

// Enable test mode BEFORE the route module is imported. ESM hoists static
// imports above any top-level code, so the route module must be loaded
// via dynamic import() AFTER these env writes take effect.
process.env.ONBOARDING_SUBMIT_TEST_MODE = '1';
// Stub Supabase env vars so any top-level reads inside imported modules
// don't blow up. The shim short-circuits before any real client is
// created, but server.ts reads these at module top level.
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role';

import type { OnboardingSession, OnboardingAnswer } from '../../../../../lib/supabase/server';
import type { GuardResult } from '../../../../../lib/onboarding/session-guard';
import type { NextRequest } from 'next/server';
type PostFn = (req: NextRequest) => Promise<Response>;

interface TestState {
  sessions: Record<string, OnboardingSession>;
  answers: Record<string, OnboardingAnswer[]>;
  audits: Array<{ sessionId: string; eventType: string; payload?: Record<string, unknown> }>;
  guard: GuardResult;
}

declare global {
  // eslint-disable-next-line no-var
  var __ONBOARDING_SUBMIT_TEST_STATE__: TestState | undefined;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    console.error(`  FAIL  ${message}`);
  }
}

function buildSession(overrides: Partial<OnboardingSession> = {}): OnboardingSession {
  return {
    id: 'session-1',
    agency_id: 'agency-1',
    client_id: 'client-1',
    token: 'token-abc',
    status: 'in_progress',
    flow_version: 'v2',
    current_step: 0,
    last_saved_at: null,
    submitted_at: null,
    logo_path: null,
    logo_url: null,
    created_at: new Date().toISOString(),
    pin_hash: null,
    pin_attempts: 0,
    pin_lockout_until: null,
    pin_locked_at: null,
    welcome_wizard_seen: false,
    site_intelligence_id: null,
    ...overrides,
  };
}

function buildAnswer(sessionId: string, stepKey: string, completed: boolean, answers: Record<string, unknown> = {}): OnboardingAnswer {
  return {
    id: `answer-${stepKey}`,
    session_id: sessionId,
    step_key: stepKey,
    answers,
    completed,
    updated_at: new Date().toISOString(),
  };
}

function seedState(session: OnboardingSession, answers: OnboardingAnswer[]): void {
  globalThis.__ONBOARDING_SUBMIT_TEST_STATE__ = {
    sessions: { [session.token]: session },
    answers: { [session.id]: answers },
    audits: [],
    guard: { kind: 'ok', pinSet: false } as GuardResult,
  };
}

function makeRequest(token: string): import('next/server').NextRequest {
  // POST only awaits request.json(); a minimal duck-typed shape is enough.
  return {
    json: async () => ({ token }),
  } as unknown as import('next/server').NextRequest;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function run() {
  // Dynamic-import the route module AFTER env-vars are set so the
  // TEST_MODE shim resolves to true at module load.
  const { POST } = (await import('./route')) as { POST: PostFn };

  // -----------------------------------------------------------------
  // Test 1 — happy path: submit + primary_contact both completed → 200
  // -----------------------------------------------------------------
  console.log('\n--- Test 1: all required steps completed (incl. submit) → 200 ---');
  {
    const session = buildSession({ id: 'sess-happy', token: 'token-happy' });
    seedState(session, [
      buildAnswer(session.id, 'primary_contact', true),
      buildAnswer(session.id, 'submit', true),
    ]);
    const res = await POST(makeRequest(session.token));
    const body = await readJson(res);
    assert(res.status === 200, `status === 200 (got ${res.status})`);
    assert(body.success === true, `body.success === true (got ${JSON.stringify(body)})`);
    assert(typeof body.submittedAt === 'string', 'body.submittedAt is a string');
  }

  // -----------------------------------------------------------------
  // Test 2 — self-heal: submit row completed=false → 200 + DB shows true
  // -----------------------------------------------------------------
  console.log('\n--- Test 2: submit row completed=false self-heals to true → 200 ---');
  {
    const session = buildSession({ id: 'sess-heal', token: 'token-heal' });
    seedState(session, [
      buildAnswer(session.id, 'primary_contact', true),
      buildAnswer(session.id, 'submit', false, { someClientField: 'value' }),
    ]);
    const res = await POST(makeRequest(session.token));
    const body = await readJson(res);
    assert(res.status === 200, `status === 200 (got ${res.status}, body=${JSON.stringify(body)})`);
    assert(body.success === true, 'body.success === true');

    const state = globalThis.__ONBOARDING_SUBMIT_TEST_STATE__!;
    const submitRow = state.answers[session.id].find((a) => a.step_key === 'submit');
    assert(!!submitRow, 'submit row still exists after the call');
    assert(submitRow?.completed === true, `submit row.completed === true after self-heal (got ${submitRow?.completed})`);
    // Bonus: ensure the existing payload was preserved (the route reuses existingSubmitAnswer.answers).
    assert(
      (submitRow?.answers as Record<string, unknown>)?.someClientField === 'value',
      'existing submit payload preserved during self-heal'
    );
  }

  // -----------------------------------------------------------------
  // Test 3 — non-submit gap: primary_contact missing → 400 missingSteps
  // -----------------------------------------------------------------
  console.log('\n--- Test 3: non-submit required step missing → 400 with missingSteps ---');
  {
    const session = buildSession({ id: 'sess-gap', token: 'token-gap' });
    seedState(session, [
      buildAnswer(session.id, 'primary_contact', false),
      buildAnswer(session.id, 'submit', true),
    ]);
    const res = await POST(makeRequest(session.token));
    const body = await readJson(res);
    assert(res.status === 400, `status === 400 (got ${res.status})`);
    const missing = (body as { missingSteps?: string[] }).missingSteps;
    assert(Array.isArray(missing), 'body.missingSteps is an array');
    assert(
      Array.isArray(missing) && missing.includes('primary_contact'),
      `missingSteps includes 'primary_contact' (got ${JSON.stringify(missing)})`
    );
    assert(
      Array.isArray(missing) && !missing.includes('submit'),
      `missingSteps does NOT include 'submit' — self-heal worked (got ${JSON.stringify(missing)})`
    );
  }

  console.log('\n=========================================');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('=========================================');
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
