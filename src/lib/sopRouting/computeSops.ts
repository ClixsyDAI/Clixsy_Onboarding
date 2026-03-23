// =============================================
// SOP Routing Engine — Manager's Big 5 + Migration
// =============================================

export interface Big5Answers {
  own_domain: 'yes' | 'no' | 'not_sure' | null;
  control_dns: 'yes' | 'no' | 'not_sure' | null;
  is_wordpress: 'yes' | 'no' | 'not_sure' | null;
  own_written_content: 'yes' | 'no' | 'not_sure' | null;
  own_license_images: 'yes' | 'no' | 'not_sure' | null;
}

export interface MigrationAnswers {
  needs_migration: 'yes' | 'no' | 'not_sure' | null;
}

export interface SOPRoutingInput {
  big5: Big5Answers;
  migration: MigrationAnswers;
  detected_cms?: string | null;
}

export interface SOPRoutingResult {
  required_sops: string[];
  explanations: Record<string, string>;
  big5_summary: Record<string, { answer: string | null; triggers_sop: boolean }>;
}

export const ALL_SOPS = {
  REGISTRAR_MIGRATION: 'Registrar Migration SOP',
  DNS_MIGRATION: 'DNS Migration SOP',
  WEBSITE_REBUILD: 'Website Rebuild SOP',
  WRITTEN_CONTENT_REPLACEMENT: 'Written Content Replacement SOP',
  IMAGE_REPLACEMENT: 'Image Replacement SOP',
  DNS_ACCESS: 'DNS Access SOP',
  HOSTING_MIGRATION: 'Hosting Migration SOP',
} as const;

export function computeSops(input: SOPRoutingInput): SOPRoutingResult {
  const required_sops: string[] = [];
  const explanations: Record<string, string> = {};
  const big5_summary: Record<string, { answer: string | null; triggers_sop: boolean }> = {};

  // 1) Own Domain? -> if NO: Registrar Migration SOP
  const ownDomain = input.big5.own_domain;
  const ownDomainTriggers = ownDomain === 'no';
  big5_summary.own_domain = { answer: ownDomain, triggers_sop: ownDomainTriggers };
  if (ownDomainTriggers) {
    required_sops.push(ALL_SOPS.REGISTRAR_MIGRATION);
    explanations[ALL_SOPS.REGISTRAR_MIGRATION] =
      'Client does not own their domain. Registrar migration is needed to transfer domain ownership.';
  }

  // 2) Control DNS? -> if NO: DNS Migration SOP
  const controlDns = input.big5.control_dns;
  const controlDnsTriggers = controlDns === 'no';
  big5_summary.control_dns = { answer: controlDns, triggers_sop: controlDnsTriggers };
  if (controlDnsTriggers) {
    required_sops.push(ALL_SOPS.DNS_MIGRATION);
    explanations[ALL_SOPS.DNS_MIGRATION] =
      'Client does not have DNS access. DNS migration is needed to gain control of DNS settings.';
  }

  // 3) Is Website WordPress? -> if NO: Website Rebuild SOP
  // Can be inferred from tech detection or confirmed by client
  let isWordpress = input.big5.is_wordpress;
  if (isWordpress === null && input.detected_cms) {
    isWordpress = input.detected_cms.toLowerCase().includes('wordpress') ? 'yes' : 'no';
  }
  const isWordpressTriggers = isWordpress === 'no';
  big5_summary.is_wordpress = { answer: isWordpress, triggers_sop: isWordpressTriggers };
  if (isWordpressTriggers) {
    required_sops.push(ALL_SOPS.WEBSITE_REBUILD);
    explanations[ALL_SOPS.WEBSITE_REBUILD] =
      'Website is not built on WordPress. A website rebuild to WordPress is required for our stack.';
  }

  // 4) Own Written Content? -> if NO: Written Content Replacement SOP
  const ownContent = input.big5.own_written_content;
  const ownContentTriggers = ownContent === 'no';
  big5_summary.own_written_content = { answer: ownContent, triggers_sop: ownContentTriggers };
  if (ownContentTriggers) {
    required_sops.push(ALL_SOPS.WRITTEN_CONTENT_REPLACEMENT);
    explanations[ALL_SOPS.WRITTEN_CONTENT_REPLACEMENT] =
      'Client does not own their written content. Content replacement is needed before launch.';
  }

  // 5) Own/License Images? -> if NO: Image Replacement SOP
  const ownImages = input.big5.own_license_images;
  const ownImagesTriggers = ownImages === 'no';
  big5_summary.own_license_images = { answer: ownImages, triggers_sop: ownImagesTriggers };
  if (ownImagesTriggers) {
    required_sops.push(ALL_SOPS.IMAGE_REPLACEMENT);
    explanations[ALL_SOPS.IMAGE_REPLACEMENT] =
      'Client does not own or license their images. Image replacement with properly licensed assets is needed.';
  }

  // 6) Need Website Migration? -> if YES: DNS Access SOP + Hosting Migration SOP
  const needsMigration = input.migration.needs_migration;
  if (needsMigration === 'yes') {
    required_sops.push(ALL_SOPS.DNS_ACCESS);
    explanations[ALL_SOPS.DNS_ACCESS] =
      'Website migration requires DNS access to point the domain to new hosting.';
    required_sops.push(ALL_SOPS.HOSTING_MIGRATION);
    explanations[ALL_SOPS.HOSTING_MIGRATION] =
      'Website migration requires moving the site to our managed hosting infrastructure.';
  }

  return { required_sops, explanations, big5_summary };
}

// =============================================
// Extract Big 5 + migration answers from onboarding answers
// =============================================

export function extractSOPInputFromAnswers(
  answers: Record<string, Record<string, unknown>>,
  detectedCms?: string | null,
): SOPRoutingInput {
  const techSetup = answers['technical_setup'] || {};
  const preContract = answers['pre_contract_readiness'] || {};

  // Map from existing field keys + new Big 5 fields
  const ownDomain = (preContract.owns_domain_confirmed as string) || (techSetup.owns_domain as string) || null;
  const controlDns = (preContract.controls_dns_confirmed as string) || (techSetup.controls_dns as string) || null;

  // WordPress detection: prefer explicit answer, fall back to platform field
  let isWordpress: string | null = (preContract.is_wordpress as string) || null;
  if (!isWordpress) {
    const platform = techSetup.website_platform as string;
    if (platform === 'wordpress') isWordpress = 'yes';
    else if (platform && platform !== 'not_sure') isWordpress = 'no';
  }

  const ownContent = (preContract.own_written_content as string) || null;
  const ownImages = (preContract.own_license_images as string) || null;
  const needsMigration = (preContract.needs_website_migration as string) || null;

  return {
    big5: {
      own_domain: normalizeYesNo(ownDomain),
      control_dns: normalizeYesNo(controlDns),
      is_wordpress: normalizeYesNo(isWordpress),
      own_written_content: normalizeYesNo(ownContent),
      own_license_images: normalizeYesNo(ownImages),
    },
    migration: {
      needs_migration: normalizeYesNo(needsMigration),
    },
    detected_cms: detectedCms || null,
  };
}

function normalizeYesNo(val: string | null | undefined): 'yes' | 'no' | 'not_sure' | null {
  if (!val) return null;
  if (val === 'yes') return 'yes';
  if (val === 'no') return 'no';
  if (val === 'not_sure') return 'not_sure';
  return null;
}
