import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getSessionByToken, getSessionAnswers, getSignedLogoUrl, createAuditEvent, createOpenEvent, getClientById } from '@/lib/supabase/server';
import { getStepsForVersion } from '@/lib/onboarding/flow-version';
import { getSiteIntelligenceSnapshots } from '@/lib/supabase/server';
import { checkSessionGuard } from '@/lib/onboarding/session-guard';
import { capUserAgent, hashRequestIp } from '@/lib/onboarding/open-event-ip';
import { verifyAmBypass, AM_BYPASS_PARAM } from '@/lib/onboarding/am-bypass';

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

    // Get session by token. Wrap in a narrower try/catch so server-config
    // failures (e.g. missing SUPABASE_SERVICE_ROLE_KEY on a misconfigured
    // preview deploy) surface as a structured `{ error, code }` response
    // the client can branch on, instead of a bare 500 the client treats
    // as a malformed session payload (was: TypeError reading currentStep
    // off undefined in OnboardingShell).
    let session;
    try {
      session = await getSessionByToken(token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Error fetching session: getSessionByToken threw:', message, err instanceof Error ? err.stack : '');
      return NextResponse.json(
        { error: 'Service temporarily unavailable', code: 'session_lookup_failed', detail: message },
        { status: 503 }
      );
    }

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Sprint 2 / #4: AM bypass. A valid signature on the `am` query param
    // authorises the caller as an account manager filling the form on the
    // client's behalf — PIN entry is skipped and NO tracking fires below.
    // Verified per-request against the session id; an invalid/absent
    // signature falls through to the normal PIN gate.
    const isAmBypass = verifyAmBypass(
      session.id,
      searchParams.get(AM_BYPASS_PARAM),
    );

    // Stage 7: PIN gate. Resolve whether the caller is authorised to see
    // the full session. Locked sessions / unauthenticated sessions get a
    // minimal payload — just enough for the page to render the right
    // screen (PIN entry / "locked" message) without leaking answers.
    const guard = isAmBypass
      ? ({ kind: 'ok', pinSet: session.pin_hash !== null } as const)
      : await checkSessionGuard(session);

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

    // Create audit event for session access. Sprint 2 / #4: suppressed
    // entirely for AM-bypass opens — an AM preparing the form must not
    // look like client activity in the audit trail.
    if (!isAmBypass) {
      await createAuditEvent(session.id, 'session_accessed', {
        ip: request.headers.get('x-forwarded-for') || 'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
      });
    }

    // Phase 1 of the workbook Onboarding tab (migration 008): append a
    // row to `onboarding_open_events` for the workbook's Open History
    // modal (Phase 6.1 of the spec). IP is hashed (sha256(ip || salt))
    // before storage; raw IP never lands in the DB.
    //
    // Emitted only after `guard.kind === 'ok'` (i.e. the caller has
    // passed PIN verification when one is configured). Locked /
    // needs_pin responses are not counted as opens.
    //
    // Use Next.js after() to run the INSERT after the response is sent.
    // This keeps the serverless function alive on Vercel — a plain
    // `void ... .catch(log)` fire-and-forget is torn down with the
    // function when the response ships, so the Supabase HTTP request
    // never lands (see PR #11 post-merge verification). Same pattern
    // as src/app/api/admin/site-intelligence/analyze/route.ts.
    // Sprint 2 / #4: open events are likewise suppressed for AM-bypass —
    // the workbook's Open History must only count real client opens.
    if (!isAmBypass) {
      const userAgent = capUserAgent(request.headers.get('user-agent'));
      const ipHash = hashRequestIp(request.headers.get('x-forwarded-for'));
      after(async () => {
        try {
          await createOpenEvent(session.id, { userAgent, ipHash });
        } catch (err) {
          console.warn('[session.GET] onboarding_open_events insert failed:', err);
        }
      });
    }

    // Format answers by step key
    const answersByStep: Record<string, { answers: Record<string, unknown>; completed: boolean }> = {};
    answers.forEach(answer => {
      answersByStep[answer.step_key] = {
        answers: answer.answers,
        completed: answer.completed,
      };
    });

    const steps = getStepsForVersion(session.flow_version);

    // Stage 9: vertical defaults to 'law_firm' for ANY of: column missing
    // (pre-Stage-1 rows), column NULL (shouldn't happen — Stage 1 set NOT
    // NULL DEFAULT — but belt + braces), or column value not one of the
    // known enum strings (forward-compat for someone trying out a new
    // vertical name without updating the client). Pre-form gates (PIN +
    // welcome modal) don't care about vertical, so this normalisation
    // can't poison the gated screens.
    const rawVertical = (session as unknown as { vertical?: string | null }).vertical;
    const vertical: 'law_firm' | 'home_services' =
      rawVertical === 'home_services' ? 'home_services' : 'law_firm';

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
        // Sprint 2 / #4: informs the Wizard it's running in AM-bypass mode
        // (suppress popups, attach the bypass header to mutating calls).
        // Display-only — every write endpoint re-verifies the signature.
        isAmBypass,
        // Stage 8 / S12.2: account-manager name for the rebuilt thank-you
        // screen copy. Defaults to "your account manager" client-side if
        // unset (legacy / pre-Stage-1 rows).
        accountManager: (session as unknown as { account_manager?: string | null }).account_manager ?? null,
        // Stage 9 / home-services PR: see the rawVertical normalisation
        // above. NEVER null/undefined to the client — the Wizard treats
        // 'law_firm' as the safe default that re-renders every existing
        // step. PIN gate / locked screen don't read this field at all.
        vertical,
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
    // Pre-fix logging was a single `console.error('Error fetching session:', error)`
    // which Vercel's runtime-log table truncated to "Error fetching session: Err..."
    // — leaving the diagnosis blind to whichever Supabase call actually
    // threw. Spell the message + stack out as separate string fields so
    // the truncation can't eat the useful half.
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('[session.GET] outer catch | message:', message);
    if (stack) console.error('[session.GET] outer catch | stack:', stack);
    return NextResponse.json(
      { error: 'Internal server error', code: 'unknown', detail: message },
      { status: 500 }
    );
  }
}
