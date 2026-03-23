import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { computeSops, extractSOPInputFromAnswers } from '@/lib/sopRouting/computeSops';
import { getSessionAnswers } from '@/lib/supabase/server';
import { getSiteIntelligence } from '@/lib/siteIntelligence/analyze';

// Compute and persist SOP routing for a session
export async function POST(request: NextRequest) {
  try {
    const { sessionId } = await request.json();
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    // Get session to check for site intelligence
    const { data: session } = await supabase
      .from('onboarding_sessions')
      .select('site_intelligence_id')
      .eq('id', sessionId)
      .single();

    // Get detected CMS from site intelligence if available
    let detectedCms: string | null = null;
    if (session?.site_intelligence_id) {
      const si = await getSiteIntelligence(session.site_intelligence_id);
      detectedCms = si?.tech_stack?.cms || null;
    }

    // Get answers
    const answers = await getSessionAnswers(sessionId);
    const answerMap: Record<string, Record<string, unknown>> = {};
    for (const a of answers) {
      answerMap[a.step_key] = a.answers;
    }

    // Compute routing
    const input = extractSOPInputFromAnswers(answerMap, detectedCms);
    const result = computeSops(input);

    // Upsert routing record
    const { error } = await supabase
      .from('onboarding_sop_routing')
      .upsert({
        session_id: sessionId,
        big5: input.big5,
        migration: input.migration,
        required_sops: result.required_sops,
        notes: Object.values(result.explanations).join(' | '),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'session_id' });

    if (error) {
      console.error('SOP routing upsert error:', error);
      return NextResponse.json({ error: 'Failed to save SOP routing' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      routing: result,
    });
  } catch (error) {
    console.error('SOP routing error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Get SOP routing for a session
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from('onboarding_sop_routing')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    return NextResponse.json({ routing: data || null });
  } catch (error) {
    console.error('SOP routing fetch error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
