'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

interface AccessChecklistItem {
  key: string;
  label: string;
  shortLabel: string;
  provided: boolean;
  relevant: boolean;
}

interface AccessChecklist {
  items: AccessChecklistItem[];
  missingCount: number;
  presentCount: number;
}

interface Session {
  id: string;
  token: string;
  status: 'draft' | 'in_progress' | 'submitted';
  currentStep: number;
  lastSavedAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  completedSteps: number;
  totalSteps: number;
  progressPercent: number;
  clientName: string;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  accessChecklist: AccessChecklist;
}

type StatusFilter = 'all' | 'draft' | 'in_progress' | 'submitted';
type ProgressFilter = 'all' | '0-25' | '26-50' | '51-75' | '76-99' | '100';
type AccessFilter = 'all' | 'missing' | 'complete';

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>('all');
  const [accessFilter, setAccessFilter] = useState<AccessFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Delete state
  const [deleteSession, setDeleteSession] = useState<Session | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    async function fetchSessions() {
      try {
        const response = await fetch('/api/admin/onboarding/sessions');
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch sessions');
        }

        setSessions(data.sessions || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
      } finally {
        setIsLoading(false);
      }
    }

    fetchSessions();
  }, []);

  // Handle delete
  const handleDelete = async () => {
    if (!deleteSession) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/admin/onboarding/sessions/${deleteSession.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete session');
      }

      // Remove from local state
      setSessions(prev => prev.filter(s => s.id !== deleteSession.id));
      setDeleteSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session');
    } finally {
      setIsDeleting(false);
    }
  };

  // Filter sessions based on selected filters
  const filteredSessions = useMemo(() => {
    return sessions.filter(session => {
      // Status filter
      if (statusFilter !== 'all' && session.status !== statusFilter) {
        return false;
      }

      // Progress filter
      if (progressFilter !== 'all') {
        const percent = session.progressPercent;
        switch (progressFilter) {
          case '0-25':
            if (percent > 25) return false;
            break;
          case '26-50':
            if (percent < 26 || percent > 50) return false;
            break;
          case '51-75':
            if (percent < 51 || percent > 75) return false;
            break;
          case '76-99':
            if (percent < 76 || percent > 99) return false;
            break;
          case '100':
            if (percent !== 100) return false;
            break;
        }
      }

      // Access filter
      if (accessFilter !== 'all') {
        const hasMissing = session.accessChecklist?.missingCount > 0;
        if (accessFilter === 'missing' && !hasMissing) return false;
        if (accessFilter === 'complete' && hasMissing) return false;
      }

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = session.clientName.toLowerCase().includes(query);
        const matchesEmail = session.primaryContactEmail?.toLowerCase().includes(query);
        const matchesContact = session.primaryContactName?.toLowerCase().includes(query);
        if (!matchesName && !matchesEmail && !matchesContact) {
          return false;
        }
      }

      return true;
    });
  }, [sessions, statusFilter, progressFilter, accessFilter, searchQuery]);

  // Stats for the dashboard header
  const stats = useMemo(() => {
    const total = sessions.length;
    const draft = sessions.filter(s => s.status === 'draft').length;
    const inProgress = sessions.filter(s => s.status === 'in_progress').length;
    const submitted = sessions.filter(s => s.status === 'submitted').length;
    const avgProgress = total > 0
      ? Math.round(sessions.reduce((sum, s) => sum + s.progressPercent, 0) / total)
      : 0;
    const missingAccess = sessions.filter(s => s.accessChecklist?.missingCount > 0).length;
    return { total, draft, inProgress, submitted, avgProgress, missingAccess };
  }, [sessions]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'draft':
        return <span className="px-2.5 py-1 text-xs font-semibold bg-[var(--bg)] text-[var(--muted)] rounded-full">Draft</span>;
      case 'in_progress':
        return <span className="px-2.5 py-1 text-xs font-semibold bg-[var(--amber)]/10 text-[var(--amber)] rounded-full">In Progress</span>;
      case 'submitted':
        return <span className="px-2.5 py-1 text-xs font-semibold bg-[var(--green-fill)]/10 text-[var(--green)] rounded-full">Submitted</span>;
      default:
        return null;
    }
  };

  const getProgressColor = (percent: number) => {
    if (percent === 100) return 'bg-[var(--green-fill)]';
    if (percent >= 75) return 'bg-[var(--green-dim)]';
    if (percent >= 50) return 'bg-[var(--amber)]';
    if (percent >= 25) return 'bg-[var(--amber)]';
    return 'bg-[var(--faint)]';
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

  const formatRelativeTime = (dateString: string | null) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateString);
  };

  // Access indicator component
  const AccessIndicator = ({ item }: { item: AccessChecklistItem }) => {
    if (!item.relevant) {
      return (
        <span
          className="w-6 h-6 flex items-center justify-center text-[var(--faint)]"
          title={`${item.label} - Not applicable`}
        >
          <span className="text-xs">-</span>
        </span>
      );
    }

    if (item.provided) {
      return (
        <span
          className="w-6 h-6 flex items-center justify-center text-[var(--green)]"
          title={`${item.label} - Provided`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </span>
      );
    }

    return (
      <span
        className="w-6 h-6 flex items-center justify-center text-[var(--amber)]"
        title={`${item.label} - Missing`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </span>
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        {/* Header */}
        <header className="bg-[var(--side)]">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
            <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
            <div className="px-4 py-2 bg-[var(--card2)] text-[var(--text)] text-sm font-semibold rounded-lg">
              Clixsy Onboarding Portal
            </div>
          </div>
        </header>
        <div className="max-w-7xl mx-auto p-8">
          <div className="animate-pulse space-y-4">
            <div className="h-8 w-64 bg-[var(--card)] rounded" />
            <div className="grid grid-cols-6 gap-4">
              {[1, 2, 3, 4, 5, 6].map(i => (
                <div key={i} className="h-24 bg-[var(--card)] rounded-xl" />
              ))}
            </div>
            <div className="h-96 bg-[var(--card)] rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Header */}
      <header className="bg-[var(--side)]">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
          </Link>
          <div className="px-4 py-2 bg-[var(--card2)] text-[var(--text)] text-sm font-semibold rounded-lg">
            Clixsy Onboarding Portal
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-8">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-extrabold text-[var(--text)]">
              Onboarding Progress
            </h1>
            <p className="text-[var(--muted)] mt-1">
              Track and manage all client onboarding sessions
            </p>
          </div>
          <Link
            href="/admin/onboarding/new"
            className="px-6 py-3 bg-[var(--green-fill)] text-[var(--on-green)] rounded-lg font-semibold hover:bg-[var(--green-dim)] transition-colors flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Session
          </Link>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4 mb-8">
          <div className="bg-[var(--card)] rounded-xl shadow-sm border border-[var(--border2)] p-5">
            <p className="text-sm font-medium text-[var(--muted)]">Total Sessions</p>
            <p className="text-3xl font-bold text-[var(--text)] mt-1">{stats.total}</p>
          </div>
          <div className="bg-[var(--card)] rounded-xl shadow-sm border border-[var(--border2)] p-5">
            <p className="text-sm font-medium text-[var(--muted)]">Draft</p>
            <p className="text-3xl font-bold text-[var(--muted)] mt-1">{stats.draft}</p>
          </div>
          <div className="bg-[var(--card)] rounded-xl shadow-sm border border-[var(--border2)] p-5">
            <p className="text-sm font-medium text-[var(--muted)]">In Progress</p>
            <p className="text-3xl font-bold text-[var(--amber)] mt-1">{stats.inProgress}</p>
          </div>
          <div className="bg-[var(--card)] rounded-xl shadow-sm border border-[var(--border2)] p-5">
            <p className="text-sm font-medium text-[var(--muted)]">Submitted</p>
            <p className="text-3xl font-bold text-[var(--green)] mt-1">{stats.submitted}</p>
          </div>
          <div className="bg-[var(--card)] rounded-xl shadow-sm border border-[var(--border2)] p-5">
            <p className="text-sm font-medium text-[var(--muted)]">Avg. Progress</p>
            <p className="text-3xl font-bold text-[var(--muted)] mt-1">{stats.avgProgress}%</p>
          </div>
          <div className="bg-[var(--card)] rounded-xl shadow-sm border border-[var(--border2)] p-5">
            <p className="text-sm font-medium text-[var(--muted)]">Missing Access</p>
            <p className="text-3xl font-bold text-[var(--amber)] mt-1">{stats.missingAccess}</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-[var(--red-soft)] border border-[var(--red)] rounded-lg text-[var(--red)]">
            {error}
          </div>
        )}

        {/* Filters */}
        <div className="bg-[var(--card)] rounded-xl shadow-sm border border-[var(--border2)] p-4 mb-6">
          <div className="flex flex-wrap items-center gap-4">
            {/* Search */}
            <div className="flex-1 min-w-[200px]">
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--faint)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search by client name or email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-[var(--border2)] rounded-lg focus:ring-2 focus:ring-[var(--green)]/20 focus:border-[var(--green)]"
                />
              </div>
            </div>

            {/* Status Filter */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-[var(--muted)]">Status:</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="px-3 py-2 border border-[var(--border2)] rounded-lg focus:ring-2 focus:ring-[var(--green)]/20 focus:border-[var(--green)]"
              >
                <option value="all">All</option>
                <option value="draft">Draft</option>
                <option value="in_progress">In Progress</option>
                <option value="submitted">Submitted</option>
              </select>
            </div>

            {/* Progress Filter */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-[var(--muted)]">Progress:</label>
              <select
                value={progressFilter}
                onChange={(e) => setProgressFilter(e.target.value as ProgressFilter)}
                className="px-3 py-2 border border-[var(--border2)] rounded-lg focus:ring-2 focus:ring-[var(--green)]/20 focus:border-[var(--green)]"
              >
                <option value="all">All</option>
                <option value="0-25">0-25%</option>
                <option value="26-50">26-50%</option>
                <option value="51-75">51-75%</option>
                <option value="76-99">76-99%</option>
                <option value="100">100%</option>
              </select>
            </div>

            {/* Access Filter */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-[var(--muted)]">Access:</label>
              <select
                value={accessFilter}
                onChange={(e) => setAccessFilter(e.target.value as AccessFilter)}
                className="px-3 py-2 border border-[var(--border2)] rounded-lg focus:ring-2 focus:ring-[var(--green)]/20 focus:border-[var(--green)]"
              >
                <option value="all">All</option>
                <option value="missing">Missing Access</option>
                <option value="complete">All Access Provided</option>
              </select>
            </div>

            {/* Clear Filters */}
            {(statusFilter !== 'all' || progressFilter !== 'all' || accessFilter !== 'all' || searchQuery) && (
              <button
                onClick={() => {
                  setStatusFilter('all');
                  setProgressFilter('all');
                  setAccessFilter('all');
                  setSearchQuery('');
                }}
                className="px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--text)]"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* Sessions Table */}
        <div className="bg-[var(--card)] rounded-xl shadow-sm border border-[var(--border2)] overflow-hidden">
          {filteredSessions.length === 0 ? (
            <div className="p-12 text-center">
              {sessions.length === 0 ? (
                <>
                  <svg className="w-12 h-12 mx-auto text-[var(--faint)] mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <h3 className="text-lg font-semibold text-[var(--text)] mb-2">
                    No sessions yet
                  </h3>
                  <p className="text-[var(--muted)] mb-4">
                    Create your first onboarding session to get started.
                  </p>
                  <Link
                    href="/admin/onboarding/new"
                    className="inline-block px-6 py-3 bg-[var(--green-fill)] text-[var(--on-green)] rounded-lg font-semibold hover:bg-[var(--green-dim)] transition-colors"
                  >
                    Create First Session
                  </Link>
                </>
              ) : (
                <>
                  <svg className="w-12 h-12 mx-auto text-[var(--faint)] mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <h3 className="text-lg font-semibold text-[var(--text)] mb-2">
                    No matching sessions
                  </h3>
                  <p className="text-[var(--muted)]">
                    Try adjusting your filters or search query.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-[var(--bg)]">
                  <tr>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                      Client
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                      Progress
                    </th>
                    <th className="px-4 py-4 text-left text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                      Access
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                      Last Activity
                    </th>
                    <th className="px-6 py-4 text-right text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border2)]">
                  {filteredSessions.map((session) => (
                    <tr key={session.id} className="hover:bg-[var(--bg)]/50 transition-colors">
                      <td className="px-6 py-4">
                        <div>
                          <div className="font-semibold text-[var(--text)]">
                            {session.clientName}
                          </div>
                          {session.primaryContactEmail && (
                            <div className="text-sm text-[var(--muted)]">
                              {session.primaryContactEmail}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {getStatusBadge(session.status)}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 max-w-[120px]">
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="font-medium text-[var(--text)]">
                                {session.completedSteps}/{session.totalSteps}
                              </span>
                              <span className="text-[var(--muted)]">
                                {session.progressPercent}%
                              </span>
                            </div>
                            <div className="w-full h-2 bg-[var(--border)] rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${getProgressColor(session.progressPercent)}`}
                                style={{ width: `${session.progressPercent}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-0.5">
                          {session.accessChecklist?.items?.map((item) => (
                            <AccessIndicator key={item.key} item={item} />
                          ))}
                          {session.accessChecklist?.missingCount > 0 && (
                            <span className="ml-1 text-xs text-[var(--amber)] font-medium">
                              {session.accessChecklist.missingCount}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-[var(--text)]">
                          {formatRelativeTime(session.lastSavedAt || session.createdAt)}
                        </div>
                        <div className="text-xs text-[var(--muted)]">
                          {session.submittedAt ? `Submitted ${formatDate(session.submittedAt)}` : `Created ${formatDate(session.createdAt)}`}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            href={`/admin/onboarding/sessions/${session.id}`}
                            className="px-3 py-1.5 text-sm text-[var(--green)] hover:text-[var(--green)] font-semibold hover:bg-[var(--green-fill)]/10 rounded-lg transition-colors"
                          >
                            View
                          </Link>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(`${window.location.origin}/onboarding/${session.token}`);
                            }}
                            className="px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--text)] font-medium hover:bg-[var(--bg)] rounded-lg transition-colors"
                            title="Copy client link"
                          >
                            Copy Link
                          </button>
                          <button
                            onClick={() => setDeleteSession(session)}
                            className="px-3 py-1.5 text-sm text-[var(--red)] hover:text-[var(--red)] font-medium hover:bg-[var(--red-soft)] rounded-lg transition-colors"
                            title="Delete session"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Results count */}
        {filteredSessions.length > 0 && (
          <div className="mt-4 text-sm text-[var(--muted)] text-center">
            Showing {filteredSessions.length} of {sessions.length} sessions
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteSession && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--card)] rounded-2xl shadow-2xl max-w-md w-full p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 rounded-full bg-[var(--red-soft)] flex items-center justify-center flex-shrink-0">
                <svg className="w-6 h-6 text-[var(--red)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-bold text-[var(--text)]">
                  Delete Client
                </h3>
                <p className="text-sm text-[var(--muted)]">
                  This action cannot be undone
                </p>
              </div>
            </div>

            <p className="text-[var(--text)] mb-6">
              Are you sure you want to delete <span className="font-bold">{deleteSession.clientName}</span> and all their onboarding data?
            </p>

            <div className="flex gap-3">
              <button
                onClick={() => setDeleteSession(null)}
                disabled={isDeleting}
                className="flex-1 px-4 py-2.5 border border-[var(--border2)] text-[var(--text)] rounded-lg font-semibold hover:bg-[var(--bg)] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex-1 px-4 py-2.5 bg-[var(--red)] text-[var(--text)] rounded-lg font-semibold hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isDeleting ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Deleting...
                  </>
                ) : (
                  'Delete'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
