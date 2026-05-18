import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { generatePin, hashPin } from '@/lib/onboarding/pin';

type Vertical = 'law_firm' | 'home_services';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      clientName,
      contactName,
      contactEmail,
      websiteUrl,
      siteIntelligenceId,
      accountManager,
      vertical,
    }: {
      clientName?: string;
      contactName?: string;
      contactEmail?: string;
      websiteUrl?: string;
      siteIntelligenceId?: string;
      accountManager?: string;
      vertical?: string;
    } = body;

    // --- Validation -------------------------------------------------
    if (!clientName || !clientName.trim()) {
      return NextResponse.json(
        { error: 'Client name is required' },
        { status: 400 }
      );
    }
    if (!accountManager || !accountManager.trim()) {
      return NextResponse.json(
        { error: 'Account manager is required' },
        { status: 400 }
      );
    }
    if (vertical !== 'law_firm' && vertical !== 'home_services') {
      return NextResponse.json(
        { error: 'Vertical must be one of: law_firm, home_services' },
        { status: 400 }
      );
    }
    const verticalValue: Vertical = vertical;

    const supabase = createServiceRoleClient();

    // --- Ensure admin agency exists --------------------------------
    const ADMIN_AGENCY_ID = '00000000-0000-0000-0000-000000000001';

    const { data: existingAgency } = await supabase
      .from('agency_accounts')
      .select('id')
      .eq('id', ADMIN_AGENCY_ID)
      .single();

    if (!existingAgency) {
      const { error: agencyError } = await supabase
        .from('agency_accounts')
        .insert({
          id: ADMIN_AGENCY_ID,
          agency_name: 'Admin Agency',
        });

      if (agencyError) {
        console.error('Agency creation error:', agencyError);
        return NextResponse.json(
          { error: 'Failed to create agency: ' + agencyError.message },
          { status: 500 }
        );
      }
    }

    // --- Generate IDs, session token, and 6-digit PIN --------------
    const agencyId = ADMIN_AGENCY_ID;
    const clientId = uuidv4();
    const sessionId = uuidv4();
    const token = crypto.randomBytes(32).toString('hex');

    // PIN is shown to the admin in plaintext exactly ONCE in the
    // success response. The hash is stored on the session row.
    // Regenerating later (admin session-detail) replaces both.
    const pin = generatePin();
    const pinHash = await hashPin(pin);

    // --- Create client --------------------------------------------
    const { error: clientError } = await supabase
      .from('clients')
      .insert({
        id: clientId,
        agency_id: agencyId,
        client_name: clientName.trim(),
        primary_contact_name: contactName?.trim() || null,
        primary_contact_email: contactEmail?.trim() || null,
        website_url: websiteUrl?.trim() || null,
      });

    if (clientError) {
      console.error('Client creation error:', clientError);
      return NextResponse.json(
        { error: 'Failed to create client: ' + clientError.message },
        { status: 500 }
      );
    }

    // --- Create onboarding session --------------------------------
    const sessionData: Record<string, unknown> = {
      id: sessionId,
      agency_id: agencyId,
      client_id: clientId,
      token,
      status: 'draft',
      current_step: 0,
      flow_version: 'v2',
      account_manager: accountManager.trim(),
      vertical: verticalValue,
      pin_hash: pinHash,
      // pin_attempts defaults to 0 in DB; pin_lockout_until / pin_locked_at default null.
    };

    if (siteIntelligenceId) {
      sessionData.site_intelligence_id = siteIntelligenceId;
    }

    const { error: sessionError } = await supabase
      .from('onboarding_sessions')
      .insert(sessionData);

    if (sessionError) {
      console.error('Session creation error:', sessionError);
      return NextResponse.json(
        { error: 'Failed to create session: ' + sessionError.message },
        { status: 500 }
      );
    }

    // Plaintext PIN is returned in the response — this is the ONLY
    // time it leaves the server. The UI displays it once with a
    // copy-to-clipboard button; the admin must capture it now.
    return NextResponse.json({
      success: true,
      token,
      sessionId,
      pin,
    });
  } catch (error) {
    console.error('Error creating session:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
