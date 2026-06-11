'use client';

import { useEffect, useState, use, useMemo, useRef } from 'react';
import Link from 'next/link';
import { getStepsForVersion } from '@/lib/onboarding/flow-version';
// Phase 6 PR A: Server Actions replace the direct fetch() calls
// the regenerate-pin and unlock buttons used to make. The route
// handlers are now bearer-gated; Server Actions bypass the gate
// since they run in-process. See lib/onboarding/admin-actions.ts.
import {
  regeneratePinAction,
  unlockSessionAction,
  getAmBypassLinkAction,
} from '@/lib/onboarding/admin-actions';
import GbpLocationsPanel from '@/components/admin/GbpLocationsPanel';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

interface ClientInfo {
  client_name: string;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
}

interface SessionDetail {
  id: string;
  token: string;
  status: 'draft' | 'in_progress' | 'submitted';
  flow_version?: 'v1' | 'v2';
  current_step: number;
  last_saved_at: string | null;
  submitted_at: string | null;
  created_at: string;
  logo_url: string | null;
  clients: ClientInfo | null;
  // P1 fields (read-only on this screen)
  account_manager: string | null;
  vertical: 'law_firm' | 'home_services' | null;
  // P2 PIN state (pin_hash itself is never returned to the client)
  pin_set: boolean;
  pin_attempts: number;
  pin_lockout_until: string | null;
  pin_locked_at: string | null;
}

interface Answer {
  step_key: string;
  answers: Record<string, unknown>;
  completed: boolean;
  updated_at: string;
}

interface AccessChecklistItem {
  key: string;
  label: string;
  shortLabel: string;
  description: string;
  whatWeNeed: string;
  provided: boolean;
  relevant: boolean;
}

interface AccessChecklist {
  items: AccessChecklistItem[];
  missingCount: number;
  presentCount: number;
  notApplicableCount: number;
  missingKeys: string[];
  presentKeys: string[];
  missingAccessText: string;
}

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [accessChecklist, setAccessChecklist] = useState<AccessChecklist | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [copiedJSON, setCopiedJSON] = useState(false);
  const [copiedMissingAccess, setCopiedMissingAccess] = useState(false);
  // GBP 5b: bumped by GbpLocationsPanel after a successful apply so
  // the answers/checklist refetch and the new gbp_locations rows show
  // up in the step sections below without a manual reload.
  const [refreshKey, setRefreshKey] = useState(0);
  // Distinguishes the initial load from refreshKey-triggered refetches:
  // the expand-all-completed seeding and the full-page error swap only
  // apply on first load. A refetch must neither wipe the admin's manual
  // expand/collapse state nor replace an already-rendered page with the
  // error screen when a transient refetch fails (the panel would unmount
  // and the error state would be unrecoverable without a reload).
  // Keyed by session id so client-side navigation to a different
  // session gets first-load behavior again.
  const initialLoadDoneForRef = useRef<string | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // PIN management state — set after a successful regenerate so the
  // new plaintext PIN can be displayed once. Cleared when the admin
  // dismisses the panel.
  const [pinActionLoading, setPinActionLoading] = useState<
    'regenerate' | 'unlock' | null
  >(null);
  const [pinActionError, setPinActionError] = useState<string | null>(null);
  const [revealedPin, setRevealedPin] = useState<string | null>(null);
  const [copiedPin, setCopiedPin] = useState(false);

  const handleRegeneratePin = async () => {
    if (
      !confirm(
        'Rotate this session’s PIN? The old PIN will stop working immediately. The new PIN will be shown once — you’ll need to copy it and send it to the client.',
      )
    ) {
      return;
    }
    setPinActionLoading('regenerate');
    setPinActionError(null);
    setRevealedPin(null);
    try {
      const result = await regeneratePinAction(id);
      if (!result.ok) {
        throw new Error(result.error);
      }
      setRevealedPin(result.pin);
      // Optimistic local update — lockout state cleared, hash now set.
      if (session) {
        setSession({
          ...session,
          pin_set: true,
          pin_attempts: 0,
          pin_lockout_until: null,
          pin_locked_at: null,
        });
      }
    } catch (err) {
      setPinActionError(
        err instanceof Error ? err.message : 'Failed to regenerate PIN',
      );
    } finally {
      setPinActionLoading(null);
    }
  };

  const handleUnlockSession = async () => {
    if (
      !confirm(
        'Unlock this session? Clears failed-attempt counters and lockouts. The existing PIN remains valid — the client can try again immediately.',
      )
    ) {
      return;
    }
    setPinActionLoading('unlock');
    setPinActionError(null);
    try {
      const result = await unlockSessionAction(id);
      if (!result.ok) {
        throw new Error(result.error);
      }
      if (session) {
        setSession({
          ...session,
          pin_attempts: 0,
          pin_lockout_until: null,
          pin_locked_at: null,
        });
      }
    } catch (err) {
      setPinActionError(
        err instanceof Error ? err.message : 'Failed to unlock session',
      );
    } finally {
      setPinActionLoading(null);
    }
  };

  const handleCopyRevealedPin = async () => {
    if (!revealedPin) return;
    try {
      await navigator.clipboard.writeText(revealedPin);
      setCopiedPin(true);
      setTimeout(() => setCopiedPin(false), 1500);
    } catch {
      // Silent — value is also selectable.
    }
  };

  // Sprint 2 / #4: AM-bypass link. Signature is minted server-side via
  // Server Action; the assembled link opens the form with PIN skipped
  // and zero audit/tracking — for AMs filling the form on the client's
  // behalf. Form writes through that link save as real data.
  const [copiedAmLink, setCopiedAmLink] = useState(false);
  const [amLinkError, setAmLinkError] = useState<string | null>(null);

  const handleCopyAmLink = async () => {
    setAmLinkError(null);
    try {
      const result = await getAmBypassLinkAction(id);
      if (!result.ok) throw new Error(result.error);
      const url = `${window.location.origin}/onboarding/${result.token}?am=${encodeURIComponent(result.sig)}`;
      await navigator.clipboard.writeText(url);
      setCopiedAmLink(true);
      setTimeout(() => setCopiedAmLink(false), 1500);
    } catch (err) {
      setAmLinkError(err instanceof Error ? err.message : 'Failed to mint AM link');
    }
  };

  useEffect(() => {
    async function fetchSessionDetail() {
      try {
        const response = await fetch(`/api/admin/onboarding/sessions/${id}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch session details');
        }

        setSession(data.session);
        setAnswers(data.answers || []);
        setAccessChecklist(data.accessChecklist || null);

        // Auto-expand all sections that have answers — first load only,
        // so a post-apply refetch keeps the admin's expand/collapse state.
        if (initialLoadDoneForRef.current !== id) {
          const completedSteps = new Set<string>();
          (data.answers || []).forEach((a: Answer) => {
            if (a.completed) completedSteps.add(a.step_key);
          });
          setExpandedSteps(completedSteps);
        }
        initialLoadDoneForRef.current = id;
      } catch (err) {
        if (initialLoadDoneForRef.current === id) {
          // Refetch failure on an already-rendered page: keep the page
          // (the apply itself succeeded; data is saved server-side).
          console.error('Session refetch failed:', err);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to fetch session details');
        }
      } finally {
        setIsLoading(false);
      }
    }

    fetchSessionDetail();
  }, [id, refreshKey]);

  // Get version-aware steps
  const flowVersion = session?.flow_version || 'v1';
  const onboardingSteps = useMemo(() => getStepsForVersion(flowVersion), [flowVersion]);

  // Calculate progress stats
  const progressStats = useMemo(() => {
    const completedSteps = answers.filter(a => a.completed).length;
    const totalSteps = onboardingSteps.length;
    const progressPercent = Math.round((completedSteps / totalSteps) * 100);
    return { completedSteps, totalSteps, progressPercent };
  }, [answers, onboardingSteps]);

  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) {
      // GBP 5b: row-object arrays (e.g. gbp_locations: [{url}]) would
      // join to "[object Object]" — surface the url (or JSON) instead.
      return value
        .map((v) =>
          v && typeof v === 'object'
            ? ((v as { url?: string }).url ?? JSON.stringify(v))
            : String(v),
        )
        .join(', ') || '-';
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value) || '-';
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'draft':
        return <span className="px-3 py-1 text-xs font-semibold bg-[#F4F5F6] text-[#6B6B6B] rounded-full">Draft</span>;
      case 'in_progress':
        return <span className="px-3 py-1 text-xs font-semibold bg-[#F5A524]/10 text-[#F5A524] rounded-full">In Progress</span>;
      case 'submitted':
        return <span className="px-3 py-1 text-xs font-semibold bg-[#25DC7F]/10 text-[#25DC7F] rounded-full">Submitted</span>;
      default:
        return null;
    }
  };

  const getProgressColor = (percent: number) => {
    if (percent === 100) return 'bg-[#25DC7F]';
    if (percent >= 75) return 'bg-[#569077]';
    if (percent >= 50) return 'bg-[#F5A524]';
    if (percent >= 25) return 'bg-[#F5A524]';
    return 'bg-[#A0A0A0]';
  };

  const scrollToSection = (stepKey: string) => {
    const ref = sectionRefs.current[stepKey];
    if (ref) {
      ref.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setExpandedSteps(prev => new Set([...prev, stepKey]));
    }
  };

  const toggleStep = (stepKey: string) => {
    setExpandedSteps(prev => {
      const newSet = new Set(prev);
      if (newSet.has(stepKey)) {
        newSet.delete(stepKey);
      } else {
        newSet.add(stepKey);
      }
      return newSet;
    });
  };

  // Generate text summary for copy
  const generateTextSummary = () => {
    if (!session) return '';

    let summary = `ONBOARDING SUMMARY\n`;
    summary += `${'='.repeat(50)}\n\n`;
    summary += `Client: ${session.clients?.client_name || 'Unknown'}\n`;
    summary += `Contact: ${session.clients?.primary_contact_name || '-'} (${session.clients?.primary_contact_email || '-'})\n`;
    summary += `Status: ${session.status.replace('_', ' ').toUpperCase()}\n`;
    summary += `Progress: ${progressStats.completedSteps}/${progressStats.totalSteps} steps (${progressStats.progressPercent}%)\n`;
    summary += `Created: ${formatDate(session.created_at)}\n`;
    if (session.submitted_at) {
      summary += `Submitted: ${formatDate(session.submitted_at)}\n`;
    }
    summary += `\n${'='.repeat(50)}\n\n`;
    summary += `RESPONSES\n\n`;

    onboardingSteps.forEach((step, index) => {
      const answer = answers.find(a => a.step_key === step.key);
      summary += `${index + 1}. ${step.title}\n`;
      summary += `${'-'.repeat(40)}\n`;

      if (answer && answer.completed) {
        Object.entries(answer.answers).forEach(([key, value]) => {
          const field = step.fields.find(f => f.name === key);
          const label = field?.label || key;
          summary += `  ${label}: ${formatValue(value)}\n`;
        });
      } else {
        summary += `  (Not completed)\n`;
      }
      summary += '\n';
    });

    return summary;
  };

  // Generate JSON export
  const generateJSONExport = () => {
    if (!session) return '';

    const exportData = {
      session: {
        id: session.id,
        status: session.status,
        client_name: session.clients?.client_name,
        contact_name: session.clients?.primary_contact_name,
        contact_email: session.clients?.primary_contact_email,
        created_at: session.created_at,
        submitted_at: session.submitted_at,
        progress: {
          completed_steps: progressStats.completedSteps,
          total_steps: progressStats.totalSteps,
          percent: progressStats.progressPercent,
        },
      },
      answers: answers.reduce((acc, answer) => {
        acc[answer.step_key] = {
          completed: answer.completed,
          updated_at: answer.updated_at,
          data: answer.answers,
        };
        return acc;
      }, {} as Record<string, unknown>),
    };

    return JSON.stringify(exportData, null, 2);
  };

  const handleCopySummary = async () => {
    const summary = generateTextSummary();
    await navigator.clipboard.writeText(summary);
    setCopiedSummary(true);
    setTimeout(() => setCopiedSummary(false), 2000);
  };

  const handleExportJSON = () => {
    const json = generateJSONExport();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `onboarding-${session?.clients?.client_name?.replace(/\s+/g, '-').toLowerCase() || session?.id}-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setCopiedJSON(true);
    setTimeout(() => setCopiedJSON(false), 2000);
  };

  const handleCopyMissingAccess = async () => {
    if (!accessChecklist?.missingAccessText) return;
    await navigator.clipboard.writeText(accessChecklist.missingAccessText);
    setCopiedMissingAccess(true);
    setTimeout(() => setCopiedMissingAccess(false), 2000);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F4F5F6]">
        <header className="bg-[#0F1A14]">
          <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
            <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
            <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg">
              Clixsy Onboarding Portal
            </div>
          </div>
        </header>
        <div className="max-w-5xl mx-auto p-8">
          <div className="animate-pulse space-y-4">
            <div className="h-8 w-64 bg-white rounded" />
            <div className="h-64 bg-white rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="min-h-screen bg-[#F4F5F6]">
        <header className="bg-[#0F1A14]">
          <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/">
              <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
            </Link>
            <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg">
              Clixsy Onboarding Portal
            </div>
          </div>
        </header>
        <div className="max-w-5xl mx-auto p-8">
          <div className="bg-white rounded-xl shadow-sm border border-[#E6E8EA] p-8 text-center">
            <h1 className="text-xl font-bold text-[#0B0B0B] mb-4">
              Session Not Found
            </h1>
            <p className="text-[#6B6B6B] mb-6">
              {error || 'The requested session could not be found.'}
            </p>
            <Link
              href="/admin/onboarding/sessions"
              className="inline-block px-6 py-3 bg-[#25DC7F] text-white rounded-lg font-semibold hover:bg-[#1DB96A] transition-colors"
            >
              Back to Sessions
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F5F6]">
      {/* Header */}
      <header className="bg-[#0F1A14]">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
          </Link>
          <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg">
            Clixsy Onboarding Portal
          </div>
        </div>
      </header>

      {/* Sticky Sub-Header */}
      <div className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm shadow-sm border-b border-[#E6E8EA]">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link
                href="/admin/onboarding/sessions"
                className="p-2 hover:bg-[#F4F5F6] rounded-lg transition-colors"
                title="Back to Sessions"
              >
                <svg className="w-5 h-5 text-[#6B6B6B]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </Link>
              <div>
                <h1 className="text-xl font-bold text-[#0B0B0B]">
                  {session.clients?.client_name || 'Session Details'}
                </h1>
                <div className="flex items-center gap-3 mt-1">
                  {getStatusBadge(session.status)}
                  {session.submitted_at && (
                    <span className="text-sm text-[#6B6B6B]">
                      Submitted {formatDate(session.submitted_at)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Progress Summary & Export */}
            <div className="flex items-center gap-4">
              <div className="text-right hidden sm:block">
                <div className="flex items-center gap-2">
                  <div className="w-24 h-2 bg-[#E6E8EA] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${getProgressColor(progressStats.progressPercent)}`}
                      style={{ width: `${progressStats.progressPercent}%` }}
                    />
                  </div>
                  <span className="text-sm font-semibold text-[#0B0B0B]">
                    {progressStats.completedSteps}/{progressStats.totalSteps}
                  </span>
                </div>
                <span className="text-xs text-[#6B6B6B]">
                  {progressStats.progressPercent}% complete
                </span>
              </div>

              {/* Export Buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopySummary}
                  className="px-3 py-2 text-sm font-medium text-[#6B6B6B] hover:bg-[#F4F5F6] rounded-lg transition-colors flex items-center gap-1.5"
                  title="Copy text summary to clipboard"
                >
                  {copiedSummary ? (
                    <>
                      <svg className="w-4 h-4 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy Summary
                    </>
                  )}
                </button>
                <button
                  onClick={handleExportJSON}
                  className="px-3 py-2 text-sm font-medium text-[#6B6B6B] hover:bg-[#F4F5F6] rounded-lg transition-colors flex items-center gap-1.5"
                  title="Download as JSON file"
                >
                  {copiedJSON ? (
                    <>
                      <svg className="w-4 h-4 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Downloaded!
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Export JSON
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Session Info Card */}
        <div className="bg-white rounded-xl shadow-sm border border-[#E6E8EA] p-6 mb-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-[#6B6B6B]">Contact Name</p>
              <p className="font-medium text-[#0B0B0B]">
                {session.clients?.primary_contact_name || '-'}
              </p>
            </div>
            <div>
              <p className="text-sm text-[#6B6B6B]">Contact Email</p>
              <p className="font-medium text-[#0B0B0B]">
                {session.clients?.primary_contact_email || '-'}
              </p>
            </div>
            <div>
              <p className="text-sm text-[#6B6B6B]">Created</p>
              <p className="font-medium text-[#0B0B0B]">
                {formatDate(session.created_at)}
              </p>
            </div>
            <div>
              <p className="text-sm text-[#6B6B6B]">Last Saved</p>
              <p className="font-medium text-[#0B0B0B]">
                {formatDate(session.last_saved_at)}
              </p>
            </div>
          </div>

          {/* Account Manager + Vertical (P1, read-only) */}
          <div className="mt-6 pt-6 border-t border-[#E6E8EA] grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-[#6B6B6B]">Account Manager</p>
              <p className="font-medium text-[#0B0B0B]">
                {session.account_manager || '—'}
              </p>
            </div>
            <div>
              <p className="text-sm text-[#6B6B6B]">Vertical</p>
              <p className="font-medium text-[#0B0B0B]">
                {session.vertical === 'law_firm'
                  ? 'Law Firm'
                  : session.vertical === 'home_services'
                  ? 'Home Services'
                  : '—'}
              </p>
            </div>
          </div>

          <div className="mt-6 pt-6 border-t border-[#E6E8EA]">
            <p className="text-sm text-[#6B6B6B] mb-2">Onboarding Link</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-[#F4F5F6] rounded text-sm text-[#0B0B0B] overflow-x-auto">
                {typeof window !== 'undefined' ? `${window.location.origin}/onboarding/${session.token}` : `/onboarding/${session.token}`}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}/onboarding/${session.token}`);
                }}
                className="px-4 py-2 bg-[#25DC7F] text-white rounded-lg text-sm font-semibold hover:bg-[#1DB96A] transition-colors whitespace-nowrap"
              >
                Copy Link
              </button>
              <button
                onClick={handleCopyAmLink}
                title="Open-as-AM link: skips the PIN, fires no tracking, suppresses the welcome wizard. Form entries save as real client data."
                className="px-4 py-2 border border-[#25DC7F] text-[#25DC7F] rounded-lg text-sm font-semibold hover:bg-[#25DC7F]/10 transition-colors whitespace-nowrap"
              >
                {copiedAmLink ? 'Copied!' : 'Copy AM Link'}
              </button>
            </div>
            {amLinkError && (
              <p className="mt-1 text-sm text-[#E5484D]">{amLinkError}</p>
            )}
            <p className="mt-1 text-xs text-[#6B6B6B]">
              AM Link opens the form without a PIN and with tracking off — for filling
              the form on the client&apos;s behalf. Don&apos;t send it to clients.
            </p>
          </div>

          {/* PIN Access (P2) */}
          <div className="mt-6 pt-6 border-t border-[#E6E8EA]">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-[#0B0B0B]">PIN Access</p>
              {(() => {
                if (!session.pin_set) {
                  return (
                    <span className="text-xs font-medium text-[#6B6B6B] bg-[#F4F5F6] px-2 py-1 rounded">
                      Legacy — no PIN required
                    </span>
                  );
                }
                if (session.pin_locked_at) {
                  return (
                    <span className="text-xs font-medium text-[#E5484D] bg-[#E5484D]/10 px-2 py-1 rounded">
                      Locked — admin action required
                    </span>
                  );
                }
                if (
                  session.pin_lockout_until &&
                  new Date(session.pin_lockout_until).getTime() > Date.now()
                ) {
                  return (
                    <span className="text-xs font-medium text-[#F5A524] bg-[#F5A524]/10 px-2 py-1 rounded">
                      Rate-limited until {formatDate(session.pin_lockout_until)}
                    </span>
                  );
                }
                return (
                  <span className="text-xs font-medium text-[#25DC7F] bg-[#25DC7F]/10 px-2 py-1 rounded">
                    Active
                  </span>
                );
              })()}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-sm">
              <div>
                <p className="text-xs text-[#6B6B6B]">Failed attempts</p>
                <p className="font-medium text-[#0B0B0B]">
                  {session.pin_attempts}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#6B6B6B]">Rate-limit until</p>
                <p className="font-medium text-[#0B0B0B]">
                  {session.pin_lockout_until
                    ? formatDate(session.pin_lockout_until)
                    : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#6B6B6B]">Permanently locked</p>
                <p className="font-medium text-[#0B0B0B]">
                  {session.pin_locked_at ? formatDate(session.pin_locked_at) : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#6B6B6B]">PIN configured</p>
                <p className="font-medium text-[#0B0B0B]">
                  {session.pin_set ? 'Yes' : 'No'}
                </p>
              </div>
            </div>

            {pinActionError && (
              <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-[#E5484D]">
                {pinActionError}
              </div>
            )}

            {revealedPin && (
              <div className="mb-3 p-4 bg-[#FFF8E1] border border-[#F5A524]/30 rounded-lg">
                <p className="text-sm font-semibold text-[#0B0B0B] mb-2">
                  New PIN
                </p>
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    value={revealedPin}
                    readOnly
                    aria-label="New 6-digit PIN"
                    className="flex-1 bg-transparent text-[#0B0B0B] text-2xl font-mono tracking-[0.5em] text-center focus:outline-none"
                  />
                  <button
                    onClick={handleCopyRevealedPin}
                    className="px-4 py-2 bg-[#25DC7F] text-white rounded-lg text-sm font-semibold hover:bg-[#1DB96A] transition-colors"
                  >
                    {copiedPin ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-xs text-[#E5484D]">
                  <strong>This PIN won&apos;t be shown again.</strong> Copy it
                  now and send it to the client.
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleRegeneratePin}
                disabled={pinActionLoading !== null}
                className="px-4 py-2 bg-[#0F1A14] text-white rounded-lg text-sm font-semibold hover:bg-[#1A2A1F] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pinActionLoading === 'regenerate'
                  ? 'Rotating…'
                  : session.pin_set
                  ? 'Regenerate PIN'
                  : 'Set PIN'}
              </button>
              {(session.pin_locked_at ||
                (session.pin_lockout_until &&
                  new Date(session.pin_lockout_until).getTime() > Date.now())) && (
                <button
                  onClick={handleUnlockSession}
                  disabled={pinActionLoading !== null}
                  className="px-4 py-2 border border-[#E6E8EA] text-[#0B0B0B] rounded-lg text-sm font-semibold hover:bg-[#F4F5F6] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {pinActionLoading === 'unlock'
                    ? 'Unlocking…'
                    : 'Unlock session'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Access Checklist Card */}
        {accessChecklist && (
          <div className="bg-white rounded-xl shadow-sm border border-[#E6E8EA] p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-[#0B0B0B]">Access Checklist</h2>
              {accessChecklist.missingCount > 0 && (
                <button
                  onClick={handleCopyMissingAccess}
                  className="px-3 py-1.5 text-sm font-semibold text-[#F5A524] bg-[#F5A524]/10 hover:bg-[#F5A524]/20 rounded-lg transition-colors flex items-center gap-1.5"
                  title="Copy missing access request text"
                >
                  {copiedMissingAccess ? (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy Missing Access Request
                    </>
                  )}
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {accessChecklist.items.map((item) => (
                <div
                  key={item.key}
                  className={`p-3 rounded-lg border ${
                    !item.relevant
                      ? 'bg-[#F4F5F6] border-[#E6E8EA]'
                      : item.provided
                      ? 'bg-[#25DC7F]/5 border-[#25DC7F]/30'
                      : 'bg-[#F5A524]/5 border-[#F5A524]/30'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {!item.relevant ? (
                      <span className="w-5 h-5 flex items-center justify-center text-[#A0A0A0]">
                        <span className="text-sm">-</span>
                      </span>
                    ) : item.provided ? (
                      <span className="w-5 h-5 flex items-center justify-center text-[#25DC7F]">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      </span>
                    ) : (
                      <span className="w-5 h-5 flex items-center justify-center text-[#F5A524]">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                      </span>
                    )}
                    <span className={`text-sm font-medium ${
                      !item.relevant
                        ? 'text-[#6B6B6B]'
                        : item.provided
                        ? 'text-[#25DC7F]'
                        : 'text-[#F5A524]'
                    }`}>
                      {item.shortLabel}
                    </span>
                  </div>
                  <p className={`text-xs ${
                    !item.relevant
                      ? 'text-[#A0A0A0]'
                      : item.provided
                      ? 'text-[#569077]'
                      : 'text-[#F5A524]'
                  }`}>
                    {!item.relevant ? 'N/A' : item.provided ? 'Provided' : 'Missing'}
                  </p>
                </div>
              ))}
            </div>

            {/* Summary */}
            <div className="mt-4 pt-4 border-t border-[#E6E8EA] flex items-center gap-4 text-sm">
              <span className="text-[#25DC7F]">
                {accessChecklist.presentCount} provided
              </span>
              <span className="text-[#F5A524]">
                {accessChecklist.missingCount} missing
              </span>
              {accessChecklist.notApplicableCount > 0 && (
                <span className="text-[#6B6B6B]">
                  {accessChecklist.notApplicableCount} N/A
                </span>
              )}
            </div>
          </div>
        )}

        {/* GBP Locations (5b) — fetch from the agency Google account,
            apply into the form's gbp_locations rows */}
        <GbpLocationsPanel
          sessionId={id}
          sessionStatus={session.status}
          onApplied={() => setRefreshKey((k) => k + 1)}
        />

        {/* Jump to Section Navigation */}
        <div className="bg-white rounded-xl shadow-sm border border-[#E6E8EA] p-6 mb-6">
          <h2 className="text-lg font-bold text-[#0B0B0B] mb-4">Jump to Section</h2>
          <div className="flex flex-wrap gap-2">
            {onboardingSteps.map((step, index) => {
              const answer = answers.find(a => a.step_key === step.key);
              const isCompleted = answer?.completed;

              return (
                <button
                  key={step.key}
                  onClick={() => scrollToSection(step.key)}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-colors flex items-center gap-1.5 ${
                    isCompleted
                      ? 'bg-[#25DC7F]/5 border-[#25DC7F]/30 text-[#25DC7F] hover:bg-[#25DC7F]/10'
                      : 'bg-[#F4F5F6] border-[#E6E8EA] text-[#6B6B6B] hover:bg-[#E6E8EA]'
                  }`}
                >
                  {isCompleted && (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {index + 1}. {step.title}
                </button>
              );
            })}
          </div>
        </div>

        {/* Answers by Step */}
        <div className="bg-white rounded-xl shadow-sm border border-[#E6E8EA] p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-[#0B0B0B]">Responses by Section</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setExpandedSteps(new Set(onboardingSteps.map(s => s.key)))}
                className="text-sm text-[#25DC7F] hover:text-[#1DB96A]"
              >
                Expand All
              </button>
              <span className="text-[#E6E8EA]">|</span>
              <button
                onClick={() => setExpandedSteps(new Set())}
                className="text-sm text-[#25DC7F] hover:text-[#1DB96A]"
              >
                Collapse All
              </button>
            </div>
          </div>

          {answers.length === 0 ? (
            <p className="text-[#6B6B6B] text-center py-8">
              No responses have been submitted yet.
            </p>
          ) : (
            <div className="space-y-4">
              {onboardingSteps.map((step, index) => {
                const answer = answers.find(a => a.step_key === step.key);
                const isExpanded = expandedSteps.has(step.key);

                return (
                  <div
                    key={step.key}
                    ref={el => { sectionRefs.current[step.key] = el; }}
                    id={`section-${step.key}`}
                    className="border border-[#E6E8EA] rounded-lg overflow-hidden scroll-mt-24"
                  >
                    <button
                      onClick={() => toggleStep(step.key)}
                      className="w-full px-4 py-3 flex items-center justify-between bg-[#F4F5F6] hover:bg-[#E6E8EA] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        {answer?.completed ? (
                          <span className="w-6 h-6 bg-[#25DC7F]/10 text-[#25DC7F] rounded-full flex items-center justify-center">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          </span>
                        ) : (
                          <span className="w-6 h-6 bg-[#E6E8EA] text-[#6B6B6B] rounded-full flex items-center justify-center text-xs font-medium">
                            {index + 1}
                          </span>
                        )}
                        <span className="font-semibold text-[#0B0B0B]">
                          {step.title}
                        </span>
                        {answer?.completed && (
                          <span className="text-xs text-[#6B6B6B]">
                            Updated {formatDate(answer.updated_at)}
                          </span>
                        )}
                      </div>
                      <svg
                        className={`w-5 h-5 text-[#6B6B6B] transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>

                    {isExpanded && (
                      <div className="px-4 py-4 border-t border-[#E6E8EA]">
                        {answer ? (
                          <div className="grid gap-4">
                            {Object.entries(answer.answers).map(([key, value]) => {
                              const field = step.fields.find(f => f.name === key);
                              return (
                                <div key={key} className="flex flex-col sm:flex-row sm:gap-4">
                                  <dt className="text-sm font-medium text-[#6B6B6B] sm:w-1/3">
                                    {field?.label || key}
                                  </dt>
                                  <dd className="text-sm text-[#0B0B0B] sm:w-2/3 whitespace-pre-wrap">
                                    {formatValue(value)}
                                  </dd>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-sm text-[#6B6B6B] italic">
                            This section has not been completed yet.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
