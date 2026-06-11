import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient, upsertAnswer } from '@/lib/supabase/server';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { generatePin, hashPin } from '@/lib/onboarding/pin';
import { isLikelyUrl } from '@/lib/onboarding/url-shape';

type Vertical = 'law_firm' | 'home_services';

// Empty-after-trim becomes undefined so downstream `?? null` coalesces
// the optional contact columns the same way the original
// `contactName?.trim() || null` path did.
const optionalTrimmedString = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const RequestBodySchema = z.object({
  clientName: z.string().trim().min(1, 'Client name is required'),
  accountManager: z.string().trim().min(1, 'Account manager is required'),
  vertical: z.enum(['law_firm', 'home_services'], {
    message: 'Vertical must be one of: law_firm, home_services',
  }),
  contactName: optionalTrimmedString,
  contactEmail: optionalTrimmedString,
  // Contact-seeding follow-up: phone has no clients column — it exists
  // only to seed the step-1 answer below. The GHL webhook forwards it.
  contactPhone: optionalTrimmedString,
  websiteUrl: optionalTrimmedString,
  siteIntelligenceId: z.string().optional(),
  // workbook_id is set by the workbook-side automation. Format
  // changed during the GHL pivot:
  //   - Pre-pivot Basecamp poller sent numeric project ids (e.g.
  //     "25949341"). Those still need to round-trip — the 63
  //     migrated workbook entries hold these stringified-numeric
  //     ids verbatim.
  //   - Post-pivot GHL webhook sends 20-char alphanumeric
  //     opportunity ids (e.g. "abcDEF0123456789xyzZ").
  // The regex accepts both shapes (and a slightly wider 1-32 char
  // band to leave headroom for future id formats). The DB column
  // was migrated from bigint → text in migration 009 to match.
  // UNIQUE constraint `clients_workbook_id_unique` (migration 008)
  // survives the type change and is still surfaced as a 409 below.
  workbookId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/, "must be 1-32 alphanumeric, '_', or '-' characters")
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const parsed = RequestBodySchema.safeParse(body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return NextResponse.json(
        { error: firstIssue?.message ?? 'Invalid request body' },
        { status: 400 }
      );
    }
    const {
      clientName,
      contactName,
      contactEmail,
      contactPhone,
      websiteUrl,
      siteIntelligenceId,
      accountManager,
      vertical,
      workbookId,
    } = parsed.data;
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
    // workbook_id is only included in the INSERT payload when the
    // caller supplied it — leaving the column NULL (its default)
    // preserves the admin UI path's existing behaviour.
    const clientInsert: Record<string, unknown> = {
      id: clientId,
      agency_id: agencyId,
      client_name: clientName,
      primary_contact_name: contactName ?? null,
      primary_contact_email: contactEmail ?? null,
      website_url: websiteUrl ?? null,
    };
    if (workbookId !== undefined) {
      clientInsert.workbook_id = workbookId;
    }

    const { error: clientError } = await supabase
      .from('clients')
      .insert(clientInsert);

    if (clientError) {
      // Translate the workbook_id UNIQUE-violation into a structured
      // 409 so the automation caller can distinguish "this Basecamp
      // project already has an onboarding session" from a generic DB
      // failure. Other 23505 violations fall through to the 500 path.
      if (
        clientError.code === '23505' &&
        typeof clientError.message === 'string' &&
        clientError.message.includes('clients_workbook_id_unique')
      ) {
        return NextResponse.json(
          {
            success: false,
            error: 'workbook_id_already_linked',
            message: `Another client is already linked to workbook_id ${workbookId}. Use a different workbook_id or unlink the existing client.`,
          },
          { status: 409 }
        );
      }
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
      account_manager: accountManager,
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

    // --- Auto-prefill seed (website field) ------------------------
    // The v2 wizard renders the website field from
    // onboarding_answers.primary_contact.website_url — NOT from
    // clients.website_url (that column, written above, feeds other
    // dashboards). So to make the field show pre-filled when a session
    // is created from the GHL webhook (which now forwards website_url
    // plus the contact's name/email/phone), seed the answers here.
    // Guards per field: website is gated on a URL-shape check; email is
    // seeded only when it would pass the form's own zod validation
    // (z.string().email()) — a seeded invalid email would otherwise
    // surface as a validation error the client has to clear on their
    // first save of step 1. Name/phone are free-text in the form
    // (min-1 validation), so presence is the only guard.
    // completed:false — primary_contact still has unanswered required
    // fields (main_contact_title at minimum), so seeding never
    // completes the step. Non-fatal: a failed seed just means the
    // fields are typed manually; the session is already created.
    const seedAnswers: Record<string, unknown> = {};
    if (websiteUrl && isLikelyUrl(websiteUrl)) {
      seedAnswers.website_url = websiteUrl;
    }
    if (contactName) {
      seedAnswers.main_contact_name = contactName;
    }
    if (contactEmail && z.string().email().safeParse(contactEmail).success) {
      seedAnswers.main_contact_email = contactEmail;
    }
    if (contactPhone) {
      seedAnswers.main_contact_phone = contactPhone;
    }
    if (Object.keys(seedAnswers).length > 0) {
      const seeded = await upsertAnswer(
        sessionId,
        'primary_contact',
        seedAnswers,
        false
      );
      if (!seeded) {
        console.warn(
          `[create] answer seed failed (non-fatal) for session ${sessionId}: ${Object.keys(seedAnswers).join(', ')}`
        );
      }
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
