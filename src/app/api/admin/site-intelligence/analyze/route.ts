import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { isSiteIntelligenceEnabled } from '@/lib/siteIntelligence/config';
import { createSiteIntelligenceRecord, runSiteAnalysis, linkSiteIntelligenceToSession } from '@/lib/siteIntelligence/analyze';

// Allow up to 300 seconds (Vercel's platform max) for Firecrawl crawl
// + LLM extraction + PageSpeed. Historical median for client sites is
// ~40s with a max around 52s, so 60s mostly worked — but deep sites
// like clixsy.com itself hit >180s, and when the function times out
// mid-run the `runSiteAnalysis` code never reaches its terminal
// UPDATE status='completed' or 'failed' statements, leaving the
// record stuck in 'running' permanently. 300s is Vercel's plan max
// and gives headroom for any realistic client site. If a future
// site exceeds this too, the next step is moving the analyzer onto
// a queue-based worker rather than further increasing the limit.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    if (!isSiteIntelligenceEnabled()) {
      return NextResponse.json(
        { error: 'Site intelligence is disabled' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { websiteUrl, sessionId } = body;

    if (!websiteUrl) {
      return NextResponse.json(
        { error: 'websiteUrl is required' },
        { status: 400 }
      );
    }

    // Create the record
    const recordId = await createSiteIntelligenceRecord(websiteUrl);

    // Use Next.js after() to run analysis after the response is sent
    // This keeps the serverless function alive on Vercel
    after(async () => {
      try {
        await runSiteAnalysis(recordId);
        // If sessionId provided, auto-link when done
        if (sessionId) {
          try {
            await linkSiteIntelligenceToSession(sessionId, recordId);
          } catch (err) {
            console.error('Failed to auto-link site intelligence to session:', err);
          }
        }
      } catch (err) {
        console.error('Analysis failed:', err);
      }
    });

    return NextResponse.json({
      success: true,
      recordId,
      status: 'queued',
    });
  } catch (error) {
    console.error('Error starting analysis:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
