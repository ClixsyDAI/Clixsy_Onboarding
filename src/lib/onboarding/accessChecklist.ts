// =============================================
// ACCESS CHECKLIST DEFINITIONS
// =============================================
// Auto-generate a checklist of access requirements from onboarding answers

export type AccessKey = 'wordpress' | 'domain' | 'dns' | 'gsc' | 'ga' | 'gbp' | 'youtube' | 'lsa';

export interface AccessItem {
  key: AccessKey;
  label: string;
  shortLabel: string;
  description: string;
  whatWeNeed: string;
  helpText?: string;
}

export interface AccessItemStatus extends AccessItem {
  provided: boolean;
  relevant: boolean;
}

export interface AccessChecklist {
  items: AccessItemStatus[];
  missingCount: number;
  presentCount: number;
  notApplicableCount: number;
  missingKeys: AccessKey[];
  presentKeys: AccessKey[];
  missingAccessText: string;
}

// Type for answers organized by step key
export type AnswersByStep = Record<string, Record<string, unknown>>;

// Helper functions to safely check answer values
function hasAnyString(answers: Record<string, unknown> | undefined, keys: string[]): boolean {
  if (!answers) return false;
  return keys.some(key => {
    const value = answers[key];
    return typeof value === 'string' && value.trim() !== '';
  });
}

function hasValue(answers: Record<string, unknown> | undefined, key: string, targetValue: string): boolean {
  if (!answers) return false;
  const value = answers[key];
  return value === targetValue;
}

function hasGrantedValue(answers: Record<string, unknown> | undefined, key: string): boolean {
  if (!answers) return false;
  const value = answers[key];
  return value === 'granted' || value === 'will_do';
}

// =============================================
// ACCESS ITEM DEFINITIONS
// Based on Clixsy Technical Access requirements
// =============================================

export const ACCESS_ITEMS: AccessItem[] = [
  {
    key: 'wordpress',
    label: 'WordPress Admin',
    shortLabel: 'WP',
    description: 'WordPress Administrator access',
    whatWeNeed: 'Add keith@clixsy.com as an Administrator',
  },
  {
    key: 'domain',
    label: 'Domain Registrar',
    shortLabel: 'Domain',
    description: 'Domain registrar delegate access',
    whatWeNeed: 'Delegate access to corey@clixsy.com (e.g., GoDaddy)',
  },
  {
    key: 'dns',
    label: 'DNS Access',
    shortLabel: 'DNS',
    description: 'DNS provider access (e.g., Cloudflare)',
    whatWeNeed: 'Add tempclixsyreports@gmail.com to DNS provider',
  },
  {
    key: 'gsc',
    label: 'Google Search Console',
    shortLabel: 'GSC',
    description: 'Google Search Console Owner access',
    whatWeNeed: 'Add tempclixsyreports@gmail.com as an Owner',
  },
  {
    key: 'ga',
    label: 'Google Analytics',
    shortLabel: 'GA',
    description: 'Google Analytics Administrator access',
    whatWeNeed: 'Add tempclixsyreports@gmail.com as an Administrator',
  },
  {
    key: 'gbp',
    label: 'Google Business Profile',
    shortLabel: 'GBP',
    description: 'Google Business Profile Owner access',
    whatWeNeed: 'Add tempclixsyreports@gmail.com as an Owner',
  },
  {
    key: 'youtube',
    label: 'YouTube',
    shortLabel: 'YT',
    description: 'YouTube channel Manager access',
    whatWeNeed: 'Add tempclixsyreports@gmail.com as a Manager',
    helpText: 'YouTube Studio > Settings > Permissions > Invite, role Manager',
  },
  {
    key: 'lsa',
    label: 'Local Services Ads',
    shortLabel: 'LSA',
    description: 'Local Services Ads Customer ID',
    whatWeNeed: 'Provide Customer ID Number(s) for LSA access request',
  },
];

// =============================================
// ACCESS CHECK FUNCTIONS
// Updated to use new step keys
// =============================================

const accessCheckers: Record<AccessKey, {
  isRelevant: (answersByStep: AnswersByStep) => boolean;
  isProvided: (answersByStep: AnswersByStep) => boolean;
}> = {
  wordpress: {
    isRelevant: (answersByStep) => {
      const platform = answersByStep['website_platform'];
      // Relevant if using WordPress
      if (!platform) return true; // Default to relevant
      return hasValue(platform, 'website_platform', 'wordpress') ||
             hasValue(platform, 'website_platform', 'not_sure') ||
             !platform['website_platform'];
    },
    isProvided: (answersByStep) => {
      const access = answersByStep['website_access'];
      return hasGrantedValue(access, 'wordpress_access_granted') ||
             hasValue(access, 'wordpress_access_granted', 'not_wordpress');
    },
  },
  domain: {
    isRelevant: (answersByStep) => {
      const domain = answersByStep['domain_website'];
      // Relevant if they own their domain
      if (!domain) return true;
      return hasValue(domain, 'owns_domain', 'yes') ||
             hasValue(domain, 'owns_domain', 'not_sure') ||
             !domain['owns_domain'];
    },
    isProvided: (answersByStep) => {
      const access = answersByStep['website_access'];
      return hasGrantedValue(access, 'domain_registrar_access') ||
             hasValue(access, 'domain_registrar_access', 'will_share_login');
    },
  },
  dns: {
    isRelevant: (answersByStep) => {
      const domain = answersByStep['domain_website'];
      // Relevant if they control DNS
      if (!domain) return true;
      return hasValue(domain, 'controls_dns', 'yes') ||
             hasValue(domain, 'controls_dns', 'not_sure') ||
             !domain['controls_dns'];
    },
    isProvided: (answersByStep) => {
      const access = answersByStep['website_access'];
      return hasGrantedValue(access, 'dns_access_granted') ||
             hasValue(access, 'dns_access_granted', 'same_as_domain');
    },
  },
  gsc: {
    isRelevant: () => true, // Always relevant
    isProvided: (answersByStep) => {
      const access = answersByStep['google_access'];
      return hasGrantedValue(access, 'gsc_access_granted') ||
             hasValue(access, 'gsc_access_granted', 'not_setup');
    },
  },
  ga: {
    isRelevant: (answersByStep) => {
      const access = answersByStep['google_access'];
      // Only relevant if they have GA set up
      return hasValue(access, 'has_google_analytics', 'yes') ||
             hasValue(access, 'has_google_analytics', 'not_sure') ||
             !access || !access['has_google_analytics'];
    },
    isProvided: (answersByStep) => {
      const access = answersByStep['google_access'];
      return hasGrantedValue(access, 'ga_access_granted') ||
             hasValue(access, 'has_google_analytics', 'no');
    },
  },
  gbp: {
    isRelevant: (answersByStep) => {
      const gbp = answersByStep['google_business'];
      // Relevant if they have a GBP
      if (!gbp) return true;
      return hasValue(gbp, 'has_gbp', 'yes') ||
             hasValue(gbp, 'has_gbp', 'not_sure') ||
             !gbp['has_gbp'];
    },
    isProvided: (answersByStep) => {
      const access = answersByStep['google_access'];
      return hasGrantedValue(access, 'gbp_access_granted') ||
             hasValue(access, 'gbp_access_granted', 'no_gbp');
    },
  },
  youtube: {
    isRelevant: (answersByStep) => {
      const access = answersByStep['other_access'];
      // Only relevant if they have YouTube
      return hasValue(access, 'has_youtube', 'yes');
    },
    isProvided: (answersByStep) => {
      const access = answersByStep['other_access'];
      return hasGrantedValue(access, 'youtube_access_granted') ||
             hasValue(access, 'has_youtube', 'no');
    },
  },
  lsa: {
    isRelevant: (answersByStep) => {
      const access = answersByStep['other_access'];
      // Relevant if they have LSA
      return hasValue(access, 'has_lsa', 'yes');
    },
    isProvided: (answersByStep) => {
      const access = answersByStep['other_access'];
      return hasAnyString(access, ['lsa_customer_ids']) ||
             hasValue(access, 'has_lsa', 'no');
    },
  },
};

// =============================================
// MAIN COMPUTATION FUNCTION
// =============================================

export function computeAccessChecklist(answersByStep: AnswersByStep): AccessChecklist {
  const items: AccessItemStatus[] = ACCESS_ITEMS.map(item => {
    const checker = accessCheckers[item.key];
    const relevant = checker.isRelevant(answersByStep);
    const provided = relevant ? checker.isProvided(answersByStep) : false;

    return {
      ...item,
      relevant,
      provided,
    };
  });

  const relevantItems = items.filter(item => item.relevant);
  const missingItems = relevantItems.filter(item => !item.provided);
  const presentItems = relevantItems.filter(item => item.provided);
  const notApplicableItems = items.filter(item => !item.relevant);

  const checklistBase = {
    items,
    missingCount: missingItems.length,
    presentCount: presentItems.length,
    notApplicableCount: notApplicableItems.length,
    missingKeys: missingItems.map(item => item.key),
    presentKeys: presentItems.map(item => item.key),
  };

  return {
    ...checklistBase,
    missingAccessText: generateMissingAccessText(checklistBase),
  };
}

// =============================================
// HELPER: Generate missing access request text
// =============================================

export function generateMissingAccessText(checklist: Omit<AccessChecklist, 'missingAccessText'>): string {
  const missingItems = checklist.items.filter(item => item.relevant && !item.provided);

  if (missingItems.length === 0) {
    return 'All required access has been provided.';
  }

  const itemsList = missingItems.map(item => `• ${item.label}`).join('\n');
  const whatWeNeedList = missingItems.map(item => `• ${item.whatWeNeed}`).join('\n');

  return `To complete the setup, we still need access to:\n\n${itemsList}\n\nSpecifically, please provide:\n\n${whatWeNeedList}`;
}

// Short version for quick copy
export function generateShortMissingAccessText(checklist: AccessChecklist): string {
  const missingItems = checklist.items.filter(item => item.relevant && !item.provided);

  if (missingItems.length === 0) {
    return 'All access provided.';
  }

  const labels = missingItems.map(item => item.label).join(', ');
  return `Missing access: ${labels}`;
}
