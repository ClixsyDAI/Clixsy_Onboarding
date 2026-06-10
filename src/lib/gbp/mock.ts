// =============================================================
// GBP API client — mock implementation (GBP 5b)
// =============================================================
//
// Fixtures modeled on the Midwest Express Clinic case: the 50+
// profile urgent-care chain that drove the multi-location
// requirement. SYNTHETIC DATA — names/addresses are shaped like
// the real chain's footprint (Chicagoland + NW Indiana) but the
// ids, CIDs, and street numbers are fabricated. Deterministic on
// purpose: no randomness, stable ids, so UAT steps reproduce.
//
// Deliberate mess in the fixtures (real-world cases the UI must
// survive):
//   - two locations in the same city (Cicero) with different
//     addresses — the "which one is it?" disambiguation case
//   - one location with no website set
//   - one location with no Maps URI (falls back to websiteUri
//     when mapped into gbp_locations rows)
//   - one service-area business with no storefront address
//   - one long compound title

import type { GbpAccount, GbpClient, GbpLocation } from './types';

interface FixtureSeed {
  city: string;
  state: 'IL' | 'IN';
  street: string | null; // null = service-area business
  zip: string;
  noWebsite?: boolean;
  noMapsUri?: boolean;
  titleOverride?: string;
}

const FIXTURE_SEEDS: FixtureSeed[] = [
  { city: 'Archer Heights', state: 'IL', street: '4848 S Pulaski Rd', zip: '60632' },
  { city: 'Aurora', state: 'IL', street: '1280 N Lake St', zip: '60506' },
  { city: 'Belmont Cragin', state: 'IL', street: '5650 W Belmont Ave', zip: '60634' },
  { city: 'Berwyn', state: 'IL', street: '7110 Cermak Rd', zip: '60402' },
  { city: 'Bolingbrook', state: 'IL', street: '346 S Bolingbrook Dr', zip: '60440' },
  { city: 'Bourbonnais', state: 'IL', street: '584 Main St NW', zip: '60914' },
  { city: 'Bridgeport', state: 'IL', street: '3145 S Ashland Ave', zip: '60608' },
  { city: 'Brighton Park', state: 'IL', street: '4101 S Archer Ave', zip: '60632' },
  { city: 'Calumet City', state: 'IL', street: '560 River Oaks Dr', zip: '60409' },
  { city: 'Chicago Heights', state: 'IL', street: '1010 Dixie Hwy', zip: '60411' },
  { city: 'Cicero', state: 'IL', street: '4800 W Cermak Rd', zip: '60804' },
  { city: 'Cicero', state: 'IL', street: '5838 W 35th St Ste 110', zip: '60804' },
  { city: 'Crestwood', state: 'IL', street: '13303 S Cicero Ave', zip: '60445' },
  { city: 'Crown Point', state: 'IN', street: '10769 Broadway', zip: '46307' },
  { city: 'Dyer', state: 'IN', street: '939 Joliet St', zip: '46311' },
  { city: 'East Chicago', state: 'IN', street: '4525 Indianapolis Blvd', zip: '46312', noWebsite: true },
  { city: 'Elgin', state: 'IL', street: '316 S Randall Rd', zip: '60123' },
  { city: 'Evergreen Park', state: 'IL', street: '9510 S Western Ave', zip: '60805' },
  { city: 'Gage Park', state: 'IL', street: '5522 S Kedzie Ave', zip: '60629' },
  { city: 'Griffith', state: 'IN', street: '231 W Ridge Rd', zip: '46319' },
  { city: 'Hammond', state: 'IN', street: '7150 Indianapolis Blvd', zip: '46324' },
  { city: 'Highland', state: 'IN', street: '10343 Indianapolis Blvd', zip: '46322' },
  { city: 'Hobart', state: 'IN', street: '7847 E 37th Ave', zip: '46342', noMapsUri: true },
  { city: 'Humboldt Park', state: 'IL', street: '3501 W North Ave', zip: '60647' },
  { city: 'Joliet', state: 'IL', street: '2380 Essington Rd', zip: '60435' },
  { city: 'Kenosha', state: 'IL', street: '7519 Sheridan Rd', zip: '53143' },
  { city: 'La Porte', state: 'IN', street: '1024 Lincolnway', zip: '46350' },
  { city: 'Lansing', state: 'IL', street: '16650 Torrence Ave', zip: '60438' },
  { city: 'Little Village', state: 'IL', street: '3859 W 26th St', zip: '60623' },
  { city: 'Logan Square', state: 'IL', street: '2620 N Milwaukee Ave', zip: '60647' },
  { city: 'Melrose Park', state: 'IL', street: '1308 W North Ave', zip: '60160' },
  { city: 'Merrillville', state: 'IN', street: '6101 Broadway', zip: '46410' },
  { city: 'Michigan City', state: 'IN', street: '4337 Franklin St', zip: '46360' },
  { city: 'Midlothian', state: 'IL', street: '14651 Cicero Ave', zip: '60445' },
  { city: 'Mokena', state: 'IL', street: '19110 88th Ave', zip: '60448' },
  { city: 'Naperville', state: 'IL', street: '952 W 75th St', zip: '60565' },
  { city: 'New Lenox', state: 'IL', street: '2364 E Lincoln Hwy', zip: '60451' },
  { city: 'Oak Lawn', state: 'IL', street: '4060 W 95th St', zip: '60453' },
  { city: 'Orland Park', state: 'IL', street: '15155 S La Grange Rd', zip: '60462' },
  { city: 'Pilsen', state: 'IL', street: '1800 S Blue Island Ave', zip: '60608' },
  { city: 'Portage', state: 'IN', street: '3171 Willowcreek Rd', zip: '46368' },
  { city: 'Portage Park', state: 'IL', street: '5305 W Irving Park Rd', zip: '60641' },
  { city: 'Rogers Park', state: 'IL', street: '7011 N Clark St', zip: '60626' },
  { city: 'Schererville', state: 'IN', street: '1555 US-41', zip: '46375' },
  { city: 'Skokie', state: 'IL', street: '9300 Skokie Blvd', zip: '60077' },
  { city: 'South Loop', state: 'IL', street: '1242 S Canal St', zip: '60607' },
  {
    city: 'St. John', state: 'IN', street: '9201 Wicker Ave', zip: '46373',
    titleOverride: 'Midwest Express Clinic - Urgent Care, Walk-In Clinic, COVID Testing & X-Ray - St. John, IN',
  },
  { city: 'Valparaiso', state: 'IN', street: '1502 Calumet Ave', zip: '46383' },
  { city: 'West Loop', state: 'IL', street: '1100 W Madison St', zip: '60607' },
  { city: 'Westmont', state: 'IL', street: '155 W 63rd St', zip: '60559' },
  { city: 'Wicker Park', state: 'IL', street: '1532 N Milwaukee Ave', zip: '60622' },
  // Service-area entry — mobile testing unit, no storefront.
  { city: 'Chicagoland (Mobile Unit)', state: 'IL', street: null, zip: '60601' },
];

const MOCK_ACCOUNT: GbpAccount = {
  name: 'accounts/000000000000000000001',
  accountName: 'Clixsy Reports (mock)',
  type: 'LOCATION_GROUP',
};

function citySlug(city: string): string {
  return city.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function buildFixtures(): GbpLocation[] {
  return FIXTURE_SEEDS.map((seed, i) => {
    const n = i + 1;
    const id = `locations/90000000000${String(n).padStart(3, '0')}`;
    const cid = `1100220033004400${String(n).padStart(4, '0')}`;
    return {
      id,
      title: seed.titleOverride ?? `Midwest Express Clinic - ${seed.city}, ${seed.state}`,
      address: seed.street ? `${seed.street}, ${seed.city}, ${seed.state} ${seed.zip}` : null,
      mapsUri: seed.noMapsUri ? null : `https://maps.google.com/?cid=${cid}`,
      websiteUri: seed.noWebsite
        ? null
        : `https://midwestexpressclinic.com/locations/${citySlug(seed.city)}/`,
    };
  });
}

export class MockGbpClient implements GbpClient {
  readonly mode = 'mock' as const;

  async listAccounts(): Promise<GbpAccount[]> {
    return [MOCK_ACCOUNT];
  }

  async listLocations(accountName: string): Promise<GbpLocation[]> {
    if (accountName !== MOCK_ACCOUNT.name) return [];
    return buildFixtures();
  }

  async listAllLocations(): Promise<GbpLocation[]> {
    return buildFixtures();
  }
}
