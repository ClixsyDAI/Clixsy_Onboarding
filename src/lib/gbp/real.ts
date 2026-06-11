// =============================================================
// GBP API client — real implementation (GBP 5b)
// =============================================================
//
// Fully implemented and DORMANT: every call returns 403 until
// Google approves the Business Profile API access application
// (enabled APIs sit at quota 0 until then). Flipping this live is
// env-vars-only: set GBP_OAUTH_CLIENT_ID / _CLIENT_SECRET /
// _REFRESH_TOKEN and redeploy — config.ts switches the active
// client to this class automatically.
//
// Token model (Option A — operator-approved): one agency-wide
// refresh token for tempclixsyreports@gmail.com, exchanged for
// short-lived access tokens against oauth2.googleapis.com. Same
// pattern as the dashboard's GSC/GA4 integration
// (_db3-work/dashboard/app/lib/google.ts), including the
// module-level access-token cache.
//
// APIs used:
//   accounts:  mybusinessaccountmanagement.googleapis.com/v1
//   locations: mybusinessbusinessinformation.googleapis.com/v1
// Both enabled on GCP project clixsy-onboarding-gbp (2026-06-10).

import type { GbpAccount, GbpClient, GbpLocation } from './types';
import {
  getGbpOAuthClientId,
  getGbpOAuthClientSecret,
  getGbpOAuthRefreshToken,
} from './config';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCOUNTS_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const LOCATIONS_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const LOCATION_READ_MASK = 'name,title,storefrontAddress,websiteUri,metadata';
const PAGE_SIZE = 100;

// Module-level access-token cache (dashboard google.ts precedent).
// Refresh-token grants return tokens valid ~3600s; refresh 60s early.
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) {
    return cachedAccessToken.token;
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: getGbpOAuthClientId(),
      client_secret: getGbpOAuthClientSecret(),
      refresh_token: getGbpOAuthRefreshToken(),
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GBP token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

async function gbpFetch(url: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    // The expected failure mode pre-approval: 403 with quota of 0.
    // Keep status in the message so the admin panel can explain.
    throw new Error(`GBP API request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
}

interface ApiAccount {
  name?: string;
  accountName?: string;
  type?: string;
}

interface ApiAddress {
  addressLines?: string[];
  locality?: string;
  administrativeArea?: string;
  postalCode?: string;
}

interface ApiLocation {
  name?: string;
  title?: string;
  storefrontAddress?: ApiAddress;
  websiteUri?: string;
  metadata?: { mapsUri?: string };
}

function formatAddress(addr: ApiAddress | undefined): string | null {
  if (!addr) return null;
  const parts = [
    ...(addr.addressLines ?? []),
    [addr.locality, addr.administrativeArea].filter(Boolean).join(', '),
    addr.postalCode,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(', ') : null;
}

export class RealGbpClient implements GbpClient {
  readonly mode = 'real' as const;

  async listAccounts(): Promise<GbpAccount[]> {
    const accounts: GbpAccount[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${ACCOUNTS_BASE}/accounts`);
      url.searchParams.set('pageSize', String(PAGE_SIZE));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = (await gbpFetch(url.toString())) as {
        accounts?: ApiAccount[];
        nextPageToken?: string;
      };
      for (const a of data.accounts ?? []) {
        if (!a.name) continue;
        accounts.push({
          name: a.name,
          accountName: a.accountName ?? a.name,
          type: a.type,
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return accounts;
  }

  async listLocations(accountName: string): Promise<GbpLocation[]> {
    const locations: GbpLocation[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${LOCATIONS_BASE}/${accountName}/locations`);
      url.searchParams.set('readMask', LOCATION_READ_MASK);
      url.searchParams.set('pageSize', String(PAGE_SIZE));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = (await gbpFetch(url.toString())) as {
        locations?: ApiLocation[];
        nextPageToken?: string;
      };
      for (const loc of data.locations ?? []) {
        if (!loc.name) continue;
        locations.push({
          id: loc.name,
          title: loc.title ?? loc.name,
          address: formatAddress(loc.storefrontAddress),
          mapsUri: loc.metadata?.mapsUri ?? null,
          websiteUri: loc.websiteUri ?? null,
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return locations;
  }

  async listAllLocations(): Promise<GbpLocation[]> {
    const accounts = await this.listAccounts();
    const all: GbpLocation[] = [];
    for (const account of accounts) {
      const locations = await this.listLocations(account.name);
      all.push(...locations);
    }
    return all;
  }
}
