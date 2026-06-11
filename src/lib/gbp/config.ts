// =============================================================
// GBP API client — configuration + selection (GBP 5b)
// =============================================================
//
// Mirrors the siteIntelligence/config.ts convention: has<X>() for
// presence checks used in selection, get<X>() that throws on a
// missing value at use time.
//
// Mode resolution:
//   GBP_API_MODE=mock  → mock, always (explicit override)
//   GBP_API_MODE=real  → real, always (fails loudly if creds missing)
//   unset              → real when all three OAuth env vars are
//                        present, mock otherwise
//
// The three vars stay unset until the Business Profile API access
// application is approved and a one-time consent as
// tempclixsyreports@gmail.com mints the refresh token. Flipping to
// real = set the env vars + redeploy. No code changes.

import type { GbpClient } from './types';
import { MockGbpClient } from './mock';
import { RealGbpClient } from './real';

export function hasGbpCredentials(): boolean {
  return Boolean(
    process.env.GBP_OAUTH_CLIENT_ID &&
    process.env.GBP_OAUTH_CLIENT_SECRET &&
    process.env.GBP_OAUTH_REFRESH_TOKEN
  );
}

export function getGbpOAuthClientId(): string {
  const v = process.env.GBP_OAUTH_CLIENT_ID;
  if (!v) throw new Error('GBP_OAUTH_CLIENT_ID is not set');
  return v;
}

export function getGbpOAuthClientSecret(): string {
  const v = process.env.GBP_OAUTH_CLIENT_SECRET;
  if (!v) throw new Error('GBP_OAUTH_CLIENT_SECRET is not set');
  return v;
}

export function getGbpOAuthRefreshToken(): string {
  const v = process.env.GBP_OAUTH_REFRESH_TOKEN;
  if (!v) throw new Error('GBP_OAUTH_REFRESH_TOKEN is not set');
  return v;
}

export function getGbpMode(): 'mock' | 'real' {
  const explicit = process.env.GBP_API_MODE;
  if (explicit === 'mock') return 'mock';
  if (explicit === 'real') return 'real';
  return hasGbpCredentials() ? 'real' : 'mock';
}

export function getGbpClient(): GbpClient {
  return getGbpMode() === 'real' ? new RealGbpClient() : new MockGbpClient();
}
