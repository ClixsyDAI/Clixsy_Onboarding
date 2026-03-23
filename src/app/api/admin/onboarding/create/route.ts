import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { clientName, contactName, contactEmail, websiteUrl, siteIntelligenceId } = body;

    if (!clientName) {
      return NextResponse.json(
        { error: 'Client name is required' },
        { status: 400 }
      );
    }

    const supabase = createServiceRoleClient();

    // Use a fixed admin agency ID - create if doesn't exist
    const ADMIN_AGENCY_ID = '00000000-0000-0000-0000-000000000001';

    // Check if admin agency exists, create if not
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

    // Generate IDs and token
    const agencyId = ADMIN_AGENCY_ID;
    const clientId = uuidv4();
    const sessionId = uuidv4();
    const token = crypto.randomBytes(32).toString('hex');

    // Create client
    const { error: clientError } = await supabase
      .from('clients')
      .insert({
        id: clientId,
        agency_id: agencyId,
        client_name: clientName,
        primary_contact_name: contactName || null,
        primary_contact_email: contactEmail || null,
        website_url: websiteUrl || null,
      });

    if (clientError) {
      console.error('Client creation error:', clientError);
      return NextResponse.json(
        { error: 'Failed to create client: ' + clientError.message },
        { status: 500 }
      );
    }

    // Create onboarding session
    const sessionData: Record<string, unknown> = {
      id: sessionId,
      agency_id: agencyId,
      client_id: clientId,
      token,
      status: 'draft',
      current_step: 0,
      flow_version: 'v2',
    };

    // Link site intelligence if provided
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

    return NextResponse.json({
      success: true,
      token,
      sessionId,
    });
  } catch (error) {
    console.error('Error creating session:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
