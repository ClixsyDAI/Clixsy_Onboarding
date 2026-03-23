import { NextRequest, NextResponse } from 'next/server';
import { getSiteIntelligence } from '@/lib/siteIntelligence/analyze';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const recordId = searchParams.get('id');

    if (!recordId) {
      return NextResponse.json(
        { error: 'id is required' },
        { status: 400 }
      );
    }

    const record = await getSiteIntelligence(recordId);

    if (!record) {
      return NextResponse.json(
        { error: 'Record not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      id: record.id,
      status: record.status,
      website_url: record.website_url,
      domain: record.domain,
      started_at: record.started_at,
      completed_at: record.completed_at,
      providers_used: record.providers_used,
      branding: record.branding,
      insights: record.insights,
      tech_stack: record.tech_stack,
      metrics: record.metrics,
      prefill_map: record.prefill_map,
      question_overrides: record.question_overrides,
      evidence: record.evidence,
      error: record.error,
      prefill_count: record.prefill_map ? Object.keys(record.prefill_map).length : 0,
      autofill_count: record.prefill_map
        ? Object.values(record.prefill_map).filter((e: { policy: string }) => e.policy === 'autofill').length
        : 0,
      suggest_count: record.prefill_map
        ? Object.values(record.prefill_map).filter((e: { policy: string }) => e.policy === 'suggest_only').length
        : 0,
    });
  } catch (error) {
    console.error('Error fetching analysis status:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
