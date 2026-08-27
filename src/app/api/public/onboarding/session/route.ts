import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getSessionByToken, getSessionAnswers, getSignedLogoUrl, recordAuditEvent, recordOpenEvent, getClientById } from '@/lib/supabase/server';
import { getStepsForVersion } from '@/lib/onboarding/flow-version';
import { getSiteIntelligenceSnapshots } from '@/lib/supabase/server';
import { getSiteIntelligence } from '@/lib/siteIntelligence/analyze';
import { resolveSessionAccess } from '@/lib/onboarding/session-guard';
import { capUserAgent, hashRequestIp } from '@/lib/onboarding/open-event-ip';

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

    // Stage 7 + Sprint 2 / #4: PIN gate, AM-bypass-aware. resolveSessionAccess
    // applies the shared rule — a locked session is ALWAYS blocked (the
    // bypass token skips the PIN, not the lock); needs_pin is waived only
    // under a valid `am` signature. Locked / needs_pin get a minimal
    // payload (just the client name for the gated screen) without leaking
    // answers; `ok` carries the verified isAmBypass flag used to suppress
    // the two tracking writes below.
    const access = await resolveSessionAccess(session, request);

    // We still want to surface the client company name on the gated
    // screens because the PIN-entry page should show e.g. "Enter your
    // PIN to access the onboarding for Jungle Law" — so the user knows
    // they're at the right link. Same for the locked screen.
    const client = await getClientById(session.client_id);
    const clientName = client?.client_name || '';

    if (access.kind === 'locked') {
      return NextResponse.json(
        {
          locked: access.lock,
          retryAfter: access.retryAfter ?? null,
          client: { name: clientName },
        },
        { status: access.lock === 'permanent' ? 423 : 429 }
      );
    }

    if (access.kind === 'needs_pin') {
      return NextResponse.json(
        {
          needsPin: true,
          client: { name: clientName },
        },
        { status: 401 }
      );
    }

    // access.kind === 'ok' — proceed with full payload.
    const isAmBypass = access.isAmBypass;

    // Get all answers for this session
    const answers = await getSessionAnswers(session.id);

    // Get signed logo URL if exists
    let logoUrl = session.logo_url;
    if (session.logo_path && !logoUrl) {
      logoUrl = await getSignedLogoUrl(session.logo_path);
    }

    // Get site intelligence snapshots (from session snapshots)
    const siteIntelligence = await getSiteIntelligenceSnapshots(session.id);

    // Auto-prefill resume: when a scan is linked to this session but
    // hasn't completed, `siteIntelligence` is null (no snapshots written
    // yet). Surface the linked record's live state so the wizard can
    // resume polling (queued/running) — e.g. the GHL webhook kicked off
    // the scan and the client/AM opened before it finished — or show the
    // retry affordance (failed), instead of falling back to the idle
    // "Analyze my site" button. Only queried in the no-snapshot case, so
    // the completed happy path adds no extra read.
    let siteIntelligencePending:
      | { recordId: string; status: string; error: string | null }
      | null = null;
    if (!siteIntelligence && session.site_intelligence_id) {
      const linked = await getSiteIntelligence(session.site_intelligence_id);
      if (linked && linked.status !== 'completed') {
        siteIntelligencePending = {
          recordId: linked.id,
          status: linked.status,
          error: linked.error ?? null,
        };
      }
    }

    // BOTH tracking writes for this page-load, in ONE after() registration.
    // Sprint 2 / #4: suppressed entirely for AM-bypass opens — an AM
    // preparing the form must not look like client activity, and the
    // workbook's Open History must only count real client opens.
    //
    // Phase 1 of the workbook Onboarding tab (migration 008): the open-event
    // row feeds the Open History modal (Phase 6.1 of the spec). IP is hashed
    // (sha256(ip || salt)) before storage; raw IP never lands in the DB.
    //
    // Emitted only after `access.kind === 'ok'` (i.e. the caller has passed
    // PIN verification when one is configured). Locked / needs_pin responses
    // are not counted as opens.
    //
    // WHY after(), FOR BOTH. The open event already deferred for a documented
    // reason: a plain `void ... .catch(log)` fire-and-forget is torn down with
    // the function when the response ships on Vercel, so the Supabase HTTP
    // request never lands (see PR #11 post-merge verification). The
    // session_accessed audit is the same kind of write with the same
    // consequences, so it joins it here. That takes a Supabase round trip off
    // form-load latency and makes the failure STRUCTURALLY unable to reach the
    // response, rather than merely handled on the way to it.
    //
    // WHAT IS LOST, stated: a hard teardown before after() flushes drops the
    // row. That is the trade the open event on this same page-load already
    // accepts, so it costs no new class of loss.
    //
    // No try/catch here: recordAuditEvent and recordOpenEvent are total and
    // log their own failures. A catch would only be able to swallow.
    //
    // THE TWO WRITES ARE INDEPENDENT, AND THAT IS LOAD-BEARING.
    // Sharing one after() registration must not make them share a FATE. They
    // were briefly sequenced as `await audit; await open;`, which reintroduced
    // exactly the class of bug this whole change exists to remove: a first
    // write that does not settle means the second is never even ATTEMPTED, so
    // the open-history row is lost AND nothing is logged about its absence,
    // at HTTP 200. Measured on the pre-fix revision against a stalling
    // PostgREST: the only request issued was
    // POST /rest/v1/onboarding_audit_events, and the open event never went out.
    // (The write bound in server.ts stops the freeze; this stops the coupling.
    // Both are needed — a bounded first write still delays the second by the
    // whole bound, and a slow write is not a reason to skip an unrelated one.)
    //
    // So both are ISSUED before either is awaited, and settled with
    // allSettled rather than all: both primitives are total today, and this
    // does not quietly depend on their staying that way. Each still emits its
    // OWN [audit-write][WRITE-FAILURE] line, naming its own table.
    if (!isAmBypass) {
      const ip = request.headers.get('x-forwarded-for') || 'unknown';
      const rawUserAgent = request.headers.get('user-agent') || 'unknown';
      const userAgent = capUserAgent(request.headers.get('user-agent'));
      const ipHash = hashRequestIp(request.headers.get('x-forwarded-for'));
      after(async () => {
        await Promise.allSettled([
          recordAuditEvent(
            session.id,
            'session_accessed',
            { ip, userAgent: rawUserAgent },
            {
              clientId: session.client_id,
              route: 'GET /api/public/onboarding/session',
              succeeded:
                'the session payload was returned to the client; only the audit row was lost',
            },
          ),
          recordOpenEvent(
            session.id,
            { userAgent, ipHash },
            {
              clientId: session.client_id,
              route: 'GET /api/public/onboarding/session',
              succeeded:
                'the session payload was returned to the client; only the open-history row was lost',
            },
          ),
        ]);
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
    // 'other' is now a KNOWN value and passes through. It previously fell into
    // the else-branch and was silently served as 'law_firm', which would have
    // shown an unclassified client the law-firm question set while its row
    // said 'other' — working, and silently wrong. Genuinely unknown strings
    // still fall back to 'law_firm' for the forward-compat reason above.
    const vertical: 'law_firm' | 'home_services' | 'other' =
      rawVertical === 'home_services'
        ? 'home_services'
        : rawVertical === 'other'
          ? 'other'
          : 'law_firm';

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
        pinSet: access.pinSet,
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
      // Auto-prefill resume: present only when a linked scan is in-flight
      // (queued/running) or failed at load time; null otherwise (no scan,
      // or a completed scan whose data is already in siteIntelligence).
      siteIntelligencePending,
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
