import { z } from 'zod';
import type { OnboardingStep, VerticalId } from './steps';
import { STEP_ICONS } from './steps';
import { ALL_TRADE_IDS, HOME_SERVICES_TAXONOMY } from './service-taxonomy';

// Build the trade option list from the taxonomy at module load. The
// service options aren't a flat list — they're grouped under their
// trade in the renderer (see StepRenderer's resolveDynamicOptions
// special-case for service_categories). So we only need the trades
// here; services are fetched per-trade at render time.
const HOME_SERVICES_TRADE_OPTIONS = ALL_TRADE_IDS.map((id) => ({
  value: id,
  label: HOME_SERVICES_TAXONOMY[id].label,
}));

// =============================================
// V2 ONBOARDING STEP DEFINITIONS (12 steps, 66 questions)
// Consolidation of v1's 30 steps per Option B spec
// =============================================

export const onboardingStepsV2: OnboardingStep[] = [
  // -----------------------------------------------
  // STEP 1: PRIMARY CONTACT (from v1 step 1)
  // -----------------------------------------------
  {
    key: 'primary_contact',
    title: 'Primary Contact',
    shortTitle: 'PRIMARY',
    description: 'Who is the main decision maker for this project?',
    estimatedTime: '1 min',
    icon: STEP_ICONS.user,
    fields: [
      // Phase 3 followup: website_url moved to the front of step 1 so
      // the wizard can trigger site-intelligence analysis as early as
      // possible (the analyzer runs in the background while the client
      // fills in the rest of step 1). Defensive read of the old
      // business_overview.website_url location is in Wizard.tsx so any
      // session created before this change still surfaces its URL here.
      {
        name: 'website_url',
        label: 'Your Website',
        type: 'url',
        required: true,
        placeholder: 'https://example.com',
        helpText: "Once you enter your website, we'll analyze it and pre-fill many of the questions below so you don't have to type everything from scratch.",
      },
      {
        name: 'main_contact_name',
        label: 'Full Name',
        type: 'text',
        required: true,
        placeholder: 'John Smith',
        helpText: 'This should be the person with ultimate authority over the project.',
      },
      {
        name: 'main_contact_title',
        label: 'Title/Role',
        type: 'select',
        required: true,
        options: [
          { value: 'owner', label: 'Owner / Managing Partner' },
          { value: 'partner', label: 'Partner' },
          { value: 'marketing_director', label: 'Marketing Director' },
          { value: 'office_manager', label: 'Office Manager' },
          { value: 'other', label: 'Other' },
        ],
      },
      { name: 'main_contact_email', label: 'Email Address', type: 'email', required: true, placeholder: 'john@example.com' },
      { name: 'main_contact_phone', label: 'Best Contact Number', type: 'tel', required: true, placeholder: '(555) 123-4567' },
    ],
  },

  // -----------------------------------------------
  // STEP 2: OTHER CONTACTS (from v1 steps 2+3)
  // -----------------------------------------------
  {
    key: 'other_contacts',
    title: 'Other Contacts',
    shortTitle: 'CONTACTS',
    description: 'Who else should we contact for day-to-day or technical matters?',
    estimatedTime: '2 min',
    icon: STEP_ICONS.users,
    fields: [
      {
        name: 'has_secondary_contact',
        label: 'Do you have a secondary contact for day-to-day matters?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No, primary contact handles everything' },
        ],
      },
      {
        name: 'secondary_contact_name',
        label: 'Secondary Contact - Full Name',
        type: 'text',
        dependsOn: { field: 'has_secondary_contact', value: 'yes' },
      },
      {
        name: 'secondary_contact_email',
        label: 'Secondary Contact - Email',
        type: 'text',
        dependsOn: { field: 'has_secondary_contact', value: 'yes' },
      },
      {
        name: 'secondary_contact_phone',
        label: 'Secondary Contact - Phone',
        type: 'text',
        dependsOn: { field: 'has_secondary_contact', value: 'yes' },
      },
      {
        name: 'has_tech_contact',
        label: 'Do you have a dedicated technical/IT contact?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes, dedicated IT' },
          { value: 'external', label: 'Yes, external IT company' },
          { value: 'no', label: 'No, primary contact handles IT' },
        ],
      },
      {
        name: 'tech_contact_name',
        label: 'Technical Contact - Full Name',
        type: 'text',
        // S2.1: keep these fields visible for BOTH "Yes, dedicated IT" and
        // "Yes, external IT company" — the old single-value dependsOn was
        // unmounting them when the user toggled to external.
        dependsOn: { field: 'has_tech_contact', valueIn: ['yes', 'external'] },
      },
      {
        name: 'tech_contact_email',
        label: 'Technical Contact - Email',
        type: 'email',
        dependsOn: { field: 'has_tech_contact', valueIn: ['yes', 'external'] },
      },
      // S2.2: welcome-gift block relocated here from step 10 (Transition &
      // Wrap-up). The radio + conditional recipient/address fields are
      // unchanged in shape; only the placement and section heading are new.
      {
        name: 'wants_welcome_gift',
        label: 'Would you like to receive a welcome gift?',
        type: 'radio',
        sectionHeader: {
          title: 'Your welcome gift',
          subtitle: 'Let us show our appreciation',
        },
        options: [
          { value: 'yes', label: 'Yes please!' },
          { value: 'no', label: 'No thank you' },
        ],
      },
      {
        name: 'gift_recipient_name',
        label: 'Recipient Name',
        type: 'text',
        dependsOn: { field: 'wants_welcome_gift', value: 'yes' },
      },
      {
        name: 'gift_shipping_address',
        label: 'Shipping Address',
        type: 'textarea',
        placeholder: '123 Main St, Suite 100\nCity, State ZIP',
        dependsOn: { field: 'wants_welcome_gift', value: 'yes' },
      },
    ],
  },

  // -----------------------------------------------
  // STEP 3: BUSINESS OVERVIEW (from v1 steps 4+5+6)
  // Removed: location_type, how_long_at_location, firm_size
  // Deferred: year_founded
  // -----------------------------------------------
  {
    key: 'business_overview',
    title: 'Business Overview',
    shortTitle: 'BUSINESS',
    description: 'Tell us about your business.',
    estimatedTime: '2 min',
    icon: STEP_ICONS.building,
    fields: [
      { name: 'business_name', label: 'Business Name', type: 'text', required: true, placeholder: 'Smith & Associates Law Firm' },
      // Phase 3 followup: website_url moved to primary_contact (step 1).
      // Removed from this step's render-set. Zod still accepts it as
      // optional in stepValidationSchemasV2.business_overview for
      // back-compat with existing answer rows.
      { name: 'business_phone', label: 'Main Business Phone', type: 'tel', required: true, placeholder: '(555) 123-4567' },
      { name: 'physical_address', label: 'Physical Company Address', type: 'textarea', required: true, placeholder: '123 Main St, Suite 100\nCity, State ZIP' },
      {
        name: 'languages',
        label: 'Languages spoken at your firm',
        type: 'multiselect',
        options: [
          { value: 'english', label: 'English' },
          { value: 'spanish', label: 'Spanish' },
          { value: 'chinese', label: 'Chinese' },
          { value: 'vietnamese', label: 'Vietnamese' },
          { value: 'korean', label: 'Korean' },
          { value: 'tagalog', label: 'Tagalog' },
          { value: 'other', label: 'Other' },
        ],
      },
      { name: 'owner_names', label: 'Owner/Main Partner(s) Names', type: 'textarea', placeholder: 'List owner or partner names' },
    ],
  },

  // -----------------------------------------------
  // STEP 4: GOALS & STRATEGY (from v1 steps 7+8)
  // Deferred: current_lead_volume, target_lead_volume
  // -----------------------------------------------
  {
    key: 'goals_strategy',
    title: 'Goals & Strategy',
    shortTitle: 'GOALS',
    description: 'Help us understand what success looks like.',
    estimatedTime: '2 min',
    icon: STEP_ICONS.target,
    fields: [
      {
        name: 'primary_goal',
        label: 'What is your #1 goal for working with us?',
        type: 'radio',
        options: [
          { value: 'more_leads', label: 'Get more leads' },
          { value: 'better_leads', label: 'Better quality leads' },
          { value: 'brand_awareness', label: 'Brand awareness' },
          { value: 'stay_competitive', label: 'Stay competitive' },
          { value: 'all', label: 'All of the above' },
        ],
      },
      {
        name: 'success_definition',
        label: 'What would make this a success in 12 months?',
        type: 'textarea',
        required: true,
        placeholder: 'Be specific — e.g., "20 new signed clients per month" or "rank top 3 for personal injury in Dallas"',
      },
      {
        name: 'current_challenges',
        label: 'What is your biggest marketing challenge right now?',
        type: 'textarea',
        placeholder: 'What have you tried that isn\'t working?',
      },
      {
        name: 'important_metrics',
        label: 'Which metrics matter most to you?',
        type: 'multiselect',
        options: [
          { value: 'website_traffic', label: 'Website traffic' },
          { value: 'phone_calls', label: 'Phone calls' },
          { value: 'form_submissions', label: 'Form submissions' },
          { value: 'signed_clients', label: 'Signed clients' },
          { value: 'rankings', label: 'Rankings' },
          { value: 'reviews', label: 'Reviews' },
          { value: 'revenue', label: 'Revenue' },
        ],
      },
    ],
  },

  // -----------------------------------------------
  // STEP 5: BRAND & DESIGN (from v1 steps 9+10)
  // Removed: has_logo_files
  // -----------------------------------------------
  {
    key: 'brand_design',
    title: 'Brand & Design',
    shortTitle: 'BRAND',
    description: 'Help us maintain your visual identity.',
    estimatedTime: '2 min',
    icon: STEP_ICONS.palette,
    fields: [
      {
        name: 'has_brand_guide',
        label: 'Do you have a brand style guide?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'some', label: 'Some guidelines' },
          { value: 'no', label: 'No' },
        ],
      },
      {
        name: 'knows_brand_colors',
        label: 'Do you know your brand color hex codes?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes, I know them' },
          { value: 'no', label: 'No, pull from website' },
        ],
      },
      // S5.1: primary_color / secondary_color now surface on BOTH the
      // "Yes, I know them" path (plain hex inputs) AND the "No, pull from
      // website" path (swatch preview with Confirm/Edit, gated by the radio).
      {
        name: 'primary_color',
        label: 'Primary Brand Color (Hex)',
        type: 'text',
        placeholder: '#1A2B3C',
        dependsOn: { field: 'knows_brand_colors', valueIn: ['yes', 'no'] },
        previewMode: 'color-swatch',
        gatePreviewOn: { field: 'knows_brand_colors', value: 'no' },
      },
      {
        name: 'secondary_color',
        label: 'Secondary Brand Color (Hex)',
        type: 'text',
        placeholder: '#4D5E6F',
        dependsOn: { field: 'knows_brand_colors', valueIn: ['yes', 'no'] },
        previewMode: 'color-swatch',
        gatePreviewOn: { field: 'knows_brand_colors', value: 'no' },
      },
      // S5.2: same swatch pattern but for fonts. Always shown; preview
      // mode kicks in only when the scraper actually delivered a value.
      {
        name: 'typography_fonts',
        label: 'What fonts does your brand use?',
        type: 'text',
        placeholder: 'e.g., Montserrat, Open Sans',
        previewMode: 'font-sample',
      },
    ],
  },

  // -----------------------------------------------
  // STEP 6: TECHNICAL SETUP (from v1 steps 11+12+13)
  // -----------------------------------------------
  {
    key: 'technical_setup',
    title: 'Technical Setup',
    shortTitle: 'TECH',
    description: 'Tell us about your website and tracking setup.',
    estimatedTime: '3 min',
    icon: STEP_ICONS.computerDesktop,
    fields: [
      {
        name: 'owns_domain',
        label: 'Do you own your domain?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' },
        ],
      },
      {
        name: 'domain_registrar',
        label: 'Where is your domain registered?',
        type: 'select',
        options: [
          { value: 'godaddy', label: 'GoDaddy' },
          { value: 'namecheap', label: 'Namecheap' },
          { value: 'google', label: 'Google Domains' },
          { value: 'cloudflare', label: 'Cloudflare' },
          { value: 'network_solutions', label: 'Network Solutions' },
          { value: 'other', label: 'Other' },
        ],
      },
      {
        name: 'controls_dns',
        label: 'Do you have access to DNS settings?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' },
        ],
      },
      {
        name: 'website_platform',
        label: 'What platform is your website built on?',
        type: 'radio',
        options: [
          { value: 'wordpress', label: 'WordPress' },
          { value: 'squarespace', label: 'Squarespace' },
          { value: 'wix', label: 'Wix' },
          { value: 'webflow', label: 'Webflow' },
          { value: 'custom', label: 'Custom' },
          { value: 'not_sure', label: 'Not sure' },
        ],
      },
      {
        name: 'website_managed_by',
        label: 'Who currently manages your website?',
        type: 'radio',
        options: [
          { value: 'internal', label: 'Internal team' },
          { value: 'another_agency', label: 'Another agency' },
          { value: 'freelancer', label: 'Freelancer' },
          { value: 'no_one', label: 'No one' },
        ],
      },
      // S6.3: capture contact info when an external party owns the site.
      // Visible only for "Another agency" or "Freelancer".
      {
        name: 'website_owner_name',
        label: 'Agency / Freelancer name',
        type: 'text',
        dependsOn: { field: 'website_managed_by', valueIn: ['another_agency', 'freelancer'] },
      },
      {
        name: 'website_owner_contact_name',
        label: 'Contact name',
        type: 'text',
        dependsOn: { field: 'website_managed_by', valueIn: ['another_agency', 'freelancer'] },
      },
      {
        name: 'website_owner_contact_email',
        label: 'Contact email address',
        type: 'email',
        dependsOn: { field: 'website_managed_by', valueIn: ['another_agency', 'freelancer'] },
      },
      {
        name: 'uses_call_tracking',
        label: 'Do you use call tracking?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' },
        ],
      },
      {
        name: 'call_tracking_provider',
        label: 'Which call tracking provider?',
        type: 'select',
        dependsOn: { field: 'uses_call_tracking', value: 'yes' },
        options: [
          { value: 'callrail', label: 'CallRail' },
          { value: 'ctm', label: 'CTM' },
          { value: 'marchex', label: 'Marchex' },
          { value: 'other', label: 'Other' },
        ],
      },
      // S6.1: where should form submissions go? — was a free-text textarea,
      // now a multi-select with conditional sub-fields per destination type.
      // Multi-select because some firms route to BOTH email and a CRM.
      {
        name: 'form_submission_methods',
        label: 'Where should form submissions go?',
        type: 'multiselect',
        helpText: 'Select all that apply — many firms route to both an inbox and a CRM.',
        options: [
          { value: 'email', label: 'Email' },
          { value: 'crm', label: 'CRM' },
          { value: 'other', label: 'Other' },
        ],
      },
      {
        name: 'form_submission_email',
        label: 'Specify address',
        type: 'email',
        placeholder: 'john@firm.com',
        dependsOn: { field: 'form_submission_methods', includes: 'email' },
      },
      {
        name: 'form_submission_crm',
        label: 'Which CRM?',
        type: 'select',
        dependsOn: { field: 'form_submission_methods', includes: 'crm' },
        options: [
          { value: 'salesforce', label: 'Salesforce' },
          { value: 'hubspot', label: 'HubSpot' },
          { value: 'zoho', label: 'Zoho' },
          { value: 'pipedrive', label: 'Pipedrive' },
          { value: 'clio', label: 'Clio' },
          { value: 'lawmatics', label: 'Lawmatics' },
          { value: 'mycase', label: 'MyCase' },
          { value: 'litify', label: 'Litify' },
          { value: 'filevine', label: 'Filevine' },
          { value: 'other', label: 'Other' },
        ],
      },
      {
        name: 'form_submission_other',
        label: 'Describe the other destination',
        type: 'text',
        placeholder: 'e.g., Zapier webhook into our intake system',
        dependsOn: { field: 'form_submission_methods', includes: 'other' },
      },
    ],
  },

  // -----------------------------------------------
  // STEP 7: SEO & TARGETING (from v1 steps 14+15+16)
  // Removed: has_multiple_locations, current_review_count, current_rating
  // -----------------------------------------------
  {
    key: 'seo_targeting',
    title: 'SEO & Targeting',
    shortTitle: 'SEO',
    description: 'Where do you want to be found and for what?',
    estimatedTime: '3 min',
    icon: STEP_ICONS.magnifyingGlass,
    fields: [
      {
        name: 'service_area_type',
        label: 'How would you describe your service area?',
        type: 'radio',
        options: [
          { value: 'local', label: 'Local' },
          { value: 'regional', label: 'Regional' },
          { value: 'statewide', label: 'Statewide' },
          { value: 'national', label: 'National' },
        ],
      },
      {
        name: 'main_geographical_areas',
        label: 'What cities or areas do you want to target?',
        type: 'textarea',
        required: true,
        placeholder: 'e.g., Dallas, Fort Worth, Plano, Arlington',
      },
      // --- Law-firm path (S7.1 / S7.2 from Stage 3) ---
      // These three fields render ONLY when session.vertical = 'law_firm'.
      // home_services sessions see the trade-toggle UI below instead.
      {
        name: 'primary_case_types_keywords',
        label: 'What are your primary case types or services?',
        type: 'multiselect',
        verticalIn: ['law_firm'],
        requiredWhen: { field: 'vertical', equals: 'law_firm' },
        options: [
          { value: 'personal_injury', label: 'Personal Injury' },
          { value: 'car_accidents', label: 'Car Accidents' },
          { value: 'truck_accidents', label: 'Truck Accidents' },
          { value: 'motorcycle_accidents', label: 'Motorcycle Accidents' },
          { value: 'slip_and_fall', label: 'Slip and Fall / Premises Liability' },
          { value: 'wrongful_death', label: 'Wrongful Death' },
          { value: 'medical_malpractice', label: 'Medical Malpractice' },
          { value: 'product_liability', label: 'Product Liability' },
          { value: 'workers_compensation', label: "Workers' Compensation" },
          { value: 'workplace_injury', label: 'Workplace Injury' },
          { value: 'mass_tort', label: 'Mass Tort / Class Action' },
          { value: 'criminal_defense', label: 'Criminal Defense' },
          { value: 'dui_dwi', label: 'DUI / DWI' },
          { value: 'family_law', label: 'Family Law' },
          { value: 'employment_law', label: 'Employment Law / Discrimination' },
          { value: 'immigration', label: 'Immigration' },
          { value: 'estate_planning', label: 'Estate Planning / Probate' },
          { value: 'business_law', label: 'Business / Corporate Law' },
          { value: 'other', label: 'Other' },
        ],
      },
      {
        name: 'primary_case_types_other',
        label: 'Tell us about your other case types',
        type: 'text',
        verticalIn: ['law_firm'],
        placeholder: 'e.g., Maritime law, Aviation',
        dependsOn: { field: 'primary_case_types_keywords', includes: 'other' },
      },
      {
        name: 'case_priority',
        label: 'Which case type should we focus on first?',
        type: 'radio',
        verticalIn: ['law_firm'],
        optionsFromField: 'primary_case_types_keywords',
      },

      // --- Home-services path (Stage 9) ---
      // service_trades drives the visible service-category checklist
      // below via the renderer's `optionsFromField` cascade. Unticking a
      // trade auto-purges its child service IDs from service_categories
      // (handled in StepRenderer's multiselect onChange for this field).
      {
        name: 'service_trades',
        label: 'Which trades do you offer?',
        type: 'multiselect',
        verticalIn: ['home_services'],
        requiredWhen: { field: 'vertical', equals: 'home_services' },
        helpText: 'Tick every trade your business covers — sub-services appear below.',
        options: HOME_SERVICES_TRADE_OPTIONS,
      },
      {
        name: 'service_categories',
        label: 'Which specific services do you offer?',
        type: 'multiselect',
        verticalIn: ['home_services'],
        // Cascades on service_trades: only services whose parent trade
        // is ticked render. The renderer also groups them visually
        // under the trade label (StepRenderer special-cases this name).
        optionsFromField: 'service_trades',
        helpText: 'Tick the specific services you want to focus on. Untick a trade above to remove its services from this list.',
      },
      {
        name: 'service_priority',
        label: 'Which service should we focus on first?',
        type: 'radio',
        verticalIn: ['home_services'],
        // Cascades on service_categories — only services the user
        // actually ticked appear here.
        optionsFromField: 'service_categories',
      },
      {
        name: 'service_other',
        label: 'Other service not listed?',
        type: 'text',
        verticalIn: ['home_services'],
        placeholder: 'e.g., Solar install, Foundation repair',
        helpText: 'Optional — only if there\'s something the checklist above missed.',
      },

      {
        name: 'cases_to_avoid',
        label: 'Any case types you want to avoid?',
        labelByVertical: {
          home_services: 'Any service categories you want to avoid?',
        },
        type: 'textarea',
        placeholder: 'e.g., Workers Comp, Criminal Defense',
        helpTextByVertical: {
          home_services: 'Optional — list services you don\'t want to take on.',
        },
      },
      {
        name: 'has_gbp',
        label: 'Do you have a Google Business Profile?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' },
        ],
      },
      {
        name: 'gbp_listing_url',
        label: 'Google Business Profile URL',
        type: 'url',
        placeholder: 'https://business.google.com/...',
        dependsOn: { field: 'has_gbp', value: 'yes' },
        // S7.3: inline button so the client can sanity-check the detected
        // listing in a new tab without copy-pasting.
        linkAction: { label: 'View GBP profile' },
      },
    ],
  },

  // -----------------------------------------------
  // STEP 8: LEGAL, CONTENT & COMMUNICATION (from v1 steps 17+18+19)
  // Deferred: additional_report_recipients
  // -----------------------------------------------
  {
    key: 'legal_content_comms',
    title: 'Legal, Content & Communication',
    shortTitle: 'LEGAL',
    description: 'How should we work together?',
    estimatedTime: '3 min',
    icon: STEP_ICONS.scale,
    fields: [
      {
        name: 'has_advertising_restrictions',
        label: 'Are there special advertising rules for your industry?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' },
        ],
      },
      {
        name: 'advertising_regulations',
        label: 'What restrictions apply?',
        type: 'textarea',
        placeholder: 'e.g., state bar rules, disclaimers, etc.',
        dependsOn: { field: 'has_advertising_restrictions', value: 'yes' },
      },
      {
        name: 'legal_disclaimers',
        label: 'Any required legal disclaimers for your marketing?',
        type: 'textarea',
        placeholder: 'Paste any disclaimers that must appear on your marketing materials.',
      },
      {
        name: 'content_approval_required',
        label: 'Do you want to approve content before it goes live?',
        type: 'radio',
        options: [
          { value: 'yes_all', label: 'Yes, approve all content' },
          { value: 'major_only', label: 'Major pieces only' },
          { value: 'trust', label: 'Trust your judgment' },
        ],
      },
      {
        name: 'words_phrases_to_avoid',
        label: 'Any words or phrases we should avoid?',
        type: 'textarea',
        placeholder: 'e.g., "cheap", "aggressive", specific competitor names',
      },
      {
        name: 'topics_to_avoid',
        label: 'Any topics we should avoid?',
        type: 'textarea',
        placeholder: 'Topics your firm does not want associated with its brand.',
      },
      {
        name: 'preferred_communication',
        label: 'What is your preferred communication method?',
        type: 'radio',
        options: [
          { value: 'email', label: 'Email' },
          { value: 'phone', label: 'Phone' },
          { value: 'text', label: 'Text' },
          { value: 'slack_teams', label: 'Slack/Teams' },
        ],
      },
      {
        name: 'call_frequency_preference',
        label: 'How often would you like to meet?',
        type: 'radio',
        options: [
          { value: 'weekly', label: 'Weekly' },
          { value: 'biweekly', label: 'Biweekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'quarterly', label: 'Quarterly' },
        ],
      },
    ],
  },

  // -----------------------------------------------
  // STEP 9: ACCESS CHECKLIST (from v1 steps 20-26)
  // Deferred: has_lsa, lsa_customer_ids
  // Custom component: AccessChecklistStep
  // -----------------------------------------------
  {
    key: 'access_checklist',
    title: 'Access Checklist',
    shortTitle: 'ACCESS',
    description: 'Grant Clixsy access to your accounts. You can come back and update these later.',
    estimatedTime: '5 min',
    icon: STEP_ICONS.key,
    fields: [
      {
        name: 'has_google_analytics',
        label: 'Do you have Google Analytics set up?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' },
        ],
      },
      {
        name: 'ga_access_status',
        label: 'Google Analytics access status',
        type: 'select',
        dependsOn: { field: 'has_google_analytics', value: 'yes' },
        options: [
          { value: 'done', label: 'Done — access granted' },
          { value: 'later', label: "I'll do this later" },
          { value: 'need_help', label: 'I need help' },
          { value: 'not_applicable', label: 'Not applicable' },
        ],
      },
      {
        name: 'gsc_access_status',
        label: 'Google Search Console access status',
        type: 'select',
        options: [
          { value: 'done', label: 'Done — access granted' },
          { value: 'later', label: "I'll do this later" },
          { value: 'need_help', label: 'I need help' },
          { value: 'not_applicable', label: 'Not applicable' },
        ],
      },
      {
        name: 'gbp_access_status',
        label: 'Google Business Profile access status',
        type: 'select',
        options: [
          { value: 'done', label: 'Done — access granted' },
          { value: 'later', label: "I'll do this later" },
          { value: 'need_help', label: 'I need help' },
          { value: 'not_applicable', label: 'Not applicable' },
        ],
      },
      {
        name: 'wordpress_access_status',
        label: 'WordPress access status',
        type: 'select',
        options: [
          { value: 'done', label: 'Done — access granted' },
          { value: 'later', label: "I'll do this later" },
          { value: 'need_help', label: 'I need help' },
          { value: 'not_applicable', label: 'Not applicable' },
        ],
      },
      {
        name: 'domain_access_status',
        label: 'Domain registrar access status',
        type: 'select',
        options: [
          { value: 'done', label: 'Done — access granted' },
          { value: 'later', label: "I'll do this later" },
          { value: 'need_help', label: 'I need help' },
          { value: 'not_applicable', label: 'Not applicable' },
        ],
      },
      {
        name: 'dns_access_status',
        label: 'DNS access status',
        type: 'select',
        options: [
          { value: 'done', label: 'Done — access granted' },
          { value: 'later', label: "I'll do this later" },
          { value: 'need_help', label: 'I need help' },
          { value: 'not_applicable', label: 'Not applicable' },
        ],
      },
      {
        name: 'has_youtube',
        label: 'Do you have a YouTube channel?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      },
      {
        name: 'youtube_access_status',
        label: 'YouTube access status',
        type: 'select',
        dependsOn: { field: 'has_youtube', value: 'yes' },
        options: [
          { value: 'done', label: 'Done — access granted' },
          { value: 'later', label: "I'll do this later" },
          { value: 'need_help', label: 'I need help' },
        ],
      },
    ],
  },

  // -----------------------------------------------
  // STEP 10: TRANSITION & WRAP-UP (from v1 steps 27+28)
  // Removed: shipping_preference
  // S10.2: welcome-gift block moved out to step 2 (Other Contacts).
  // S10.1: previous-agency contact textarea split into three structured fields.
  // -----------------------------------------------
  {
    key: 'transition_wrapup',
    title: 'Transition & Wrap-up',
    shortTitle: 'WRAP-UP',
    description: 'Previous agency.',
    estimatedTime: '1 min',
    icon: STEP_ICONS.arrowPath,
    fields: [
      {
        name: 'has_previous_agency',
        label: 'Are you currently working with another marketing agency?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      },
      // S10.1: three structured fields replace the single free-text
      // "Previous agency contact info" textarea so the data is usable.
      {
        name: 'previous_agency_name',
        label: 'Agency name',
        type: 'text',
        dependsOn: { field: 'has_previous_agency', value: 'yes' },
      },
      {
        name: 'previous_agency_contact_person',
        label: 'Contact person name',
        type: 'text',
        dependsOn: { field: 'has_previous_agency', value: 'yes' },
      },
      {
        name: 'previous_agency_contact_email',
        label: 'Email address',
        type: 'email',
        dependsOn: { field: 'has_previous_agency', value: 'yes' },
      },
      {
        name: 'can_remove_agency_access',
        label: 'Would you like us to help remove their access?',
        type: 'radio',
        dependsOn: { field: 'has_previous_agency', value: 'yes' },
        options: [
          { value: 'yes', label: 'Yes please' },
          { value: 'no', label: "I'll handle it" },
          { value: 'wait', label: 'Wait until transition complete' },
        ],
      },
    ],
  },

  // -----------------------------------------------
  // STEP 11: REVIEW (from v1 step 29)
  // -----------------------------------------------
  {
    key: 'review',
    title: 'Almost There!',
    shortTitle: 'REVIEW',
    description: "Let's make sure everything looks good before submitting.",
    isReviewStep: true,
    icon: STEP_ICONS.clipboardCheck,
    fields: [],
  },

  // -----------------------------------------------
  // STEP 12: SUBMIT (from v1 step 30)
  // -----------------------------------------------
  {
    key: 'submit',
    title: 'Ready to Submit',
    shortTitle: 'SUBMIT',
    description: 'Confirm and submit your onboarding information.',
    icon: STEP_ICONS.check,
    fields: [
      {
        name: 'confirm_accuracy',
        label: 'I confirm that the information provided is accurate to the best of my knowledge.',
        type: 'checkbox',
      },
      {
        name: 'confirm_proceed',
        label: 'I authorize Clixsy to proceed with setting up my accounts and marketing services.',
        type: 'checkbox',
      },
      {
        name: 'additional_notes',
        label: 'Anything else you\'d like us to know?',
        type: 'textarea',
        placeholder: 'Any additional information, questions, or special requests.',
      },
    ],
  },
];

// =============================================
// V2 VALIDATION SCHEMAS
// =============================================

const stepValidationSchemasV2: Record<string, z.ZodSchema> = {
  primary_contact: z.object({
    // Phase 3 followup: website_url moved from business_overview to here
    // (first field on step 1). See the field's placement in the step
    // definition above for the rationale.
    website_url: z.string().min(1, 'Website URL is required'),
    main_contact_name: z.string().min(1, 'Full name is required'),
    main_contact_title: z.string().min(1, 'Title/Role is required'),
    main_contact_email: z.string().email('Please enter a valid email'),
    main_contact_phone: z.string().min(1, 'Phone number is required'),
  }).passthrough(),

  other_contacts: z.object({}).passthrough(),

  business_overview: z.object({
    business_name: z.string().min(1, 'Business name is required'),
    // Phase 3 followup: website_url moved to primary_contact (step 1).
    // Kept here as optional for back-compat with pre-existing answer
    // rows that still have it at this step_key — the wizard reads from
    // primary_contact first and falls back here.
    website_url: z.string().optional().or(z.literal('')),
    business_phone: z.string().min(1, 'Business phone is required'),
    physical_address: z.string().min(1, 'Physical address is required'),
  }).passthrough(),

  goals_strategy: z.object({
    success_definition: z.string().min(1, 'Please describe what success looks like'),
  }).passthrough(),

  brand_design: z.object({}).passthrough(),

  technical_setup: z.object({}).passthrough(),

  seo_targeting: z.object({
    main_geographical_areas: z.string().min(1, 'Please enter your target areas'),
    // S7.1: this field flipped from a free-text string to a multi-select array
    // of canonical case-type values. The schema accepts the new array shape;
    // legacy textarea answers (strings) are still tolerated by callers that
    // read JSONB but won't pass validation when re-submitted.
    //
    // Stage 9: optional() (was .min(1)) so home_services sessions can save
    // Step 7 without a case-types selection — that field's verticalIn gate
    // hides it on those sessions and the per-field `requiredWhen` predicate
    // is what actually enforces "pick at least one" for law_firm via the
    // Almost There screen's missingFields scan. Keeping the .min(1) here
    // would have blocked home_services on Next-click with an error about
    // a field they can't see.
    primary_case_types_keywords: z.array(z.string()).optional(),
    // Stage 9: home_services counterpart. Shape-only — actual required-ness
    // is gated on vertical via the field's `requiredWhen` predicate.
    service_trades: z.array(z.string()).optional(),
    service_categories: z.array(z.string()).optional(),
  }).passthrough(),

  legal_content_comms: z.object({}).passthrough(),

  access_checklist: z.object({}).passthrough(),

  transition_wrapup: z.object({}).passthrough(),

  review: z.object({}).passthrough(),

  submit: z.object({}).passthrough(),
};

// =============================================
// V2 VALIDATION FUNCTIONS
// =============================================

export function validateStepDataV2(
  stepKey: string,
  data: Record<string, unknown>
): { success: boolean; errors?: Record<string, string> } {
  const schema = stepValidationSchemasV2[stepKey];
  if (!schema) {
    return { success: true };
  }

  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true };
  }

  const errors: Record<string, string> = {};
  result.error.issues.forEach((issue) => {
    const fieldName = issue.path[0] as string;
    if (fieldName) {
      errors[fieldName] = issue.message;
    }
  });

  return { success: false, errors };
}

export function getMissingRequiredFieldsV2(
  answers: Record<string, Record<string, unknown>>,
  vertical?: VerticalId
): { stepKey: string; stepTitle: string; stepIndex: number; fieldName: string; fieldLabel: string }[] {
  const missing: { stepKey: string; stepTitle: string; stepIndex: number; fieldName: string; fieldLabel: string }[] = [];

  onboardingStepsV2.forEach((step, index) => {
    const stepAnswers = answers[step.key] || {};

    step.fields.forEach((field) => {
      // Stage 9: vertical-gated visibility — a field not in the current
      // vertical's set is never required (and never rendered, but a
      // missing-fields scan should agree with what the user actually
      // sees so the Almost-There screen doesn't list invisible fields).
      if (field.verticalIn && vertical && !field.verticalIn.includes(vertical)) return;

      // Determine whether this field is required for THIS vertical.
      // The `requiredWhen` predicate overrides the static `required`
      // flag when present — used for fields that are required only on
      // one vertical (e.g. service_trades for home_services).
      let isRequired = !!field.required;
      if (field.requiredWhen?.field === 'vertical' && vertical) {
        const eq = field.requiredWhen.equals;
        const list = field.requiredWhen.valueIn;
        isRequired =
          (eq !== undefined && eq === vertical) ||
          (list !== undefined && list.includes(vertical));
      }
      if (!isRequired) return;

      // Sibling-answer dependsOn — unchanged from pre-Stage-9 behaviour.
      if (field.dependsOn) {
        const depValue = stepAnswers[field.dependsOn.field];
        if (depValue !== field.dependsOn.value) return;
      }

      const value = stepAnswers[field.name];
      const isEmpty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);

      if (isEmpty) {
        // Surface the vertical-appropriate label if one is declared.
        const renderedLabel =
          (vertical && field.labelByVertical?.[vertical]) || field.label;
        missing.push({
          stepKey: step.key,
          stepTitle: step.title,
          stepIndex: index,
          fieldName: field.name,
          fieldLabel: renderedLabel,
        });
      }
    });
  });

  return missing;
}
