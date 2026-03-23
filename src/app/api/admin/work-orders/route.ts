import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { generateWorkOrder } from '@/lib/sopRouting/workOrders';

// Generate work order for a submitted session
export async function POST(request: NextRequest) {
  try {
    const { sessionId } = await request.json();
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    // Get SOP routing to know which SOPs are required
    const { data: routing } = await supabase
      .from('onboarding_sop_routing')
      .select('required_sops')
      .eq('session_id', sessionId)
      .single();

    const requiredSops = routing?.required_sops || [];
    const tasks = generateWorkOrder(requiredSops);

    // Upsert work order
    const { error } = await supabase
      .from('onboarding_work_orders')
      .upsert({
        session_id: sessionId,
        tasks,
        generated_at: new Date().toISOString(),
        final_report_status: 'pending',
        assignees_defaulted: true,
      }, { onConflict: 'session_id' });

    if (error) {
      console.error('Work order upsert error:', error);
      return NextResponse.json({ error: 'Failed to save work order' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      tasks,
      total_tasks: tasks.length,
    });
  } catch (error) {
    console.error('Work order error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Get work order for a session
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from('onboarding_work_orders')
      .select('*')
      .eq('session_id', sessionId)
      .single();

    return NextResponse.json({ workOrder: data || null });
  } catch (error) {
    console.error('Work order fetch error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
