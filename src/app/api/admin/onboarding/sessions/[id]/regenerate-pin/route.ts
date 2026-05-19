import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { generatePin, hashPin } from '@/lib/onboarding/pin';

/**
 * POST /api/admin/onboarding/sessions/[id]/regenerate-pin
 *
 * Rotates a session's PIN. Used when the original PIN is lost OR
 * when the session is permanently locked and the admin wants to
 * reissue access cleanly (rotating beats just clearing the lock
 * since whoever was attempting the brute-force is back to square
 * one even if they had a guess in flight).
 *
 * Side effects:
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
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = createServiceRoleClient();

    // Verify the session exists before doing crypto work.
    const { data: existing, error: existingErr } = await supabase
      .from('onboarding_sessions')
      .select('id')
      .eq('id', id)
      .single();

    if (existingErr || !existing) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    const pin = generatePin();
    const pinHash = await hashPin(pin);

    const { error: updateErr } = await supabase
      .from('onboarding_sessions')
      .update({
        pin_hash: pinHash,
        pin_attempts: 0,
        pin_lockout_until: null,
        pin_locked_at: null,
      })
      .eq('id', id);

    if (updateErr) {
      console.error('PIN regenerate update error:', updateErr);
      return NextResponse.json(
        { error: 'Failed to rotate PIN: ' + updateErr.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, pin });
  } catch (error) {
    console.error('Error regenerating PIN:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
