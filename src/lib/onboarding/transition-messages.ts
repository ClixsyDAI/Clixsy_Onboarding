export interface TransitionMessage {
  cheerLine: string;
  nextLine: string;
}

interface MessageContext {
  contactFirstName: string;
  businessName: string;
  answers: Record<string, Record<string, unknown>>;
  nextStepTitle: string;
}

// ── V1 messages (keyed by the step just COMPLETED) ──────────────────

const V1_MESSAGES: Record<string, (ctx: MessageContext) => TransitionMessage> = {
  // Contact section
  primary_contact: () => ({
    cheerLine: 'Now we know who to call!',
    nextLine: 'Tell us more...',
  }),
  additional_contacts: (ctx) => ({
    cheerLine: `Great team behind ${ctx.businessName || 'the scenes'}!`,
    nextLine: 'One more contact to add...',
  }),
  tech_contact: () => ({
    cheerLine: 'All contacts locked in!',
    nextLine: "Tell us about the business...",
  }),

  // Business section
  business_basics: (ctx) => ({
    cheerLine: `Nice to meet ${ctx.businessName || 'you'}!`,
    nextLine: 'Where are you located?',
  }),
  business_location: () => ({
    cheerLine: 'Great location!',
    nextLine: 'A few more details...',
  }),
  business_details: (ctx) => ({
    cheerLine: `${ctx.businessName || 'Your firm'} sounds impressive!`,
    nextLine: "Let's talk about your vision...",
  }),

  // Goals section
  vision_goals: (ctx) => ({
    cheerLine: `Love the ambition, ${ctx.contactFirstName}!`,
    nextLine: 'How will we measure success?',
  }),
  success_metrics: () => ({
    cheerLine: 'Now we know what to aim for!',
    nextLine: 'Time for branding...',
  }),

  // Brand section
  brand_assets: () => ({
    cheerLine: 'Great brand foundation!',
    nextLine: "Let's talk colors...",
  }),
  brand_colors: () => ({
    cheerLine: 'Nice brand colors!',
    nextLine: 'Next up, your website!',
  }),

  // Website section
  domain_website: (ctx) => ({
    cheerLine: `Got it, ${ctx.contactFirstName}!`,
    nextLine: 'What platform powers your site?',
  }),
  website_platform: () => ({
    cheerLine: 'Platform locked in!',
    nextLine: "Let's talk about tracking leads...",
  }),

  // SEO & tracking section
  lead_tracking: (ctx) => ({
    cheerLine: 'Tracking is everything!',
    nextLine: `Where should ${ctx.businessName || 'you'} rank?`,
  }),
  seo_areas: () => ({
    cheerLine: 'Great target areas!',
    nextLine: 'What cases should we focus on?',
  }),
  seo_cases: () => ({
    cheerLine: 'Keywords looking strong!',
    nextLine: "Let's check your Google profile...",
  }),
  google_business: () => ({
    cheerLine: 'GBP looking good!',
    nextLine: 'A few compliance items...',
  }),

  // Legal, content & comms
  legal_compliance: () => ({
    cheerLine: 'Compliance covered!',
    nextLine: 'What about content?',
  }),
  content_preferences: () => ({
    cheerLine: 'Noted on content!',
    nextLine: 'How should we stay in touch?',
  }),
  communication: () => ({
    cheerLine: 'Communication sorted!',
    nextLine: 'Time for access setup...',
  }),

  // Access section
  google_analytics_access: () => ({
    cheerLine: 'Analytics access — check!',
    nextLine: 'Next: Search Console...',
  }),
  google_search_console_access: () => ({
    cheerLine: 'Search Console — done!',
    nextLine: 'Now Google Business Profile...',
  }),
  google_business_profile_access: () => ({
    cheerLine: 'GBP access sorted!',
    nextLine: 'WordPress next...',
  }),
  wordpress_access: () => ({
    cheerLine: 'WordPress — good to go!',
    nextLine: 'Domain registrar time...',
  }),
  domain_registrar_access: () => ({
    cheerLine: 'Domain access noted!',
    nextLine: 'DNS setup next...',
  }),
  cloudflare_access: () => ({
    cheerLine: 'DNS all set!',
    nextLine: 'Any other accounts?',
  }),
  other_access: (ctx) => ({
    cheerLine: 'All access covered!',
    nextLine: `Almost there, ${ctx.contactFirstName}...`,
  }),

  // Wrap-up section
  previous_agency: () => ({
    cheerLine: 'Good to know!',
    nextLine: 'A little something for you...',
  }),
  welcome_gift: (ctx) => ({
    cheerLine: `You deserve it, ${ctx.contactFirstName}!`,
    nextLine: "Let's review everything...",
  }),
  almost_there: () => ({
    cheerLine: 'Looking great!',
    nextLine: 'Ready to submit?',
  }),
};

// ── V2 messages (keyed by the step just COMPLETED) ──────────────────

const V2_MESSAGES: Record<string, (ctx: MessageContext) => TransitionMessage> = {
  primary_contact: () => ({
    cheerLine: 'Now we know who to call!',
    nextLine: 'Tell us more...',
  }),
  other_contacts: (ctx) => ({
    cheerLine: 'Great team!',
    nextLine: `Tell us about ${ctx.businessName || 'the business'}...`,
  }),
  business_overview: (ctx) => ({
    cheerLine: `Nice to meet ${ctx.businessName || 'you'}!`,
    nextLine: "Now let's set some goals...",
  }),
  goals_strategy: () => ({
    cheerLine: 'Love the ambition!',
    nextLine: "Let's build a brand to match...",
  }),
  brand_design: () => ({
    cheerLine: 'Nice brand colors!',
    nextLine: 'Time for the technical stuff...',
  }),
  technical_setup: () => ({
    cheerLine: 'Tech setup — solid!',
    nextLine: 'Next up, SEO!',
  }),
  seo_targeting: () => ({
    cheerLine: 'SEO strategy looking great!',
    nextLine: 'A few more details...',
  }),
  legal_content_comms: () => ({
    cheerLine: 'Great communication style!',
    nextLine: 'Almost done — just need access...',
  }),
  access_checklist: () => ({
    cheerLine: 'Access all sorted!',
    nextLine: 'Wrapping things up...',
  }),
  transition_wrapup: (ctx) => ({
    cheerLine: `That's a wrap, ${ctx.contactFirstName}!`,
    nextLine: "Let's review everything...",
  }),
  review: () => ({
    cheerLine: 'Looking good!',
    nextLine: 'Ready to submit?',
  }),
};

// ── Public API ──────────────────────────────────────────────────────

export function getTransitionMessage(
  fromStepKey: string,
  nextStepTitle: string,
  contactFirstName: string,
  businessName: string,
  answers: Record<string, Record<string, unknown>>,
  flowVersion: 'v1' | 'v2',
): TransitionMessage {
  const ctx: MessageContext = {
    contactFirstName: contactFirstName || 'there',
    businessName,
    answers,
    nextStepTitle,
  };

  const messageMap = flowVersion === 'v2' ? V2_MESSAGES : V1_MESSAGES;
  const generator = messageMap[fromStepKey];

  if (generator) {
    return generator(ctx);
  }

  // Fallback for any unmapped step
  return {
    cheerLine: `Nice work${contactFirstName ? `, ${contactFirstName}` : ''}!`,
    nextLine: `Next up: ${nextStepTitle}`,
  };
}

/**
 * P4 (Stage 7): returning-user copy uses the CLIENT COMPANY NAME, not
 * the personal contact name. Caller passes whichever name is appropriate
 * in `displayName`; the Stage 7 Wizard supplies `clientName`
 * (e.g. "Jungle Law").
 *
 * Per P4 spec this is only called when the welcome wizard has already
 * been seen (welcome_wizard_seen = true server-side); on first login
 * the P3 modal replaces the greeting entirely.
 */
export function getWelcomeMessage(
  displayName: string,
  isReturning: boolean,
): TransitionMessage {
  const name = displayName || 'there';

  if (isReturning) {
    return {
      cheerLine: `Welcome back, ${name}!`,
      nextLine: "Let's pick up where we left off.",
    };
  }

  return {
    cheerLine: `Hey ${name}!`,
    nextLine: "Welcome to Clixsy! Let's get you set up.",
  };
}
