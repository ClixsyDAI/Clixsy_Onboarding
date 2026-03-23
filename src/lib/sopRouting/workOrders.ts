// =============================================
// Post-Submit Work Order Generator
// =============================================

export interface WorkOrderTask {
  key: string;
  title: string;
  owner: string;
  status: 'pending' | 'in_progress' | 'completed';
  category: 'onboarding' | 'sop';
}

// Default internal task chain (from manager's SOP diagram)
const DEFAULT_ONBOARDING_TASKS: Omit<WorkOrderTask, 'status'>[] = [
  { key: 'core_vitals', title: 'Core Vitals', owner: 'Dev Team', category: 'onboarding' },
  { key: 'third_party_js', title: 'Third Party Javascript', owner: 'Dev Team', category: 'onboarding' },
  { key: 'gtm', title: 'Google Tag Manager (GTM)', owner: 'Keith', category: 'onboarding' },
  { key: 'phone_form_audit', title: 'Phone Number and Form Audit', owner: 'Dev Team', category: 'onboarding' },
  { key: 'hosting_stack', title: 'Hosting Stack', owner: 'Predrag', category: 'onboarding' },
  { key: 'wordpress_stack', title: 'WordPress Stack SOP', owner: 'Dev Team', category: 'onboarding' },
  { key: 'system_admin', title: 'System Admin SOP', owner: 'Predrag', category: 'onboarding' },
  { key: 'dev_ops', title: 'Dev Ops SOP', owner: 'Keith and Bogdan', category: 'onboarding' },
];

export function generateWorkOrder(requiredSops: string[]): WorkOrderTask[] {
  const tasks: WorkOrderTask[] = [];

  // Add all default onboarding tasks
  for (const task of DEFAULT_ONBOARDING_TASKS) {
    tasks.push({ ...task, status: 'pending' });
  }

  // Add SOP-triggered tasks
  for (const sop of requiredSops) {
    tasks.push({
      key: sopToKey(sop),
      title: sop,
      owner: getSOPOwner(sop),
      status: 'pending',
      category: 'sop',
    });
  }

  return tasks;
}

function sopToKey(sop: string): string {
  return sop
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function getSOPOwner(sop: string): string {
  const ownerMap: Record<string, string> = {
    'Registrar Migration SOP': 'Dev Team',
    'DNS Migration SOP': 'Dev Team',
    'Website Rebuild SOP': 'Dev Team',
    'Written Content Replacement SOP': 'Content Team',
    'Image Replacement SOP': 'Content Team',
    'DNS Access SOP': 'Dev Team',
    'Hosting Migration SOP': 'Predrag',
  };
  return ownerMap[sop] || 'Unassigned';
}

export function getDefaultOnboardingTasks(): Omit<WorkOrderTask, 'status'>[] {
  return DEFAULT_ONBOARDING_TASKS;
}
