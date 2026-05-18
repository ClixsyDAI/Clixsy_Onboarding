import { z } from 'zod';

// =============================================
// ONBOARDING STEP DEFINITIONS
// =============================================

export interface OnboardingField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'url' | 'tel' | 'textarea' | 'select' | 'multiselect' | 'checkbox' | 'radio' | 'file';
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  helpText?: string;
  /**
   * Conditional rendering. Three flavours:
   *  - `value`: exact match against a scalar value (existing behaviour).
   *  - `valueIn`: show when the dependent field equals any of these values
   *    (e.g. `another_agency` OR `freelancer` from a radio group).
   *  - `includes`: show when the dependent field is an array containing this
   *    value (e.g. a multi-select group exposing sub-fields per selection).
   * Use exactly one form per field.
   */
  dependsOn?: {
    field: string;
    value?: string | boolean;
    valueIn?: string[];
    includes?: string;
  };
  /**
   * Pull the option set from another field's current value at render time —
   * used for "pick one of the items you just multi-selected" cascades
   * (e.g. case_priority depends on primary_case_types_keywords). The named
   * field must be a multi-select. Entries are matched back against its
   * declared `options` for labels and fall back to the raw value as label.
   */
  optionsFromField?: string;
  /**
   * Render a section heading before this field. Used to break a long step
   * into visually distinct groups without splitting it into a separate step
   * (e.g. the welcome-gift block at the bottom of "Other Contacts").
   */
  sectionHeader?: { title: string; subtitle?: string };
  /**
   * Render a small "open in new tab" action button next to the input.
   * Only honoured on `url`-type fields. Disabled when the current value
   * doesn't parse as a URL. Used by S7.3 to let admins confirm a detected
   * Google Business Profile URL without copy-pasting.
   */
  linkAction?: { label: string };
  videoUrl?: string;
  videoTitle?: string;
}

export interface OnboardingStep {
  key: string;
  title: string;
  shortTitle: string;
  description: string;
  fields: OnboardingField[];
  estimatedTime?: string;
  isReviewStep?: boolean; // For the "Almost There" step
  icon: string; // SVG path for the step icon
}

// Icon paths (heroicons style)
export const STEP_ICONS = {
  user: 'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z',
  users: 'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z',
  wrench: 'M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z',
  building: 'M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z',
  mapPin: 'M15 10.5a3 3 0 11-6 0 3 3 0 016 0z M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z',
  clipboard: 'M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 15a3 3 0 100-6 3 3 0 000 6z M12 12h.01',
  chartBar: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
  sparkles: 'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z',
  palette: 'M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z',
  swatch: 'M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z',
  globe: 'M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418',
  computerDesktop: 'M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25',
  signal: 'M9.348 14.651a3.75 3.75 0 010-5.303m5.304 0a3.75 3.75 0 010 5.303m-7.425 2.122a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.79M12 12h.008v.008H12V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z',
  mapLocation: 'M9 6.75V15m0-15a6 6 0 00-6 6v6.75a.75.75 0 001.5 0V6A4.5 4.5 0 019 1.5v0zm6 0a6 6 0 016 6v6.75a.75.75 0 01-1.5 0V6A4.5 4.5 0 0015 1.5v0zM9 6.75h6',
  briefcase: 'M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 00.75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 00-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0112 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 01-.673-.38m0 0A2.18 2.18 0 013 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 013.413-.387m7.5 0V5.25A2.25 2.25 0 0013.5 3h-3a2.25 2.25 0 00-2.25 2.25v.894m7.5 0a48.667 48.667 0 00-7.5 0M12 12.75h.008v.008H12v-.008z',
  magnifyingGlass: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z',
  scale: 'M12 3v17.25m0 0c-1.472 0-2.882.265-4.185.75M12 20.25c1.472 0 2.882.265 4.185.75M18.75 4.97A48.416 48.416 0 0012 4.5c-2.291 0-4.545.16-6.75.47m13.5 0c1.01.143 2.01.317 3 .52m-3-.52l2.62 10.726c.122.499-.106 1.028-.589 1.202a5.988 5.988 0 01-2.031.352 5.988 5.988 0 01-2.031-.352c-.483-.174-.711-.703-.59-1.202L18.75 4.971zm-16.5.52c.99-.203 1.99-.377 3-.52m0 0l2.62 10.726c.122.499-.106 1.028-.589 1.202a5.989 5.989 0 01-2.031.352 5.989 5.989 0 01-2.031-.352c-.483-.174-.711-.703-.59-1.202L5.25 4.971z',
  document: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z',
  chatBubble: 'M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z',
  cog: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  key: 'M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z',
  lockClosed: 'M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z',
  arrowPath: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99',
  gift: 'M21 11.25v8.25a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 109.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1114.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z',
  clipboardCheck: 'M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m8.9-4.414c.376.023.75.05 1.124.08 1.131.094 1.976 1.057 1.976 2.192V16.5A2.25 2.25 0 0118 18.75h-2.25m-7.5-10.5H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V18.75m-7.5-10.5h6.375c.621 0 1.125.504 1.125 1.125v9.375m-8.25-3l1.5 1.5 3-3.75',
  check: 'M4.5 12.75l6 6 9-13.5',
};

// =============================================
// STEP DEFINITIONS - Reorganized for minimal scrolling
// =============================================

export const onboardingSteps: OnboardingStep[] = [
  // -----------------------------------------------
  // STEP 1: PRIMARY CONTACT
  // -----------------------------------------------
  {
    key: 'primary_contact',
    title: 'Primary Contact',
    shortTitle: 'PRIMARY',
    description: 'Who is the main decision maker for this project?',
    estimatedTime: '1 min',
    icon: STEP_ICONS.user,
    fields: [
      {
        name: 'main_contact_name',
        label: 'Full Name',
        type: 'text',
        required: true,
        placeholder: 'John Smith',
        helpText: 'This should be the person with ultimate authority over the project.'
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
          { value: 'other', label: 'Other' }
        ]
      },
      { name: 'main_contact_email', label: 'Email Address', type: 'email', required: true, placeholder: 'john@example.com' },
      { name: 'main_contact_phone', label: 'Best Contact Number', type: 'tel', required: true, placeholder: '(555) 123-4567' },
    ]
  },

  // -----------------------------------------------
  // STEP 2: ADDITIONAL CONTACTS
  // -----------------------------------------------
  {
    key: 'additional_contacts',
    title: 'Additional Contacts',
    shortTitle: 'CONTACTS',
    description: 'Who else should we contact for day-to-day matters or technical questions?',
    estimatedTime: '2 min',
    icon: STEP_ICONS.users,
    fields: [
      {
        name: 'has_secondary_contact',
        label: 'Do you have a secondary contact for day-to-day matters?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No, primary contact handles everything' }
        ]
      },
      {
        name: 'secondary_contact_name',
        label: 'Secondary Contact - Full Name',
        type: 'text',
        dependsOn: { field: 'has_secondary_contact', value: 'yes' }
      },
      {
        name: 'secondary_contact_email',
        label: 'Secondary Contact - Email',
        type: 'email',
        dependsOn: { field: 'has_secondary_contact', value: 'yes' }
      },
      {
        name: 'secondary_contact_phone',
        label: 'Secondary Contact - Phone',
        type: 'tel',
        dependsOn: { field: 'has_secondary_contact', value: 'yes' }
      },
    ]
  },

  // -----------------------------------------------
  // STEP 3: TECHNICAL CONTACT
  // -----------------------------------------------
  {
    key: 'tech_contact',
    title: 'Technical Contact',
    shortTitle: 'TECH',
    description: 'Who handles technical or IT-related matters?',
    estimatedTime: '1 min',
    icon: STEP_ICONS.wrench,
    fields: [
      {
        name: 'has_tech_contact',
        label: 'Do you have a dedicated technical/IT contact?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes, we have a dedicated IT person' },
          { value: 'external', label: 'Yes, we use an external IT company' },
          { value: 'no', label: 'No, primary contact handles IT matters' }
        ]
      },
      {
        name: 'tech_contact_name',
        label: 'Technical Contact - Full Name',
        type: 'text',
        dependsOn: { field: 'has_tech_contact', value: 'yes' }
      },
      {
        name: 'tech_contact_email',
        label: 'Technical Contact - Email',
        type: 'email',
        dependsOn: { field: 'has_tech_contact', value: 'yes' }
      },
      {
        name: 'external_it_company',
        label: 'IT Company Name & Contact',
        type: 'textarea',
        placeholder: 'Company name, contact person, email, phone',
        dependsOn: { field: 'has_tech_contact', value: 'external' }
      },
    ]
  },

  // -----------------------------------------------
  // STEP 4: BUSINESS BASICS
  // -----------------------------------------------
  {
    key: 'business_basics',
    icon: STEP_ICONS.building,
    title: 'Business Basics',
    shortTitle: 'BUSINESS',
    description: 'Tell us about your business.',
    estimatedTime: '2 min',
    fields: [
      { name: 'business_name', label: 'Business Name', type: 'text', required: true, placeholder: 'Smith & Associates Law Firm' },
      { name: 'website_url', label: 'Main Website URL', type: 'url', required: true, placeholder: 'https://example.com' },
      { name: 'business_phone', label: 'Main Business Phone', type: 'tel', required: true, placeholder: '(555) 123-4567' },
      {
        name: 'year_founded',
        label: 'When was your firm founded?',
        type: 'select',
        options: [
          { value: '2020s', label: '2020 or later' },
          { value: '2010s', label: '2010-2019' },
          { value: '2000s', label: '2000-2009' },
          { value: '1990s', label: '1990-1999' },
          { value: 'before_1990', label: 'Before 1990' }
        ]
      },
    ]
  },

  // -----------------------------------------------
  // STEP 5: BUSINESS LOCATION
  // -----------------------------------------------
  {
    key: 'business_location',
    icon: STEP_ICONS.mapPin,
    title: 'Business Location',
    shortTitle: 'LOCATION',
    description: 'Where is your business located?',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'physical_address',
        label: 'Physical Company Address',
        type: 'textarea',
        required: true,
        placeholder: '123 Main Street, Suite 100\nCity, State 12345',
        helpText: 'Provide the exact address as it appears on your Google Business Profile.'
      },
      {
        name: 'location_type',
        label: 'What type of location is this?',
        type: 'radio',
        options: [
          { value: 'owned', label: 'We own this property' },
          { value: 'leased', label: 'We lease this space' },
          { value: 'virtual', label: 'Virtual office' },
          { value: 'coworking', label: 'Coworking space' }
        ]
      },
      {
        name: 'how_long_at_location',
        label: 'How long have you been at this location?',
        type: 'select',
        options: [
          { value: 'less_than_1', label: 'Less than 1 year' },
          { value: '1_to_3', label: '1-3 years' },
          { value: '3_to_5', label: '3-5 years' },
          { value: '5_to_10', label: '5-10 years' },
          { value: 'more_than_10', label: 'More than 10 years' }
        ]
      },
    ]
  },

  // -----------------------------------------------
  // STEP 6: BUSINESS DETAILS
  // -----------------------------------------------
  {
    key: 'business_details',
    icon: STEP_ICONS.clipboard,
    title: 'Business Details',
    shortTitle: 'DETAILS',
    description: 'A few more details about your business.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'languages_spoken',
        label: 'What languages are spoken at your firm?',
        type: 'multiselect',
        options: [
          { value: 'english', label: 'English' },
          { value: 'spanish', label: 'Spanish' },
          { value: 'chinese', label: 'Chinese (Mandarin/Cantonese)' },
          { value: 'vietnamese', label: 'Vietnamese' },
          { value: 'korean', label: 'Korean' },
          { value: 'tagalog', label: 'Tagalog' },
          { value: 'other', label: 'Other' }
        ]
      },
      {
        name: 'owner_names',
        label: 'Owner/Main Partner(s) Names',
        type: 'textarea',
        placeholder: 'List all owners/partners, one per line'
      },
      {
        name: 'firm_size',
        label: 'How many people work at your firm?',
        type: 'select',
        options: [
          { value: 'solo', label: 'Solo practitioner' },
          { value: '2_5', label: '2-5 employees' },
          { value: '6_10', label: '6-10 employees' },
          { value: '11_25', label: '11-25 employees' },
          { value: '26_50', label: '26-50 employees' },
          { value: '50_plus', label: 'More than 50 employees' }
        ]
      },
    ]
  },

  // -----------------------------------------------
  // STEP 7: VISION & GOALS
  // -----------------------------------------------
  {
    key: 'vision_goals',
    icon: STEP_ICONS.target,
    title: 'Vision & Goals',
    shortTitle: 'VISION',
    description: 'Help us understand what success looks like for you.',
    estimatedTime: '3 min',
    fields: [
      {
        name: 'primary_goal',
        label: 'What is your #1 goal for working with us?',
        type: 'radio',
        required: true,
        options: [
          { value: 'more_leads', label: 'Get more leads/clients' },
          { value: 'better_quality', label: 'Get better quality leads' },
          { value: 'brand_awareness', label: 'Increase brand awareness' },
          { value: 'competitive', label: 'Stay competitive with other firms' },
          { value: 'all_above', label: 'All of the above' }
        ]
      },
      {
        name: 'success_definition',
        label: 'What would make this engagement a success in 12 months?',
        type: 'textarea',
        required: true,
        placeholder: 'e.g., "I want to see 20% more qualified leads coming through our website"'
      },
      {
        name: 'current_challenges',
        label: 'What is your biggest marketing challenge right now?',
        type: 'textarea',
        placeholder: 'e.g., "We don\'t show up on Google when people search for our services"'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 8: SUCCESS METRICS
  // -----------------------------------------------
  {
    key: 'success_metrics',
    icon: STEP_ICONS.chartBar,
    title: 'Success Metrics',
    shortTitle: 'METRICS',
    description: 'How do you measure success?',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'key_performance_indicators',
        label: 'Which metrics matter most to you?',
        type: 'multiselect',
        options: [
          { value: 'website_traffic', label: 'Website traffic' },
          { value: 'phone_calls', label: 'Phone calls' },
          { value: 'form_submissions', label: 'Form submissions' },
          { value: 'signed_clients', label: 'Signed clients' },
          { value: 'google_rankings', label: 'Google rankings' },
          { value: 'google_reviews', label: 'Google reviews' },
          { value: 'revenue', label: 'Revenue growth' }
        ]
      },
      {
        name: 'current_lead_volume',
        label: 'How many leads do you currently get per month?',
        type: 'select',
        options: [
          { value: 'less_than_10', label: 'Less than 10' },
          { value: '10_25', label: '10-25' },
          { value: '26_50', label: '26-50' },
          { value: '51_100', label: '51-100' },
          { value: 'more_than_100', label: 'More than 100' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
      {
        name: 'target_lead_volume',
        label: 'How many leads would you like to get per month?',
        type: 'select',
        options: [
          { value: '10_25', label: '10-25' },
          { value: '26_50', label: '26-50' },
          { value: '51_100', label: '51-100' },
          { value: '101_200', label: '101-200' },
          { value: 'more_than_200', label: 'More than 200' }
        ]
      },
    ]
  },

  // -----------------------------------------------
  // STEP 9: BRAND ASSETS
  // -----------------------------------------------
  {
    key: 'brand_assets',
    icon: STEP_ICONS.sparkles,
    title: 'Brand Assets',
    shortTitle: 'BRAND',
    description: 'Help us maintain your visual identity.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'has_brand_guide',
        label: 'Do you have a brand style guide?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes, we have a style guide' },
          { value: 'partial', label: 'We have some guidelines but not a full guide' },
          { value: 'no', label: 'No, we don\'t have one' }
        ]
      },
      {
        name: 'brand_style_guide_url',
        label: 'Link to your brand style guide',
        type: 'url',
        placeholder: 'https://...',
        dependsOn: { field: 'has_brand_guide', value: 'yes' }
      },
      {
        name: 'has_logo_files',
        label: 'Do you have high-quality logo files?',
        type: 'radio',
        options: [
          { value: 'yes_vector', label: 'Yes, vector files (AI, EPS, SVG)' },
          { value: 'yes_png', label: 'Yes, but only PNG/JPG' },
          { value: 'no', label: 'No / Not sure' }
        ]
      },
      {
        name: 'logo_package_url',
        label: 'Link to your logo files',
        type: 'url',
        placeholder: 'Google Drive, Dropbox, etc.',
        dependsOn: { field: 'has_logo_files', value: 'yes_vector' }
      },
    ]
  },

  // -----------------------------------------------
  // STEP 10: BRAND COLORS
  // -----------------------------------------------
  {
    key: 'brand_colors',
    icon: STEP_ICONS.palette,
    title: 'Brand Colors & Fonts',
    shortTitle: 'COLORS',
    description: 'What are your brand colors and fonts?',
    estimatedTime: '1 min',
    fields: [
      {
        name: 'knows_brand_colors',
        label: 'Do you know your brand color hex codes?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes, I know them' },
          { value: 'no', label: 'No, please pull them from our website' }
        ]
      },
      {
        name: 'primary_color',
        label: 'Primary Brand Color (Hex)',
        type: 'text',
        placeholder: '#000000',
        dependsOn: { field: 'knows_brand_colors', value: 'yes' }
      },
      {
        name: 'secondary_color',
        label: 'Secondary Brand Color (Hex)',
        type: 'text',
        placeholder: '#000000',
        dependsOn: { field: 'knows_brand_colors', value: 'yes' }
      },
      {
        name: 'typography_fonts',
        label: 'What fonts do you use?',
        type: 'text',
        placeholder: 'e.g., Montserrat (Headers), Open Sans (Body)'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 11: DOMAIN & WEBSITE
  // -----------------------------------------------
  {
    key: 'domain_website',
    icon: STEP_ICONS.globe,
    title: 'Domain & Website',
    shortTitle: 'DOMAIN',
    description: 'Tell us about your domain and website setup.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'owns_domain',
        label: 'Do you own your domain name?',
        type: 'radio',
        required: true,
        options: [
          { value: 'yes', label: 'Yes, we own it' },
          { value: 'no', label: 'No, someone else owns it' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
      {
        name: 'domain_registrar',
        label: 'Where is your domain registered?',
        type: 'select',
        options: [
          { value: 'godaddy', label: 'GoDaddy' },
          { value: 'namecheap', label: 'Namecheap' },
          { value: 'google_domains', label: 'Google Domains / Squarespace' },
          { value: 'cloudflare', label: 'Cloudflare' },
          { value: 'network_solutions', label: 'Network Solutions' },
          { value: 'other', label: 'Other / Not sure' }
        ]
      },
      {
        name: 'controls_dns',
        label: 'Do you have access to your DNS settings?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
    ]
  },

  // -----------------------------------------------
  // STEP 12: WEBSITE PLATFORM
  // -----------------------------------------------
  {
    key: 'website_platform',
    icon: STEP_ICONS.computerDesktop,
    title: 'Website Platform',
    shortTitle: 'PLATFORM',
    description: 'What platform is your website built on?',
    estimatedTime: '1 min',
    fields: [
      {
        name: 'website_platform',
        label: 'What platform is your website built on?',
        type: 'radio',
        options: [
          { value: 'wordpress', label: 'WordPress' },
          { value: 'squarespace', label: 'Squarespace' },
          { value: 'wix', label: 'Wix' },
          { value: 'webflow', label: 'Webflow' },
          { value: 'custom', label: 'Custom built' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
      {
        name: 'has_wordpress_access',
        label: 'Do you have WordPress admin access?',
        type: 'radio',
        dependsOn: { field: 'website_platform', value: 'wordpress' },
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
      {
        name: 'website_managed_by',
        label: 'Who currently manages your website?',
        type: 'radio',
        options: [
          { value: 'internal', label: 'We manage it internally' },
          { value: 'agency', label: 'Another agency manages it' },
          { value: 'freelancer', label: 'A freelancer manages it' },
          { value: 'no_one', label: 'No one actively manages it' }
        ]
      },
    ]
  },

  // -----------------------------------------------
  // STEP 13: LEAD TRACKING
  // -----------------------------------------------
  {
    key: 'lead_tracking',
    icon: STEP_ICONS.signal,
    title: 'Lead Tracking',
    shortTitle: 'TRACKING',
    description: 'How do you track leads?',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'uses_call_tracking',
        label: 'Do you use call tracking?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
      {
        name: 'call_tracking_provider',
        label: 'Which call tracking provider?',
        type: 'select',
        dependsOn: { field: 'uses_call_tracking', value: 'yes' },
        options: [
          { value: 'callrail', label: 'CallRail' },
          { value: 'calltrackingmetrics', label: 'CallTrackingMetrics' },
          { value: 'marchex', label: 'Marchex' },
          { value: 'other', label: 'Other' }
        ]
      },
      {
        name: 'form_submission_destinations',
        label: 'Where should form submissions be sent?',
        type: 'textarea',
        placeholder: 'Email addresses or intake software names',
        helpText: 'List all email addresses or software where form submissions should go.'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 14: SEO TARGET AREAS
  // -----------------------------------------------
  {
    key: 'seo_areas',
    icon: STEP_ICONS.mapPin,
    title: 'Target Areas',
    shortTitle: 'AREAS',
    description: 'Where do you want to be found?',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'service_area_type',
        label: 'What is your service area?',
        type: 'radio',
        required: true,
        options: [
          { value: 'local', label: 'Local (one city/metro area)' },
          { value: 'regional', label: 'Regional (multiple cities/counties)' },
          { value: 'statewide', label: 'Statewide' },
          { value: 'national', label: 'National' }
        ]
      },
      {
        name: 'main_geographical_areas',
        label: 'List your target cities/areas',
        type: 'textarea',
        required: true,
        placeholder: 'e.g., Los Angeles, Orange County, San Diego',
        helpText: 'List the cities, regions, or states you want to target.'
      },
      {
        name: 'has_multiple_locations',
        label: 'Do you have multiple office locations?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No, just one location' }
        ]
      },
    ]
  },

  // -----------------------------------------------
  // STEP 15: SEO CASE TYPES
  // -----------------------------------------------
  {
    key: 'seo_cases',
    icon: STEP_ICONS.briefcase,
    title: 'Case Types & Keywords',
    shortTitle: 'CASES',
    description: 'What services should we focus on?',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'primary_case_types_keywords',
        label: 'What are your primary case types?',
        type: 'textarea',
        required: true,
        placeholder: 'e.g., Personal injury, car accidents, slip and fall',
        helpText: 'List the case types most important to your business.'
      },
      {
        name: 'case_priority',
        label: 'Which case type should we focus on first?',
        type: 'text',
        placeholder: 'e.g., Car accidents'
      },
      {
        name: 'cases_to_avoid',
        label: 'Are there any case types you do NOT want?',
        type: 'textarea',
        placeholder: 'e.g., We don\'t handle criminal cases'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 16: GOOGLE BUSINESS PROFILE
  // -----------------------------------------------
  {
    key: 'google_business',
    icon: STEP_ICONS.magnifyingGlass,
    title: 'Google Business Profile',
    shortTitle: 'GBP',
    description: 'Tell us about your Google Business Profile.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'has_gbp',
        label: 'Do you have a Google Business Profile?',
        type: 'radio',
        required: true,
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
      {
        name: 'gbp_listing_url',
        label: 'Google Business Profile URL',
        type: 'url',
        placeholder: 'https://g.page/...',
        dependsOn: { field: 'has_gbp', value: 'yes' }
      },
      {
        name: 'current_review_count',
        label: 'Approximately how many Google reviews do you have?',
        type: 'select',
        dependsOn: { field: 'has_gbp', value: 'yes' },
        options: [
          { value: '0_10', label: '0-10 reviews' },
          { value: '11_25', label: '11-25 reviews' },
          { value: '26_50', label: '26-50 reviews' },
          { value: '51_100', label: '51-100 reviews' },
          { value: '100_plus', label: 'More than 100 reviews' }
        ]
      },
      {
        name: 'current_rating',
        label: 'What is your current star rating?',
        type: 'select',
        dependsOn: { field: 'has_gbp', value: 'yes' },
        options: [
          { value: '5', label: '5 stars' },
          { value: '4.5_5', label: '4.5-5 stars' },
          { value: '4_4.5', label: '4-4.5 stars' },
          { value: 'below_4', label: 'Below 4 stars' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
    ]
  },

  // -----------------------------------------------
  // STEP 17: LEGAL & COMPLIANCE
  // -----------------------------------------------
  {
    key: 'legal_compliance',
    icon: STEP_ICONS.scale,
    title: 'Legal & Compliance',
    shortTitle: 'LEGAL',
    description: 'Any advertising restrictions we should know about?',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'has_advertising_restrictions',
        label: 'Does your state have special advertising rules?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
      {
        name: 'advertising_regulations',
        label: 'What restrictions apply?',
        type: 'textarea',
        placeholder: 'e.g., Must include disclaimer, can\'t use certain terms',
        dependsOn: { field: 'has_advertising_restrictions', value: 'yes' }
      },
      {
        name: 'legal_disclaimers',
        label: 'Do you have required legal disclaimers?',
        type: 'textarea',
        placeholder: 'Paste any required disclaimer text here'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 18: CONTENT PREFERENCES
  // -----------------------------------------------
  {
    key: 'content_preferences',
    icon: STEP_ICONS.document,
    title: 'Content Preferences',
    shortTitle: 'CONTENT',
    description: 'How involved do you want to be with content?',
    estimatedTime: '1 min',
    fields: [
      {
        name: 'content_approval_required',
        label: 'Would you like to approve content before publishing?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes, approve everything' },
          { value: 'major_only', label: 'Only major pieces (blogs, landing pages)' },
          { value: 'no', label: 'No, I trust your judgment' }
        ]
      },
      {
        name: 'words_phrases_to_avoid',
        label: 'Any words or phrases we should avoid?',
        type: 'textarea',
        placeholder: 'e.g., "Aggressive", "Win your case guaranteed"'
      },
      {
        name: 'topics_to_avoid',
        label: 'Any topics we should avoid?',
        type: 'textarea',
        placeholder: 'e.g., Don\'t discuss specific settlement amounts'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 19: COMMUNICATION PREFERENCES
  // -----------------------------------------------
  {
    key: 'communication',
    icon: STEP_ICONS.chatBubble,
    title: 'Communication',
    shortTitle: 'COMMS',
    description: 'How do you prefer to communicate?',
    estimatedTime: '1 min',
    fields: [
      {
        name: 'preferred_communication',
        label: 'Preferred communication method',
        type: 'radio',
        options: [
          { value: 'email', label: 'Email' },
          { value: 'phone', label: 'Phone calls' },
          { value: 'text', label: 'Text messages' },
          { value: 'slack', label: 'Slack / Teams' }
        ]
      },
      {
        name: 'call_frequency_preference',
        label: 'How often would you like to meet?',
        type: 'radio',
        options: [
          { value: 'weekly', label: 'Weekly calls' },
          { value: 'biweekly', label: 'Every two weeks' },
          { value: 'monthly', label: 'Monthly calls' },
          { value: 'quarterly', label: 'Quarterly calls with video updates' }
        ]
      },
      {
        name: 'additional_report_recipients',
        label: 'Who else should receive reports?',
        type: 'textarea',
        placeholder: 'Name and email for each person',
        helpText: 'List anyone else who should receive monthly reports.'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 20: GOOGLE ANALYTICS ACCESS
  // -----------------------------------------------
  {
    key: 'google_analytics_access',
    icon: STEP_ICONS.chartBar,
    title: 'Google Analytics Access',
    shortTitle: 'ANALYTICS',
    description: 'Grant us access to your Google Analytics.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'has_google_analytics',
        label: 'Do you have Google Analytics set up?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
      {
        name: 'ga_access_granted',
        label: 'Google Analytics access status',
        type: 'radio',
        dependsOn: { field: 'has_google_analytics', value: 'yes' },
        options: [
          { value: 'granted', label: 'I\'ve added tempclixsyreports@gmail.com' },
          { value: 'will_do', label: 'I\'ll do this after' },
          { value: 'need_help', label: 'I need help with this' }
        ],
        helpText: 'Go to https://analytics.google.com and add tempclixsyreports@gmail.com as OWNER.',
        videoUrl: 'https://youtu.be/8nWZRo_l8bs',
        videoTitle: 'Tutorial - How to add admin user to Google Analytics'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 21: GOOGLE SEARCH CONSOLE ACCESS
  // -----------------------------------------------
  {
    key: 'google_search_console_access',
    icon: STEP_ICONS.magnifyingGlass,
    title: 'Google Search Console Access',
    shortTitle: 'SEARCH',
    description: 'Grant us access to your Google Search Console.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'gsc_access_granted',
        label: 'Google Search Console access status',
        type: 'radio',
        options: [
          { value: 'granted', label: 'I\'ve added tempclixsyreports@gmail.com' },
          { value: 'will_do', label: 'I\'ll do this after' },
          { value: 'need_help', label: 'I need help with this' },
          { value: 'not_setup', label: 'Not set up yet' }
        ],
        helpText: 'Go to https://search.google.com/search-console/welcome and add tempclixsyreports@gmail.com as OWNER.',
        videoUrl: 'https://youtu.be/17KmgnPz-K4',
        videoTitle: 'Tutorial - How to add admin user to Google Search Console'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 22: GOOGLE BUSINESS PROFILE ACCESS
  // -----------------------------------------------
  {
    key: 'google_business_profile_access',
    icon: STEP_ICONS.building,
    title: 'Google Business Profile Access',
    shortTitle: 'GBP',
    description: 'Grant us access to your Google Business Profile.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'gbp_access_granted',
        label: 'Google Business Profile access status',
        type: 'radio',
        options: [
          { value: 'granted', label: 'I\'ve added tempclixsyreports@gmail.com' },
          { value: 'will_do', label: 'I\'ll do this after' },
          { value: 'need_help', label: 'I need help with this' },
          { value: 'no_gbp', label: 'I don\'t have a GBP' }
        ],
        helpText: 'Go to https://business.google.com and add tempclixsyreports@gmail.com as OWNER.',
        videoUrl: 'https://youtu.be/0Vb6v8YA3AY?si=PD9PU-VYRP-n1yLz',
        videoTitle: 'Tutorial - How to add admin user to Google Business Profile'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 23: WORDPRESS ACCESS
  // -----------------------------------------------
  {
    key: 'wordpress_access',
    icon: STEP_ICONS.computerDesktop,
    title: 'WordPress Access',
    shortTitle: 'WORDPRESS',
    description: 'Grant us admin access to your WordPress site.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'wordpress_access_granted',
        label: 'WordPress Admin access status',
        type: 'radio',
        options: [
          { value: 'granted', label: 'I\'ve created a user for keith@clixsy.com' },
          { value: 'will_do', label: 'I\'ll do this after' },
          { value: 'need_help', label: 'I need help with this' },
          { value: 'not_wordpress', label: 'My site isn\'t WordPress' }
        ],
        helpText: 'Go to https://yourdomain/wp-admin and add keith@clixsy.com as ADMINISTRATOR.',
        videoUrl: 'https://youtu.be/pxB2YB1578Q',
        videoTitle: 'Tutorial - How to grant admin access to WordPress'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 24: DOMAIN REGISTRAR ACCESS
  // -----------------------------------------------
  {
    key: 'domain_registrar_access',
    icon: STEP_ICONS.globe,
    title: 'Domain Registrar Access',
    shortTitle: 'DOMAIN',
    description: 'Grant us access to your domain registrar.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'domain_registrar_access_status',
        label: 'Domain registrar access status',
        type: 'radio',
        options: [
          { value: 'granted', label: 'I\'ve granted access to corey@clixsy.com' },
          { value: 'will_do', label: 'I\'ll do this after' },
          { value: 'need_help', label: 'I need help with this' },
          { value: 'will_share_login', label: 'I\'ll share login details separately' }
        ],
        helpText: 'Share your Domain Registrar (eg GoDaddy) username/password, or delegate access to corey@clixsy.com.',
        videoUrl: 'https://youtu.be/ProhJAnO9ms',
        videoTitle: 'Tutorial - How to delegate access to Domain Registrar'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 25: CLOUDFLARE/DNS ACCESS
  // -----------------------------------------------
  {
    key: 'cloudflare_access',
    icon: STEP_ICONS.cog,
    title: 'Cloudflare / DNS Access',
    shortTitle: 'DNS',
    description: 'Grant us access to your DNS provider.',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'dns_access_granted',
        label: 'DNS access status',
        type: 'radio',
        options: [
          { value: 'granted', label: 'I\'ve added tempclixsyreports@gmail.com' },
          { value: 'will_do', label: 'I\'ll do this after' },
          { value: 'need_help', label: 'I need help with this' },
          { value: 'same_as_domain', label: 'Same as domain registrar' }
        ],
        helpText: 'Go to https://dash.cloudflare.com and add tempclixsyreports@gmail.com.',
        videoUrl: 'https://youtu.be/s7AS0XYR0KI',
        videoTitle: 'Tutorial - How to delegate access to Cloudflare'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 26: OTHER ACCESS
  // -----------------------------------------------
  {
    key: 'other_access',
    icon: STEP_ICONS.lockClosed,
    title: 'Other Access',
    shortTitle: 'OTHER',
    description: 'Any other accounts we should have access to?',
    estimatedTime: '2 min',
    fields: [
      {
        name: 'has_youtube',
        label: 'Do you have a YouTube channel?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' }
        ]
      },
      {
        name: 'youtube_access_granted',
        label: 'YouTube access status',
        type: 'radio',
        dependsOn: { field: 'has_youtube', value: 'yes' },
        options: [
          { value: 'granted', label: 'I\'ve added tempclixsyreports@gmail.com' },
          { value: 'will_do', label: 'I\'ll do this after' },
          { value: 'need_help', label: 'I need help with this' }
        ]
      },
      {
        name: 'has_lsa',
        label: 'Do you have Local Services Ads (LSA)?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'not_sure', label: 'Not sure' }
        ]
      },
      {
        name: 'lsa_customer_ids',
        label: 'LSA Customer ID(s)',
        type: 'text',
        placeholder: 'Your LSA Customer ID number',
        dependsOn: { field: 'has_lsa', value: 'yes' },
        helpText: 'Provide your Customer ID so we can send an access request.'
      },
    ]
  },

  // -----------------------------------------------
  // STEP 27: PREVIOUS AGENCY
  // -----------------------------------------------
  {
    key: 'previous_agency',
    icon: STEP_ICONS.arrowPath,
    title: 'Previous Agency',
    shortTitle: 'PREV',
    description: 'Are you transitioning from another agency?',
    estimatedTime: '1 min',
    fields: [
      {
        name: 'has_previous_agency',
        label: 'Were you working with another marketing agency?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' }
        ]
      },
      {
        name: 'previous_agency_contact',
        label: 'Previous agency contact info',
        type: 'textarea',
        placeholder: 'Agency name, contact person, email, phone',
        dependsOn: { field: 'has_previous_agency', value: 'yes' },
        helpText: 'We may need to coordinate the transition with them.'
      },
      {
        name: 'can_remove_agency_access',
        label: 'Can we remove their access to your accounts?',
        type: 'radio',
        dependsOn: { field: 'has_previous_agency', value: 'yes' },
        options: [
          { value: 'yes', label: 'Yes, please remove their access' },
          { value: 'no', label: 'No, I\'ll handle that myself' },
          { value: 'wait', label: 'Wait until transition is complete' }
        ]
      },
    ]
  },

  // -----------------------------------------------
  // STEP 28: WELCOME GIFT
  // -----------------------------------------------
  {
    key: 'welcome_gift',
    icon: STEP_ICONS.gift,
    title: 'Welcome Gift',
    shortTitle: 'GIFT',
    description: 'We\'d love to send you a welcome gift!',
    estimatedTime: '1 min',
    fields: [
      {
        name: 'wants_welcome_gift',
        label: 'Would you like to receive a welcome gift?',
        type: 'radio',
        options: [
          { value: 'yes', label: 'Yes, please!' },
          { value: 'no', label: 'No, thank you' }
        ]
      },
      {
        name: 'gift_recipient_name',
        label: 'Recipient Name',
        type: 'text',
        dependsOn: { field: 'wants_welcome_gift', value: 'yes' }
      },
      {
        name: 'gift_shipping_address',
        label: 'Shipping Address',
        type: 'textarea',
        placeholder: 'Full shipping address',
        dependsOn: { field: 'wants_welcome_gift', value: 'yes' }
      },
      {
        name: 'shipping_preference',
        label: 'Any shipping instructions?',
        type: 'textarea',
        placeholder: 'e.g., Wait until after Dec 15',
        dependsOn: { field: 'wants_welcome_gift', value: 'yes' }
      },
    ]
  },

  // -----------------------------------------------
  // STEP 29: ALMOST THERE (Review Missing Items)
  // -----------------------------------------------
  {
    key: 'almost_there',
    icon: STEP_ICONS.clipboardCheck,
    title: 'Almost There!',
    shortTitle: 'REVIEW',
    description: 'Let\'s make sure we have everything we need.',
    estimatedTime: '2 min',
    isReviewStep: true,
    fields: [] // This step will dynamically show missing fields
  },

  // -----------------------------------------------
  // STEP 30: FINAL CONFIRMATION
  // -----------------------------------------------
  {
    key: 'final_review',
    icon: STEP_ICONS.check,
    title: 'Ready to Submit',
    shortTitle: 'SUBMIT',
    description: 'Confirm and submit your onboarding.',
    estimatedTime: '1 min',
    fields: [
      {
        name: 'confirm_accuracy',
        label: 'I confirm that the information provided is accurate to the best of my knowledge',
        type: 'checkbox',
        required: true
      },
      {
        name: 'confirm_proceed',
        label: 'I authorize Clixsy to proceed with the marketing setup based on this information',
        type: 'checkbox',
        required: true
      },
      {
        name: 'additional_notes',
        label: 'Anything else you\'d like us to know?',
        type: 'textarea',
        placeholder: 'Questions, concerns, or additional information'
      },
    ]
  }
];

// =============================================
// ZOD VALIDATION SCHEMAS
// =============================================

// Helper to create optional string
const optionalString = z.string().optional().or(z.literal(''));
const optionalUrl = z.string().url().optional().or(z.literal(''));
const optionalEmail = z.string().email().optional().or(z.literal(''));

// Step-specific validation schemas
export const stepValidationSchemas: Record<string, z.ZodSchema> = {
  primary_contact: z.object({
    main_contact_name: z.string().min(1, 'Full name is required'),
    main_contact_title: z.string().min(1, 'Title/Role is required'),
    main_contact_email: z.string().email('Please enter a valid email'),
    main_contact_phone: z.string().min(1, 'Phone number is required'),
  }),

  additional_contacts: z.object({
    has_secondary_contact: optionalString,
    secondary_contact_name: optionalString,
    secondary_contact_email: optionalEmail,
    secondary_contact_phone: optionalString,
  }),

  tech_contact: z.object({
    has_tech_contact: optionalString,
    tech_contact_name: optionalString,
    tech_contact_email: optionalEmail,
    external_it_company: optionalString,
  }),

  business_basics: z.object({
    business_name: z.string().min(1, 'Business name is required'),
    website_url: z.string().url('Please enter a valid URL'),
    business_phone: z.string().min(1, 'Business phone is required'),
    year_founded: optionalString,
  }),

  business_location: z.object({
    physical_address: z.string().min(1, 'Physical address is required'),
    location_type: optionalString,
    how_long_at_location: optionalString,
  }),

  business_details: z.object({
    languages_spoken: z.array(z.string()).optional(),
    owner_names: optionalString,
    firm_size: optionalString,
  }),

  vision_goals: z.object({
    primary_goal: z.string().min(1, 'Please select your primary goal'),
    success_definition: z.string().min(1, 'Please describe what success looks like'),
    current_challenges: optionalString,
  }),

  success_metrics: z.object({
    key_performance_indicators: z.array(z.string()).optional(),
    current_lead_volume: optionalString,
    target_lead_volume: optionalString,
  }),

  brand_assets: z.object({
    has_brand_guide: optionalString,
    brand_style_guide_url: optionalUrl,
    has_logo_files: optionalString,
    logo_package_url: optionalUrl,
  }),

  brand_colors: z.object({
    knows_brand_colors: optionalString,
    primary_color: optionalString,
    secondary_color: optionalString,
    typography_fonts: optionalString,
  }),

  domain_website: z.object({
    owns_domain: z.string().min(1, 'Please indicate domain ownership'),
    domain_registrar: optionalString,
    controls_dns: optionalString,
  }),

  website_platform: z.object({
    website_platform: optionalString,
    has_wordpress_access: optionalString,
    website_managed_by: optionalString,
  }),

  lead_tracking: z.object({
    uses_call_tracking: optionalString,
    call_tracking_provider: optionalString,
    form_submission_destinations: optionalString,
  }),

  seo_areas: z.object({
    service_area_type: z.string().min(1, 'Please select your service area type'),
    main_geographical_areas: z.string().min(1, 'Please list your target areas'),
    has_multiple_locations: optionalString,
  }),

  seo_cases: z.object({
    primary_case_types_keywords: z.string().min(1, 'Please list your primary case types'),
    case_priority: optionalString,
    cases_to_avoid: optionalString,
  }),

  google_business: z.object({
    has_gbp: z.string().min(1, 'Please indicate GBP status'),
    gbp_listing_url: optionalUrl,
    current_review_count: optionalString,
    current_rating: optionalString,
  }),

  legal_compliance: z.object({
    has_advertising_restrictions: optionalString,
    advertising_regulations: optionalString,
    legal_disclaimers: optionalString,
  }),

  content_preferences: z.object({
    content_approval_required: optionalString,
    words_phrases_to_avoid: optionalString,
    topics_to_avoid: optionalString,
  }),

  communication: z.object({
    preferred_communication: optionalString,
    call_frequency_preference: optionalString,
    additional_report_recipients: optionalString,
  }),

  google_analytics_access: z.object({
    has_google_analytics: optionalString,
    ga_access_granted: optionalString,
  }),

  google_search_console_access: z.object({
    gsc_access_granted: optionalString,
  }),

  google_business_profile_access: z.object({
    gbp_access_granted: optionalString,
  }),

  wordpress_access: z.object({
    wordpress_access_granted: optionalString,
  }),

  domain_registrar_access: z.object({
    domain_registrar_access_status: optionalString,
  }),

  cloudflare_access: z.object({
    dns_access_granted: optionalString,
  }),

  other_access: z.object({
    has_youtube: optionalString,
    youtube_access_granted: optionalString,
    has_lsa: optionalString,
    lsa_customer_ids: optionalString,
  }),

  previous_agency: z.object({
    has_previous_agency: optionalString,
    previous_agency_contact: optionalString,
    can_remove_agency_access: optionalString,
  }),

  welcome_gift: z.object({
    wants_welcome_gift: optionalString,
    gift_recipient_name: optionalString,
    gift_shipping_address: optionalString,
    shipping_preference: optionalString,
  }),

  almost_there: z.object({}), // No validation needed, this is a review step

  final_review: z.object({
    confirm_accuracy: z.boolean().refine(val => val === true, 'You must confirm accuracy'),
    confirm_proceed: z.boolean().refine(val => val === true, 'You must authorize proceeding'),
    additional_notes: optionalString,
  }),
};

// Get step by key
export function getStepByKey(key: string): OnboardingStep | undefined {
  return onboardingSteps.find(step => step.key === key);
}

// Get step index by key
export function getStepIndex(key: string): number {
  return onboardingSteps.findIndex(step => step.key === key);
}

// Validate step data
export function validateStepData(stepKey: string, data: Record<string, unknown>): { success: boolean; errors?: Record<string, string> } {
  const schema = stepValidationSchemas[stepKey];
  if (!schema) {
    return { success: true };
  }

  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true };
  }

  const errors: Record<string, string> = {};
  result.error.issues.forEach(issue => {
    const path = issue.path.join('.');
    errors[path] = issue.message;
  });

  return { success: false, errors };
}

// Get all required fields across all steps
export function getAllRequiredFields(): { stepKey: string; stepTitle: string; fieldName: string; fieldLabel: string }[] {
  const requiredFields: { stepKey: string; stepTitle: string; fieldName: string; fieldLabel: string }[] = [];

  onboardingSteps.forEach(step => {
    step.fields.forEach(field => {
      if (field.required) {
        requiredFields.push({
          stepKey: step.key,
          stepTitle: step.title,
          fieldName: field.name,
          fieldLabel: field.label,
        });
      }
    });
  });

  return requiredFields;
}

// Get missing required fields based on current answers
export function getMissingRequiredFields(
  answers: Record<string, Record<string, unknown>>
): { stepKey: string; stepTitle: string; stepIndex: number; fieldName: string; fieldLabel: string }[] {
  const missing: { stepKey: string; stepTitle: string; stepIndex: number; fieldName: string; fieldLabel: string }[] = [];

  onboardingSteps.forEach((step, index) => {
    const stepAnswers = answers[step.key] || {};

    step.fields.forEach(field => {
      if (field.required) {
        const value = stepAnswers[field.name];
        const isEmpty = value === undefined || value === null || value === '' ||
          (Array.isArray(value) && value.length === 0);

        if (isEmpty) {
          missing.push({
            stepKey: step.key,
            stepTitle: step.title,
            stepIndex: index,
            fieldName: field.name,
            fieldLabel: field.label,
          });
        }
      }
    });
  });

  return missing;
}
