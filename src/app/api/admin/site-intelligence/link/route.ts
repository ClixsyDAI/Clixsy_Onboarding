import { NextRequest, NextResponse } from 'next/server';
import { linkSiteIntelligenceToSession } from '@/lib/siteIntelligence/analyze';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, siteIntelligenceId } = await request.json();

    if (!sessionId || !siteIntelligenceId) {
      return NextResponse.json(
        { error: 'sessionId and siteIntelligenceId are required' },
        { status: 400 }
      );
    }

    await linkSiteIntelligenceToSession(sessionId, siteIntelligenceId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error linking site intelligence:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
