import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getSessionByToken, getSessionAnswers, updateSessionStep, createAuditEvent, createServiceRoleClient } from '@/lib/supabase/server';
import { getStepsForVersion } from '@/lib/onboarding/flow-version';
import { isSOPRoutingEnabled } from '@/lib/siteIntelligence/config';
import { computeSops, extractSOPInputFromAnswers } from '@/lib/sopRouting/computeSops';
import { generateWorkOrder } from '@/lib/sopRouting/workOrders';
import { getSiteIntelligence } from '@/lib/siteIntelligence/analyze';

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

    // Check if already submitted
    if (session.status === 'submitted') {
      return NextResponse.json(
        { error: 'Session has already been submitted' },
        { status: 400 }
      );
    }

    // Get all answers to verify completion
    const answers = await getSessionAnswers(session.id);
    const answeredSteps = new Set(answers.filter(a => a.completed).map(a => a.step_key));

    // Check required steps are completed (at minimum, first step and final review)
    const flowVersion = session.flow_version || 'v1';
    const requiredSteps = flowVersion === 'v2'
      ? ['primary_contact', 'submit']
      : ['business_overview', 'final_review'];
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

    // Create audit event
    await createAuditEvent(session.id, 'session_submitted', {
      totalStepsCompleted: answeredSteps.size,
      totalSteps: steps.length,
    });

    // Generate SOP routing and work orders after response (non-blocking)
    if (isSOPRoutingEnabled()) {
      const sessionId = session.id;
      const siId = (session as unknown as Record<string, unknown>).site_intelligence_id as string | null;

      after(async () => {
        try {
          const supabase = createServiceRoleClient();

          // Build answer map
          const answerMap: Record<string, Record<string, unknown>> = {};
          for (const a of answers) {
            answerMap[a.step_key] = a.answers;
          }

          // Get detected CMS
          let detectedCms: string | null = null;
          if (siId) {
            const si = await getSiteIntelligence(siId);
            detectedCms = si?.tech_stack?.cms || null;
          }

          // Compute SOP routing
          const input = extractSOPInputFromAnswers(answerMap, detectedCms);
          const result = computeSops(input);

          // Save routing
          await supabase
            .from('onboarding_sop_routing')
            .upsert({
              session_id: sessionId,
              big5: input.big5,
              migration: input.migration,
              required_sops: result.required_sops,
              notes: Object.values(result.explanations).join(' | '),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'session_id' });

          // Generate work order
          const tasks = generateWorkOrder(result.required_sops);
          await supabase
            .from('onboarding_work_orders')
            .upsert({
              session_id: sessionId,
              tasks,
              generated_at: new Date().toISOString(),
              final_report_status: 'pending',
              assignees_defaulted: true,
            }, { onConflict: 'session_id' });

          await createAuditEvent(sessionId, 'work_order_generated', {
            total_tasks: tasks.length,
            required_sops: result.required_sops,
          });
        } catch (err) {
          console.error('Post-submit work order generation failed:', err);
        }
      });
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
