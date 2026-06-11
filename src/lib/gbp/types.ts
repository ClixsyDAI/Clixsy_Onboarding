// =============================================================
// GBP API client — shared types (GBP 5b)
// =============================================================
//
// One interface, two implementations:
//   mock.ts — fixture-backed, active until Google approves the
//             Business Profile API access application (quota is 0
//             until then, so real calls 403 regardless of code).
//   real.ts — full HTTP implementation against the Business
//             Profile APIs using the agency-account refresh-token
//             pattern (Option A — mirrors the dashboard's
//             GOOGLE_OAUTH_REFRESH_TOKEN approach for GSC/GA4).
//
// Selection happens in config.ts (presence-based, same has<X>Key
// convention as siteIntelligence/config.ts).

export interface GbpAccount {
  /** API resource name, e.g. "accounts/123456789" */
  name: string;
  /** Human-readable account name */
  accountName: string;
  /** PERSONAL | LOCATION_GROUP | ORGANIZATION | USER_GROUP */
  type?: string;
}

export interface GbpLocation {
  /** API resource name, e.g. "locations/123456789" — stable id */
  id: string;
  /** Business title as shown on the listing */
  title: string;
  /** Single-line formatted storefront address, null for SABs */
  address: string | null;
  /** Google Maps URI for the listing — primary value for gbp_locations rows */
  mapsUri: string | null;
  /** Website URI on the listing, if set */
  websiteUri: string | null;
}

export interface GbpClient {
  readonly mode: 'mock' | 'real';
  listAccounts(): Promise<GbpAccount[]>;
  listLocations(accountName: string): Promise<GbpLocation[]>;
  /** Convenience: all locations across all accessible accounts. */
  listAllLocations(): Promise<GbpLocation[]>;
}
