'use client';

import { useMemo, useState } from 'react';
import {
  fetchGbpLocationsAction,
  applyGbpLocationsAction,
} from '@/lib/gbp/actions';
import type { GbpLocation } from '@/lib/gbp/types';

interface GbpLocationsPanelProps {
  sessionId: string;
  /**
   * Submitted sessions are immutable (the apply action enforces this
   * server-side too); the panel disables apply and explains why.
   */
  sessionStatus?: 'draft' | 'in_progress' | 'submitted';
  /** Called after a successful apply so the page can refetch answers. */
  onApplied?: () => void;
}

function hasUsableUrl(loc: GbpLocation): boolean {
  return Boolean(loc.mapsUri ?? loc.websiteUri);
}

/**
 * GBP 5b admin surface: fetch the locations visible to the agency
 * Google account (mock fixtures until the Business Profile API
 * application is approved), pick the ones that belong to this
 * client, and write them into the session's gbp_locations answers.
 */
export default function GbpLocationsPanel({ sessionId, sessionStatus, onApplied }: GbpLocationsPanelProps) {
  const isSubmitted = sessionStatus === 'submitted';
  const [locations, setLocations] = useState<GbpLocation[] | null>(null);
  const [mode, setMode] = useState<'mock' | 'real' | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [isFetching, setIsFetching] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);

  const visible = useMemo(() => {
    if (!locations) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return locations;
    return locations.filter(
      (l) =>
        l.title.toLowerCase().includes(q) ||
        (l.address ?? '').toLowerCase().includes(q),
    );
  }, [locations, filter]);

  const handleFetch = async () => {
    setIsFetching(true);
    setError(null);
    setAppliedMessage(null);
    try {
      const result = await fetchGbpLocationsAction();
      if (!result.ok) throw new Error(result.error);
      setLocations(result.locations);
      setMode(result.mode);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch GBP locations');
    } finally {
      setIsFetching(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Only locations with a usable URL participate in select-all -- their
  // checkboxes are the only enabled ones, and a select-all that checks
  // a disabled checkbox can't be individually unticked.
  const selectableVisible = useMemo(() => visible.filter(hasUsableUrl), [visible]);
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every((l) => selected.has(l.id));

  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        selectableVisible.forEach((l) => next.delete(l.id));
      } else {
        selectableVisible.forEach((l) => next.add(l.id));
      }
      return next;
    });
  };

  const handleApply = async () => {
    if (!locations || isSubmitted) return;
    const rows = locations
      .filter((l) => selected.has(l.id))
      .map((l) => ({ url: l.mapsUri ?? l.websiteUri ?? '' }))
      .filter((r) => r.url);
    if (rows.length === 0) {
      setError('Selected locations have no usable URL');
      return;
    }
    setIsApplying(true);
    setError(null);
    setAppliedMessage(null);
    try {
      const result = await applyGbpLocationsAction(sessionId, rows);
      if (!result.ok) throw new Error(result.error);
      setAppliedMessage(
        `Saved -- the form now holds ${result.rowCount} GBP profile row${result.rowCount === 1 ? '' : 's'} (step: ${result.stepKey}). "Has GBP" was set to Yes.`,
      );
      setSelected(new Set());
      onApplied?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply GBP locations');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="bg-[var(--card)] rounded-xl shadow-sm border border-[var(--border2)] p-6 mb-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-bold text-[var(--text)]">GBP Locations</h2>
        {mode === 'mock' && (
          <span className="px-2 py-1 text-xs font-bold uppercase tracking-wide rounded bg-[var(--amber)]/15 text-[var(--amber)] border border-[var(--amber)]/30">
            Mock data
          </span>
        )}
      </div>
      <p className="text-sm text-[var(--muted)] mb-4">
        Pull the Business Profiles visible to the agency Google account and add the
        ones that belong to this client into the form&apos;s GBP profile rows.
        {mode === 'mock' && (
          <> Currently serving fixture data -- real listings activate once Google
          approves the Business Profile API application.</>
        )}
      </p>

      {isSubmitted && (
        <p className="mb-4 px-3 py-2 text-sm text-[var(--muted)] bg-[var(--bg)] border border-[var(--border2)] rounded-lg">
          This session has been submitted, so its form answers are locked.
          You can still fetch and view GBP locations, but they can&apos;t be
          added to the form.
        </p>
      )}

      {!locations && (
        <button
          onClick={handleFetch}
          disabled={isFetching}
          className="px-4 py-2 text-sm font-semibold text-[var(--on-green)] bg-[var(--green-fill)] hover:bg-[var(--green-dim)] disabled:opacity-50 rounded-lg transition-colors"
        >
          {isFetching ? 'Fetching…' : 'Fetch GBP locations'}
        </button>
      )}

      {locations && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or address…"
              className="flex-1 min-w-[220px] px-3 py-2 text-sm border border-[var(--border2)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--green)] focus:border-transparent"
            />
            <button
              onClick={selectAllVisible}
              className="px-3 py-2 text-sm font-medium text-[var(--text)] border border-[var(--border2)] hover:bg-[var(--bg)] rounded-lg transition-colors"
            >
              {allVisibleSelected ? 'Clear visible' : 'Select visible'}
            </button>
            <button
              onClick={handleFetch}
              disabled={isFetching}
              className="px-3 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border2)] hover:bg-[var(--bg)] disabled:opacity-50 rounded-lg transition-colors"
            >
              {isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto border border-[var(--border2)] rounded-lg divide-y divide-[var(--border2)]">
            {visible.length === 0 && (
              <p className="p-4 text-sm text-[var(--muted)]">No locations match the filter.</p>
            )}
            {visible.map((loc) => {
              const url = loc.mapsUri ?? loc.websiteUri;
              return (
                <label
                  key={loc.id}
                  className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-[var(--bg)] transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(loc.id)}
                    onChange={() => toggle(loc.id)}
                    disabled={!url}
                    className="mt-0.5 w-4 h-4 accent-[var(--green)]"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-[var(--text)] truncate">
                      {loc.title}
                    </span>
                    <span className="block text-xs text-[var(--muted)] truncate">
                      {loc.address ?? 'Service-area business (no storefront address)'}
                    </span>
                    {!url && (
                      <span className="block text-xs text-[var(--red)]">
                        No Maps or website URL on this listing -- cannot be added
                      </span>
                    )}
                  </span>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex-shrink-0 text-xs font-medium text-[var(--green)] hover:text-[var(--green)]"
                    >
                      View
                    </a>
                  )}
                </label>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handleApply}
              disabled={isApplying || selected.size === 0 || isSubmitted}
              title={isSubmitted ? 'Session submitted -- form answers are locked' : undefined}
              className="px-4 py-2 text-sm font-semibold text-[var(--on-green)] bg-[var(--green-fill)] hover:bg-[var(--green-dim)] disabled:opacity-50 rounded-lg transition-colors"
            >
              {isApplying
                ? 'Saving…'
                : `Add ${selected.size} selected to form`}
            </button>
            <span className="text-xs text-[var(--muted)]">
              {locations.length} location{locations.length === 1 ? '' : 's'} fetched
              {filter.trim() ? ` · ${visible.length} matching filter` : ''}
            </span>
          </div>
        </>
      )}

      {error && (
        <p className="mt-3 text-sm text-[var(--red)]">{error}</p>
      )}
      {appliedMessage && (
        <p className="mt-3 text-sm text-[var(--green)]">{appliedMessage}</p>
      )}
    </div>
  );
}
