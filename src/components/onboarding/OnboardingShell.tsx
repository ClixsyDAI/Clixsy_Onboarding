'use client';

import { useCallback, useEffect, useState } from 'react';
import PinEntry from './PinEntry';
import Wizard from './Wizard';

/**
 * Client-side shell for /onboarding/[token]. Handles the three states
 * the server-side guard can return:
 *
 *   1. needsPin       → render <PinEntry />
 *   2. locked         → render the locked screen
 *   3. ok             → render <Wizard /> with the full payload
 *
 * The PIN entry success callback re-fetches the session — the cookie
 * Set on success means the second fetch comes back as 'ok' with the
 * full payload, and the wizard renders without a full page reload.
 *
 * Kept lightweight: just orchestrates fetch + state. PIN UX lives in
 * <PinEntry />, wizard logic in <Wizard />.
 */

// Wizard accepts a richer SiteIntelligenceData shape; we just pass the
// API response straight through without re-typing here.
type SiteIntelligence = Record<string, unknown>;

interface SessionPayload {
  session: {
    id: string;
    status: 'draft' | 'in_progress' | 'submitted';
    currentStep: number;
    flowVersion: 'v1' | 'v2';
    logoUrl: string | null;
    lastSavedAt: string | null;
    submittedAt: string | null;
    pinSet: boolean;
    welcomeWizardSeen: boolean;
    /** Stage 8: rendered on the rebuilt thank-you screen. May be null on legacy rows. */
    accountManager: string | null;
  };
  client: { name: string; contactName: string };
  answers: Record<string, { answers: Record<string, unknown>; completed: boolean }>;
  siteIntelligence: SiteIntelligence | null;
}

interface GateResponse {
  needsPin?: boolean;
  locked?: 'permanent' | 'rate_limited';
  retryAfter?: string | null;
  client?: { name: string };
}

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

export default function OnboardingShell({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<SessionPayload | null>(null);
  const [gate, setGate] = useState<GateResponse | null>(null);
  const [notFound, setNotFound] = useState(false);

  const fetchSession = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/public/onboarding/session?token=${encodeURIComponent(token)}`, {
        cache: 'no-store',
      });
      if (resp.status === 404) {
        setNotFound(true);
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (data.needsPin || data.locked) {
        setGate(data as GateResponse);
        setPayload(null);
      } else {
        setPayload(data as SessionPayload);
        setGate(null);
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchSession();
  }, [fetchSession]);

  if (loading && !payload && !gate) {
    return (
      <div className="min-h-screen bg-[#F4F5F6] flex items-center justify-center">
        <div className="text-[#6B6B6B] text-sm">Loading…</div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-[#F4F5F6] flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-bold text-[#0B0B0B] mb-2">Onboarding link not found</h1>
          <p className="text-sm text-[#6B6B6B]">
            Please double-check the URL or contact your Clixsy account manager.
          </p>
        </div>
      </div>
    );
  }

  if (gate?.locked === 'permanent') {
    return (
      <div className="min-h-screen bg-[#F4F5F6] flex flex-col">
        <header className="bg-[#0F1A14]">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
            <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg">
              Clixsy Onboarding Portal
            </div>
          </div>
        </header>
        <main className="flex-1 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8 border border-[#E6E8EA] text-center">
            <div className="w-12 h-12 mx-auto mb-4 bg-red-50 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-[#E5484D]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 18c-.77 1.333.192 3 1.732 3zM12 9v4" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-[#0B0B0B] mb-2">This link is locked</h1>
            <p className="text-sm text-[#6B6B6B]">
              Too many incorrect PIN attempts. Please contact your Clixsy account manager to reissue access.
            </p>
          </div>
        </main>
      </div>
    );
  }

  if (gate?.needsPin || gate?.locked === 'rate_limited') {
    return (
      <PinEntry
        token={token}
        clientName={gate.client?.name ?? ''}
        initialLock={gate.locked === 'rate_limited' ? { kind: 'rate_limited', retryAfter: gate.retryAfter ?? undefined } : null}
        onSuccess={fetchSession}
      />
    );
  }

  if (payload) {
    return (
      <Wizard
        token={token}
        initialStep={payload.session.currentStep}
        initialAnswers={payload.answers}
        sessionStatus={payload.session.status}
        flowVersion={payload.session.flowVersion}
        clientName={payload.client.name}
        contactName={payload.client.contactName}
        welcomeWizardSeen={payload.session.welcomeWizardSeen}
        accountManager={payload.session.accountManager}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        siteIntelligence={payload.siteIntelligence as any}
      />
    );
  }

  return null;
}
