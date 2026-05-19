import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { adminUnlockUpdate } from '@/lib/onboarding/pin';

/**
 * POST /api/admin/onboarding/sessions/[id]/unlock
 *
 * Clears PIN-failure state on a session WITHOUT rotating the hash.
 * Used when the client got locked out (5+ failed attempts → temporary
 * lockout, or 10+ → permanent) but still knows their PIN and the
 * admin just wants to give them another chance.
 *
 * Side effects:
 *   - pin_attempts → 0
 *   - pin_lockout_until → null
 *   - pin_locked_at → null
 *   - pin_hash unchanged
 *
 * If you want to ALSO rotate the PIN (lost-PIN case, or suspected
 * brute-force attempt where the attacker may have a guess in flight),
 * use POST .../regenerate-pin instead.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = createServiceRoleClient();

    const { data: existing, error: existingErr } = await supabase
      .from('onboarding_sessions')
      .select('id, pin_hash')
      .eq('id', id)
      .single();

    if (existingErr || !existing) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Edge case: unlock requested on a legacy session that has no
    // PIN configured. There's nothing to clear, but it's also a
    // no-op rather than an error.
    if (existing.pin_hash === null) {
      return NextResponse.json({
        success: true,
        note: 'Session has no PIN configured; nothing to unlock.',
      });
    }

    const update = adminUnlockUpdate();
    const { error: updateErr } = await supabase
      .from('onboarding_sessions')
      .update(update)
      .eq('id', id);

    if (updateErr) {
      console.error('PIN unlock update error:', updateErr);
      return NextResponse.json(
        { error: 'Failed to unlock session: ' + updateErr.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error unlocking session:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
