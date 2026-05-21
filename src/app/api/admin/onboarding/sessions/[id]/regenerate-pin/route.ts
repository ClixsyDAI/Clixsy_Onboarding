import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { rotatePin } from '@/lib/onboarding/rotate-pin';
import { checkBearerToken } from '@/lib/onboarding/bearer-auth';

/**
 * POST /api/admin/onboarding/sessions/[id]/regenerate-pin
 *
 * Rotates a session's PIN. Used when the original PIN is lost OR
 * when the session is permanently locked and the admin wants to
 * reissue access cleanly (rotating beats just clearing the lock
 * since whoever was attempting the brute-force is back to square
 * one even if they had a guess in flight).
 *
 * Phase 6 PR A:
 *   - Bearer-token gate via SHARED_INTEGRATION_BEARER_TOKEN env
 *     var (see lib/onboarding/bearer-auth.ts). Production blocks
 *     unauthenticated callers; local / preview behaves as before.
 *   - Rotation logic extracted to lib/onboarding/rotate-pin.ts so
 *     the same-process Server Action used by the admin UI shares
 *     the codepath.
 *
 * Side effects on success:
 *   - new PIN generated, hashed, stored
 *   - pin_attempts reset to 0
 *   - pin_lockout_until cleared
 *   - pin_locked_at cleared
 *
 * Response shape:
 *   { success: true, pin: '123456' }
 *
 * The plaintext PIN is returned ONCE in the response body. The
 * admin UI displays it with copy-to-clipboard. After this response
 * is consumed the PIN cannot be retrieved — only re-rotated.
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
    const supabase = createServiceRoleClient();
    const result = await rotatePin(supabase, id);

    if (result.kind === 'not_found') {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }
    if (result.kind === 'error') {
      console.error('PIN regenerate failed:', result.message);
      return NextResponse.json(
        { error: result.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, pin: result.pin });
  } catch (error) {
    console.error('Error regenerating PIN:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
