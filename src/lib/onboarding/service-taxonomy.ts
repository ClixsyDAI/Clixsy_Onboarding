// =============================================================
// Home-services taxonomy
// =============================================================
//
// Canonical list of trades a Home Services client offers and the
// specific service categories under each. Used by Step 7 of the
// onboarding form to branch the vertical-appropriate options into
// place (see steps-v2.ts: service_trades, service_categories) and
// by the scraper-driven pre-fill (field-mapping.ts) to map
// extracted service names to these IDs.
//
// IDs are stable strings (`<trade>.<service>`). They live in the
// onboarding_answers JSONB under seo_targeting and are never
// rewritten — adding a new service must use a new id, not reorder
// or rename an existing one, so historical data stays interpretable.
//
// Two helpers below cover the operations every consumer needs:
// looking up the services for a given trade, looking up the trade
// for a given service, and merging selected-trade / selected-service
// state into a single "expanded view" structure for rendering.

export const HOME_SERVICES_TAXONOMY = {
  hvac: {
    label: 'HVAC',
    services: [
      { id: 'hvac.ac_repair', label: 'A/C repair' },
      { id: 'hvac.ac_install', label: 'A/C installation' },
      { id: 'hvac.ac_maintenance', label: 'A/C maintenance' },
      { id: 'hvac.furnace_repair', label: 'Furnace repair' },
      { id: 'hvac.furnace_install', label: 'Furnace installation' },
      { id: 'hvac.furnace_maintenance', label: 'Furnace maintenance' },
      { id: 'hvac.heat_pump', label: 'Heat pump service' },
      { id: 'hvac.mini_split', label: 'Ductless mini-split' },
      { id: 'hvac.thermostat', label: 'Thermostat installation' },
      { id: 'hvac.iaq', label: 'Indoor air quality / air purification' },
    ],
  },
  plumbing: {
    label: 'Plumbing',
    services: [
      { id: 'plumbing.repair', label: 'Plumbing repair' },
      { id: 'plumbing.install', label: 'Plumbing installation' },
      { id: 'plumbing.drain_cleaning', label: 'Drain cleaning' },
      { id: 'plumbing.sewer_repair', label: 'Sewer line repair' },
      { id: 'plumbing.hydro_jetting', label: 'Hydro jetting' },
      { id: 'plumbing.water_heater_repair', label: 'Water heater repair' },
      { id: 'plumbing.water_heater_install', label: 'Water heater installation' },
      { id: 'plumbing.tankless', label: 'Tankless water heater' },
      { id: 'plumbing.emergency', label: 'Emergency plumbing' },
      { id: 'plumbing.fixtures', label: 'Fixtures and faucets' },
    ],
  },
  electrical: {
    label: 'Electrical',
    services: [
      { id: 'electrical.repair', label: 'Electrical repair' },
      { id: 'electrical.install', label: 'Electrical installation' },
      { id: 'electrical.panel_upgrade', label: 'Panel upgrade' },
      { id: 'electrical.ev_charger', label: 'EV charger installation' },
      { id: 'electrical.lighting', label: 'Lighting installation' },
      { id: 'electrical.generator', label: 'Whole-home generator' },
      { id: 'electrical.wiring', label: 'Wiring and rewiring' },
      { id: 'electrical.emergency', label: 'Emergency electrical' },
    ],
  },
  pest_control: {
    label: 'Pest Control',
    services: [
      { id: 'pest.general', label: 'General pest control' },
      { id: 'pest.termite', label: 'Termite control' },
      { id: 'pest.rodent', label: 'Rodent control' },
      { id: 'pest.commercial', label: 'Commercial pest control' },
    ],
  },
  roofing: {
    label: 'Roofing',
    services: [
      { id: 'roofing.repair', label: 'Roof repair' },
      { id: 'roofing.replacement', label: 'Roof replacement' },
      { id: 'roofing.inspection', label: 'Roof inspection' },
      { id: 'roofing.siding', label: 'Siding' },
      { id: 'roofing.commercial', label: 'Commercial roofing' },
    ],
  },
  garage_door: {
    label: 'Garage Doors',
    services: [
      { id: 'garage.repair', label: 'Garage door repair' },
      { id: 'garage.install', label: 'Garage door installation' },
      { id: 'garage.opener', label: 'Garage door opener' },
      { id: 'garage.spring', label: 'Spring repair' },
      { id: 'garage.commercial', label: 'Commercial garage doors' },
    ],
  },
} as const;

export type TradeId = keyof typeof HOME_SERVICES_TAXONOMY;
export type ServiceId = string;

export interface TaxonomyService {
  id: ServiceId;
  label: string;
}

export interface TaxonomyTrade {
  id: TradeId;
  label: string;
  services: readonly TaxonomyService[];
}

/** Stable ordered list of all trade IDs. */
export const ALL_TRADE_IDS = Object.keys(HOME_SERVICES_TAXONOMY) as TradeId[];

/** Stable ordered list of all service IDs across all trades. */
export const ALL_SERVICE_IDS: readonly ServiceId[] = ALL_TRADE_IDS.flatMap(
  (t) => HOME_SERVICES_TAXONOMY[t].services.map((s) => s.id)
);

/**
 * Return the services declared under a given trade. Returns an empty
 * array for an unknown trade ID rather than throwing — callers iterate
 * over user-supplied selections and don't want a single bad ID to break
 * rendering.
 */
export function getServicesForTrade(tradeId: string): readonly TaxonomyService[] {
  if (!isTradeId(tradeId)) return [];
  return HOME_SERVICES_TAXONOMY[tradeId].services;
}

/**
 * Reverse lookup: which trade does a given service ID belong to?
 * The ID prefix is a SHORT NICKNAME (`garage.*` for `garage_door`,
 * `pest.*` for `pest_control`) so we can't just split-and-lookup —
 * we scan the taxonomy directly. 60 services total, plenty fast.
 */
export function getTradeForService(serviceId: string): TradeId | null {
  if (!serviceId) return null;
  for (const tradeId of ALL_TRADE_IDS) {
    if (HOME_SERVICES_TAXONOMY[tradeId].services.some((s) => s.id === serviceId)) {
      return tradeId;
    }
  }
  return null;
}

/**
 * Strip service IDs whose parent trade isn't currently selected.
 * Used on every state-merge after the trade list changes so the
 * service_categories field never holds orphans when a trade gets
 * unticked. Pure: caller is responsible for writing the result back.
 */
export function pruneOrphanServices(
  selectedTradeIds: readonly string[],
  selectedServiceIds: readonly string[]
): string[] {
  const tradeSet = new Set(selectedTradeIds);
  return selectedServiceIds.filter((sid) => {
    const trade = getTradeForService(sid);
    return trade !== null && tradeSet.has(trade);
  });
}

/**
 * Build a render-ready view: for each currently-selected trade,
 * return its label + the full list of available services + the subset
 * the user has actually ticked. Skips unknown trade IDs. Stable order
 * (matches HOME_SERVICES_TAXONOMY declaration order).
 */
export interface ExpandedTradeView {
  tradeId: TradeId;
  tradeLabel: string;
  services: readonly TaxonomyService[];
  selectedServiceIds: string[];
}

export function getAllTradesWithSelections(
  selectedTradeIds: readonly string[],
  selectedServiceIds: readonly string[]
): ExpandedTradeView[] {
  const selectedTradeSet = new Set(selectedTradeIds);
  return ALL_TRADE_IDS.filter((id) => selectedTradeSet.has(id)).map((id) => {
    const def = HOME_SERVICES_TAXONOMY[id];
    return {
      tradeId: id,
      tradeLabel: def.label,
      services: def.services,
      selectedServiceIds: selectedServiceIds.filter((sid) => getTradeForService(sid) === id),
    };
  });
}

/**
 * Map a free-text service label (e.g. "A/C Repair", "Furnace Install")
 * onto a single taxonomy service ID, if a confident match exists.
 * Used by the scraper-driven pre-fill: insights.primary_services is a
 * list of arbitrary strings the LLM pulled from the site; we want to
 * convert those to canonical taxonomy IDs before they go in the
 * prefill_map. Returns null when no confident match.
 *
 * Matching strategy:
 *   1. Case-insensitive exact label match (e.g. "A/C repair").
 *   2. Strip punctuation + lowercase; substring containment in either
 *      direction. "A/C Repair" matches "ac repair"; "Mini-Split Service"
 *      matches "Ductless mini-split" (substring "mini-split").
 * Stops at the first match.
 */
export function matchScrapedServiceToTaxonomy(scraped: string): ServiceId | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(scraped);
  if (target.length < 3) return null;

  // Pass 1: exact label match
  for (const tradeId of ALL_TRADE_IDS) {
    for (const svc of HOME_SERVICES_TAXONOMY[tradeId].services) {
      if (norm(svc.label) === target) return svc.id;
    }
  }
  // Pass 2: substring containment (one fully contains the other)
  let best: { id: ServiceId; overlap: number } | null = null;
  for (const tradeId of ALL_TRADE_IDS) {
    for (const svc of HOME_SERVICES_TAXONOMY[tradeId].services) {
      const candidate = norm(svc.label);
      if (candidate.includes(target) || target.includes(candidate)) {
        const overlap = Math.min(candidate.length, target.length);
        if (!best || overlap > best.overlap) best = { id: svc.id, overlap };
      }
    }
  }
  if (best) return best.id;

  // Pass 3: shared substring of length ≥ 6 (catches "Mini-Split Service"
  // ↔ "Ductless mini-split" where neither fully contains the other but
  // they share the meaningful "minisplit" token). Threshold of 6 chars
  // keeps junk like "service" or "repair" from matching the wrong row.
  const MIN_SHARED = 6;
  for (const tradeId of ALL_TRADE_IDS) {
    for (const svc of HOME_SERVICES_TAXONOMY[tradeId].services) {
      const candidate = norm(svc.label);
      const shared = longestCommonSubstring(target, candidate);
      if (shared.length >= MIN_SHARED) {
        if (!best || shared.length > best.overlap) {
          best = { id: svc.id, overlap: shared.length };
        }
      }
    }
  }
  return best?.id ?? null;
}

/** Naive O(n*m) longest common substring. Inputs are short (< 50 chars). */
function longestCommonSubstring(a: string, b: string): string {
  if (!a || !b) return '';
  let longest = '';
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (
        i + k < a.length &&
        j + k < b.length &&
        a[i + k] === b[j + k]
      ) {
        k++;
      }
      if (k > longest.length) longest = a.slice(i, i + k);
    }
  }
  return longest;
}

function isTradeId(s: string): s is TradeId {
  return Object.prototype.hasOwnProperty.call(HOME_SERVICES_TAXONOMY, s);
}
