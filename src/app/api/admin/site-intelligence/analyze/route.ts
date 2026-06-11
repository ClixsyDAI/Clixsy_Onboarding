import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { isSiteIntelligenceEnabled } from '@/lib/siteIntelligence/config';
import {
  createSiteIntelligenceRecord,
  runSiteAnalysis,
  linkSiteIntelligenceToSession,
  getSiteIntelligence,
  findReusableScan,
  attachPendingScanToSession,
  getSessionScanLink,
} from '@/lib/siteIntelligence/analyze';
import { isLikelyUrl } from '@/lib/onboarding/url-shape';

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

    if (!websiteUrl || typeof websiteUrl !== 'string') {
      return NextResponse.json(
        { error: 'websiteUrl is required' },
        { status: 400 }
      );
    }
    // URL-shape guard: the GHL webhook calls this for the auto-scan, so
    // reject junk ("N/A"/"tbd"/bare words) before spending a scan. A
    // valid website always has a dotted host.
    if (!isLikelyUrl(websiteUrl)) {
      return NextResponse.json(
        { error: 'websiteUrl is not a valid URL' },
        { status: 400 }
      );
    }

    // Dedup (mirrors the public route): when a sessionId is supplied and
    // it already has a reusable scan for the same URL — completed or
    // still in-flight — return that record instead of starting a second
    // one. Stops the webhook auto-scan and any later trigger from
    // double-charging the same session.
    const priorLinkedId = sessionId ? await getSessionScanLink(sessionId) : null;
    if (sessionId) {
      const reuse = await findReusableScan(priorLinkedId, websiteUrl);
      if (reuse) {
        return NextResponse.json({
          success: true,
          recordId: reuse.recordId,
          status: reuse.status,
          reused: true,
        });
      }
    }

    // Create the record
    const recordId = await createSiteIntelligenceRecord(websiteUrl);

    // Make the in-flight scan discoverable to the session so a reload or
    // a public "Analyze my site" click resumes/dedups it rather than
    // starting a duplicate. FK only (no snapshots until completion);
    // skips when a still-good completed record is already linked.
    if (sessionId) {
      await attachPendingScanToSession(sessionId, recordId, priorLinkedId);
    }

    // Use Next.js after() to run analysis after the response is sent
    // This keeps the serverless function alive on Vercel
    after(async () => {
      try {
        await runSiteAnalysis(recordId);
        // If sessionId provided, auto-link when done. Gate on a
        // completed status so a failed scan never overwrites the
        // session's link with snapshot-less garbage (matches the public
        // route's link-only-on-completed guard).
        if (sessionId) {
          try {
            const record = await getSiteIntelligence(recordId);
            if (record && record.status === 'completed') {
              await linkSiteIntelligenceToSession(sessionId, recordId);
            }
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
