import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { checkBearerToken } from '@/lib/onboarding/bearer-auth';
import { signAmBypass } from '@/lib/onboarding/am-bypass';

/**
 * POST /api/admin/onboarding/sessions/[id]/am-link
 *
 * Returns the AM-bypass signature for a session, so the workbook's
 * "View form" button can open the form the way an account manager
 * should see it: no PIN prompt, no welcome wizard, zero tracking
 * rows (E2E finding F3, 2026-06-11 — the workbook button previously
 * opened the plain client link, which hit the PIN gate and burned a
 * tracked open in the very Open History the bypass exists to keep
 * clean).
 *
 * The signature is HMAC-SHA256(secret, "am-bypass.<sessionId>") —
 * see lib/onboarding/am-bypass.ts. Only this deploy holds the
 * secret, which is why the workbook (which reads the shared
 * Supabase directly for the token) cannot build the link itself
 * and must call across.
 *
 * Auth mirrors regenerate-pin: the /api/admin/* proxy gate
 * (cookie-or-bearer) plus this in-handler bearer check as the
 * second layer. The caller is the workbook's
 * /api/onboarding/sessions/[id]/token route, which audits each
 * access on its side (source: "view_form").
 *
 * Response: { amSignature: string }. The signature is a credential
 * (it waives the PIN for this session) — Cache-Control: no-store,
 * and it must never be sent to clients. It lives exactly as long
 * as the session token it accompanies.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = checkBearerToken(request);
  if (auth.kind === 'deny') {
    return NextResponse.json(
      { error: 'Unauthorized', reason: auth.reason },
      { status: 401 }
    );
  }

  try {
    const { id } = await params;

    // Confirm the session exists before signing — a signature for a
    // nonexistent session is harmless (verify would never match a
    // real request) but a 404 here gives the workbook a clean error
    // instead of a link that silently PIN-gates.
    const supabase = createServiceRoleClient();
    const { data: session, error } = await supabase
      .from('onboarding_sessions')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: 'Database error: ' + error.message },
        { status: 500 }
      );
    }
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { amSignature: signAmBypass(id) },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[am-link] error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
