'use client';

import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { OnboardingStep, OnboardingField, type VerticalId } from '@/lib/onboarding/steps';
import {
  HOME_SERVICES_TAXONOMY,
  getServicesForTrade,
  getTradeForService,
  getAllTradesWithSelections,
  pruneOrphanServices,
} from '@/lib/onboarding/service-taxonomy';
import { youTubeEmbedUrl } from '@/lib/onboarding/youtube';

interface QuestionOverride {
  label_override: string;
  help_override?: string;
  ui_pattern: 'confirmation' | 'default';
  original_label: string;
}

interface PrefillEntry {
  suggested_value: unknown;
  confidence: number;
  policy: 'autofill' | 'suggest_only' | 'no_prefill';
  evidence: { source_url: string; excerpt: string }[];
}

interface StepRendererProps {
  step: OnboardingStep;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (name: string, value: unknown) => void;
  questionOverrides?: Record<string, QuestionOverride> | null;
  prefillMap?: Record<string, PrefillEntry> | null;
  /**
   * Stage 9: drives `verticalIn` (gated visibility) + `labelByVertical`
   * (per-vertical copy) + `helpTextByVertical`. Defaulted at the call
   * site by Wizard.tsx to 'law_firm' for backwards compat.
   */
  vertical?: VerticalId;
}


// Video Tutorial Component
function VideoTutorial({ url, title }: { url: string; title: string }) {
  const embedUrl = youTubeEmbedUrl(url);

  if (!embedUrl) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 text-sm text-[#25DC7F] hover:text-[#1eb86a] font-medium"
      >
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
        </svg>
        {title}
      </a>
    );
  }

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <svg className="w-5 h-5 text-[#E5484D]" fill="currentColor" viewBox="0 0 24 24">
          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
        </svg>
        <span className="text-sm font-semibold text-[#0B0B0B]">{title}</span>
      </div>
      <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-[#E6E8EA] bg-black">
        <iframe
          src={embedUrl}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 w-full h-full"
        />
      </div>
    </div>
  );
}

// S5.1 / S5.2: visual preview of an autofilled value with Confirm / Edit
// affordances. Toggles between three internal states:
//   - 'preview'   (default when scraper value present): swatch/sample +
//                 Confirm / Edit buttons.
//   - 'edit'      (after Edit click): falls through to the regular text
//                 input rendered by the caller so the user can type freely.
//   - 'confirmed' (after Confirm click): collapsed "Confirmed" badge with
//                 a Change link to re-enter edit mode.
// The value itself flows through `onChange` unchanged; nothing about the
// JSONB shape changes — this is purely how we *render* the existing
// `primary_color` / `secondary_color` / `typography_fonts` strings.
type PreviewKind = 'color-swatch' | 'font-sample';
function ScrapedValuePreview({
  kind,
  value,
  evidence,
  fallback,
  onChange,
  fieldName,
}: {
  kind: PreviewKind;
  value: string;
  evidence: string | null;
  fallback: React.ReactNode;
  onChange: (name: string, v: unknown) => void;
  fieldName: string;
}) {
  const [mode, setMode] = useState<'preview' | 'edit' | 'confirmed'>('preview');

  if (mode === 'edit' || !value) {
    return (
      <>
        {fallback}
        {value && (
          <button
            type="button"
            onClick={() => setMode('preview')}
            className="mt-1 text-xs text-[#6B6B6B] hover:text-[#0B0B0B] underline"
          >
            Back to preview
          </button>
        )}
      </>
    );
  }

  if (mode === 'confirmed') {
    return (
      <div className="flex items-center gap-3 px-3 py-2.5 border border-[#25DC7F]/30 bg-[#25DC7F]/5 rounded-lg">
        {kind === 'color-swatch' && /^#?[0-9a-fA-F]{3,8}$/.test(value.trim()) && (
          <span
            className="w-6 h-6 rounded border border-[#E6E8EA] flex-shrink-0"
            style={{ backgroundColor: value.trim().startsWith('#') ? value.trim() : `#${value.trim()}` }}
            aria-hidden
          />
        )}
        <span className="flex-1 text-sm text-[#0B0B0B] font-mono">{value}</span>
        <svg className="w-4 h-4 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-xs text-[#25DC7F] font-medium">Confirmed</span>
        <button
          type="button"
          onClick={() => setMode('preview')}
          className="text-xs text-[#6B6B6B] hover:text-[#0B0B0B] underline"
        >
          Change
        </button>
      </div>
    );
  }

  // mode === 'preview'
  const isHex = kind === 'color-swatch' && /^#?[0-9a-fA-F]{3,8}$/.test(value.trim());
  const swatchHex = value.trim().startsWith('#') ? value.trim() : `#${value.trim()}`;
  const fontNames = kind === 'font-sample' ? value.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];

  return (
    <div className="border border-[#25DC7F]/30 bg-[#25DC7F]/5 rounded-lg p-3">
      <div className="flex items-center gap-3">
        {kind === 'color-swatch' && isHex && (
          <span
            className="w-10 h-10 rounded border border-[#E6E8EA] flex-shrink-0"
            style={{ backgroundColor: swatchHex }}
            aria-label={`Color swatch ${value}`}
          />
        )}
        {kind === 'font-sample' && fontNames.length > 0 && (
          <div className="flex-1 min-w-0">
            {fontNames.slice(0, 3).map((fn) => (
              <div key={fn} className="text-base text-[#0B0B0B] truncate" style={{ fontFamily: `'${fn}', sans-serif` }}>
                {fn}
              </div>
            ))}
          </div>
        )}
        {kind === 'color-swatch' && (
          <span className="flex-1 text-sm text-[#0B0B0B] font-mono">{value}</span>
        )}
      </div>
      {evidence && (
        <p className="mt-2 text-xs text-[#6B6B6B] italic">{evidence}</p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setMode('confirmed')}
          className="px-3 py-1.5 bg-[#25DC7F] text-white rounded-md text-xs font-semibold hover:bg-[#1DB96A] transition-colors"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={() => setMode('edit')}
          className="px-3 py-1.5 border border-[#E6E8EA] text-[#0B0B0B] rounded-md text-xs font-semibold hover:bg-[#F4F5F6] transition-colors"
        >
          Edit
        </button>
      </div>
    </div>
  );
}

// S3.2: auto-growing textarea. The prefilled-address textarea was too
// short to show a full street + suite + city/state/zip without internal
// scrolling, and the doc complains that reviewers don't realise they can
// scroll. Auto-size to fit content from ~3 lines to ~6 lines, then cap
// with overflow-auto. Used for every `textarea`-type field in the wizard
// so a fix at the root benefits any read-back field with the same shape.
function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  id,
  name,
  className,
  minRows = 3,
  maxRows = 6,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
  name?: string;
  className?: string;
  minRows?: number;
  maxRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    // Reset to auto so scrollHeight reflects the natural content size,
    // not the previous fixed height.
    el.style.height = 'auto';
    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const paddingY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const minH = lineHeight * minRows + paddingY + borderY;
    const maxH = lineHeight * maxRows + paddingY + borderY;
    const targetH = Math.min(maxH, Math.max(minH, el.scrollHeight));
    el.style.height = `${targetH}px`;
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  };

  // Resize on mount, on every value change, and on window resize (font
  // size or layout may shift the natural height).
  useLayoutEffect(() => {
    resize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useLayoutEffect(() => {
    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <textarea
      ref={ref}
      id={id}
      name={name}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={minRows}
      className={className}
      style={{ resize: 'none' }}
    />
  );
}

// External-link action button — small "open in new tab" affordance shown
// alongside URL inputs that opt in via `linkAction`. Uses
// `noopener noreferrer` to prevent reverse-tab-nabbing, and is disabled
// until the field has a parseable URL.
function ExternalLinkButton({ label, href }: { label: string; href: string }) {
  const canOpen = (() => {
    if (!href) return false;
    try {
      const u = new URL(href.includes('://') ? href : `https://${href}`);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  })();
  const resolved = href.includes('://') ? href : `https://${href}`;
  if (!canOpen) {
    return (
      <button
        type="button"
        disabled
        className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium rounded-lg border border-[#E6E8EA] text-[#A0A0A0] cursor-not-allowed whitespace-nowrap"
        title="Enter a valid URL to enable this button"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
        {label}
      </button>
    );
  }
  return (
    <a
      href={resolved}
      target="_blank"
      rel="noopener noreferrer"
      className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium rounded-lg border border-[#25DC7F] text-[#25DC7F] hover:bg-[#25DC7F]/10 transition-colors whitespace-nowrap"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
      {label}
    </a>
  );
}

// Suggestion Chip — shown for suggest_only policy
function SuggestionChip({ value, onAccept }: { value: string; onAccept: () => void }) {
  return (
    <button
      type="button"
      onClick={onAccept}
      className="inline-flex items-center gap-1.5 mt-1.5 px-3 py-1.5 bg-[#25DC7F]/10 border border-[#25DC7F]/30 rounded-full text-xs text-[#0B0B0B] font-medium hover:bg-[#25DC7F]/20 transition-colors"
    >
      <svg className="w-3 h-3 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
      Use suggestion: {value}
    </button>
  );
}

// Determine if a field should span both columns (full width)
function shouldSpanFullWidth(field: OnboardingField): boolean {
  if (field.videoUrl) return true;
  if (field.type === 'textarea') return true;
  if (field.type === 'multiselect' || field.type === 'radio') return true;
  if (field.options && field.options.length > 4) return true;
  return false;
}

// Centralised dependsOn check — supports the three forms documented on the
// OnboardingField type (value / valueIn / includes). Used in two places:
// (a) the early-return inside renderField for nested logic, and (b) the
// outer visibleFields filter that determines section grouping.
function isFieldVisible(
  field: OnboardingField,
  values: Record<string, unknown>,
  vertical?: VerticalId
): boolean {
  // Stage 9: vertical gate is checked FIRST and independently of
  // dependsOn — a field declared `verticalIn: ['home_services']` is
  // hidden on every law_firm session regardless of sibling state.
  if (field.verticalIn && vertical && !field.verticalIn.includes(vertical)) {
    return false;
  }
  if (!field.dependsOn) return true;
  const dep = field.dependsOn;
  const depValue = values[dep.field];
  if (dep.includes !== undefined) {
    return Array.isArray(depValue) && depValue.includes(dep.includes);
  }
  if (dep.valueIn !== undefined) {
    return dep.valueIn.includes(depValue as string);
  }
  if (dep.value !== undefined) {
    return depValue === dep.value;
  }
  return true;
}

// Resolve `optionsFromField` into a concrete option list at render time.
// Returns `null` if the field doesn't use the feature (so callers can fall
// back to the static `options`). Returns `[]` if the source is present but
// empty — callers use this to render the "select something first" affordance.
//
// Stage 9: two home-services-specific cascades have to taxonomy-expand
// (not just label-lookup) because the source field stores a different
// kind of ID than this field's options expose:
//
//   - source = 'service_trades' → trade IDs like 'hvac'. We expand each
//     selected trade into its child service options (e.g. 'hvac.ac_repair').
//   - source = 'service_categories' → service IDs like 'hvac.ac_repair'.
//     The source has no static `options` array (its options are themselves
//     resolved dynamically), so the generic label-lookup path fails. We
//     resolve labels directly from HOME_SERVICES_TAXONOMY.
function resolveDynamicOptions(
  field: OnboardingField,
  values: Record<string, unknown>,
  step: OnboardingStep
): { value: string; label: string }[] | null {
  if (!field.optionsFromField) return null;
  const sourceValue = values[field.optionsFromField];
  const selected = Array.isArray(sourceValue) ? (sourceValue as string[]) : [];
  if (selected.length === 0) return [];

  // Home-services cascade #1: trade IDs → flattened taxonomy services.
  // Preserves trade order (declaration order in HOME_SERVICES_TAXONOMY)
  // so the flat list is predictable. Used by service_priority for its
  // option list when the user happens to be on this path (priority's
  // direct source is service_categories — see #2 below — but if any
  // future field were to read service_trades directly it would also
  // pick this up).
  if (field.optionsFromField === 'service_trades') {
    return selected.flatMap((tradeId) =>
      getServicesForTrade(tradeId).map((svc) => ({ value: svc.id, label: svc.label }))
    );
  }

  // Home-services cascade #2: service IDs → labels via the taxonomy.
  // service_categories itself has no static `options` (it's grouped-
  // rendered in the multiselect branch below), so we can't fall back to
  // its options table for labels. Look up via the taxonomy directly,
  // dropping any service IDs we can't find (defensive — shouldn't occur
  // for clean data, but a stale answer from an older taxonomy revision
  // would otherwise crash here).
  if (field.optionsFromField === 'service_categories') {
    const out: { value: string; label: string }[] = [];
    for (const sid of selected) {
      const trade = getTradeForService(sid);
      if (!trade) continue;
      const svc = HOME_SERVICES_TAXONOMY[trade].services.find((s) => s.id === sid);
      if (svc) out.push({ value: svc.id, label: svc.label });
    }
    return out;
  }

  // Default: pull labels from the source field's declared `options` for
  // nicer copy; fall back to the raw value as label if the source is
  // purely free-text. This is the law-firm path (case_priority reads
  // primary_case_types_keywords which has a fully static options table).
  const sourceField = step.fields.find((f) => f.name === field.optionsFromField);
  const labelLookup = new Map(
    (sourceField?.options ?? []).map((o) => [o.value, o.label])
  );
  return selected.map((v) => ({ value: v, label: labelLookup.get(v) ?? v }));
}

export default function StepRenderer({ step, values, errors, onChange, questionOverrides, prefillMap, vertical }: StepRendererProps) {
  // Track dismissed confirmations so we show original field if user says "No"
  const [dismissedOverrides, setDismissedOverrides] = useState<Set<string>>(new Set());

  const getOverride = (fieldName: string): QuestionOverride | null => {
    if (!questionOverrides) return null;
    if (dismissedOverrides.has(fieldName)) return null;
    return questionOverrides[fieldName] || null;
  };

  const getSuggestion = (fieldName: string): PrefillEntry | null => {
    if (!prefillMap) return null;
    const entry = prefillMap[fieldName];
    if (!entry || entry.policy !== 'suggest_only') return null;
    return entry;
  };

  // Stage 9 helpers: pick the vertical-appropriate label / helpText for
  // a field when it declares per-vertical overrides. Falls back to the
  // default `label` / `helpText`. Used by every render branch that
  // surfaces user-visible copy (renderField, top-level field label,
  // checkbox inline label, ConfirmationField via override merge).
  const labelFor = (field: OnboardingField): string =>
    (vertical && field.labelByVertical?.[vertical]) || field.label;
  const helpTextFor = (field: OnboardingField): string | undefined =>
    (vertical && field.helpTextByVertical?.[vertical]) || field.helpText;

  const renderField = (field: OnboardingField) => {
    const value = values[field.name];
    const error = errors[field.name];
    const override = getOverride(field.name);
    const suggestion = getSuggestion(field.name);
    const baseInputClasses = `w-full px-3 py-2.5 border rounded-lg transition-all duration-150 text-sm ${
      error
        ? 'border-[#E5484D] bg-red-50'
        : 'border-[#E6E8EA] bg-white hover:border-[#A0A0A0] focus:border-[#25DC7F] focus:ring-2 focus:ring-[#25DC7F]/20'
    }`;

    // Check if field should be shown based on dependsOn (supports
    // value / valueIn / includes — see OnboardingField type).
    if (!isFieldVisible(field, values, vertical)) {
      return null;
    }

    // Show suggestion chip for suggest_only fields that are currently empty
    const isEmpty = value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0);
    const showSuggestion = suggestion && isEmpty;

    const fieldElement = (() => {
      switch (field.type) {
        case 'text':
        case 'email':
        case 'url':
        case 'tel': {
          // S5.1 / S5.2 — visual preview takes over when the scraper has
          // autofilled the value AND the optional gate matches (e.g. the
          // user opted into "pull from website" for colors). Falls back
          // gracefully to a plain input + "couldn't extract" hint when the
          // gate matches but the scraper produced nothing.
          if (field.previewMode && field.type === 'text') {
            const gate = field.gatePreviewOn;
            const gateMatches = !gate || values[gate.field] === gate.value;
            const prefillEntry = prefillMap?.[field.name];
            const isPrefilledAutofill = prefillEntry?.policy === 'autofill';
            const previewValue = typeof value === 'string' ? value : '';

            if (gateMatches && isPrefilledAutofill && previewValue) {
              const evidenceLine = prefillEntry?.evidence?.[0]?.excerpt || null;
              return (
                <ScrapedValuePreview
                  kind={field.previewMode}
                  value={previewValue}
                  evidence={evidenceLine}
                  fieldName={field.name}
                  onChange={onChange}
                  fallback={
                    <input
                      type="text"
                      id={field.name}
                      name={field.name}
                      value={previewValue}
                      onChange={(e) => onChange(field.name, e.target.value)}
                      placeholder={field.placeholder}
                      className={baseInputClasses}
                    />
                  }
                />
              );
            }

            if (gateMatches && gate && !isPrefilledAutofill) {
              // Gated path with no scrape signal — be explicit instead of
              // showing a confusing empty input.
              return (
                <>
                  <input
                    type="text"
                    id={field.name}
                    name={field.name}
                    value={previewValue}
                    onChange={(e) => onChange(field.name, e.target.value)}
                    placeholder={field.placeholder}
                    className={baseInputClasses}
                  />
                  <p className="mt-1 text-xs text-[#6B6B6B] italic">
                    We couldn&apos;t extract this from your website automatically. Enter it manually above.
                  </p>
                </>
              );
            }
          }
          return (
            <>
              <div className={field.linkAction && field.type === 'url' ? 'flex gap-2' : ''}>
                <input
                  type={field.type}
                  id={field.name}
                  name={field.name}
                  value={(value as string) || ''}
                  onChange={(e) => onChange(field.name, e.target.value)}
                  placeholder={field.placeholder}
                  className={baseInputClasses}
                />
                {field.linkAction && field.type === 'url' && (
                  // S7.3: inline "open in new tab" button. Disabled until the
                  // value parses as a usable URL so we never spawn `about:blank`
                  // or send the user to a malformed href.
                  <ExternalLinkButton
                    label={field.linkAction.label}
                    href={(value as string) || ''}
                  />
                )}
              </div>
              {showSuggestion && typeof suggestion.suggested_value === 'string' && (
                <SuggestionChip
                  value={suggestion.suggested_value}
                  onAccept={() => onChange(field.name, suggestion.suggested_value)}
                />
              )}
            </>
          );
        }

        case 'textarea':
          return (
            <>
              <AutoGrowTextarea
                id={field.name}
                name={field.name}
                value={(value as string) || ''}
                onChange={(v) => onChange(field.name, v)}
                placeholder={field.placeholder}
                className={baseInputClasses}
              />
              {showSuggestion && typeof suggestion.suggested_value === 'string' && (
                <SuggestionChip
                  value={suggestion.suggested_value.length > 60 ? suggestion.suggested_value.slice(0, 60) + '...' : suggestion.suggested_value}
                  onAccept={() => onChange(field.name, suggestion.suggested_value)}
                />
              )}
            </>
          );

        case 'select': {
          // Resolve dynamic options pulled from another field's selection.
          // Falls back to the field's static `options` if no source is set.
          const dynamicOptions = resolveDynamicOptions(field, values, step);
          const opts = dynamicOptions ?? field.options ?? [];
          const isDisabledForEmptySource =
            !!field.optionsFromField && dynamicOptions !== null && dynamicOptions.length === 0;
          return (
            <select
              id={field.name}
              name={field.name}
              value={(value as string) || ''}
              onChange={(e) => onChange(field.name, e.target.value)}
              disabled={isDisabledForEmptySource}
              className={baseInputClasses}
            >
              <option value="">
                {isDisabledForEmptySource
                  ? `Select at least one option in "${field.optionsFromField}" above`
                  : 'Select an option...'}
              </option>
              {opts.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          );
        }

        case 'multiselect': {
          const selectedValues = (value as string[]) || [];

          // Stage 9 — home-services-specific render path for
          // service_categories. Instead of a single flat grid, we
          // render one sub-section per ticked trade (HVAC, Plumbing,
          // ...) with the trade's label as a small header and its
          // child services as checkboxes underneath. Keeps long lists
          // scannable when the user has ticked multiple trades.
          if (field.name === 'service_categories') {
            const selectedTrades = (values.service_trades as string[]) || [];
            const tradesView = getAllTradesWithSelections(selectedTrades, selectedValues);
            if (tradesView.length === 0) {
              return (
                <p className="text-sm text-[#6B6B6B] italic px-3 py-2 bg-[#F4F5F6] rounded-lg">
                  Tick at least one trade above to see the services you can choose from.
                </p>
              );
            }
            return (
              <div className="space-y-5">
                {tradesView.map((trade) => (
                  <div key={trade.tradeId}>
                    <h3 className="text-sm font-semibold text-[#0B0B0B] mb-2">{trade.tradeLabel}</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {trade.services.map((svc) => (
                        <label
                          key={svc.id}
                          className={`flex items-center gap-2 px-3 py-2 border rounded-lg cursor-pointer transition-all duration-150 text-sm ${
                            selectedValues.includes(svc.id)
                              ? 'border-[#25DC7F] bg-[#25DC7F]/5'
                              : 'border-[#E6E8EA] hover:border-[#A0A0A0]'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedValues.includes(svc.id)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...selectedValues, svc.id]
                                : selectedValues.filter((v) => v !== svc.id);
                              onChange(field.name, next);
                              // Service_priority cascade: if the user
                              // untoggles the currently-chosen priority
                              // service, clear it so the radio doesn't
                              // hold a stale id.
                              const currentPriority = values.service_priority as string | undefined;
                              if (!e.target.checked && currentPriority === svc.id) {
                                onChange('service_priority', '');
                              }
                            }}
                            className="w-4 h-4 text-[#25DC7F] rounded border-[#E6E8EA] focus:ring-[#25DC7F] focus:ring-offset-0"
                          />
                          <span className="text-[#1A1A1A]">{svc.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          }

          // Standard flat multi-select. For service_trades we wrap the
          // setter with a cascade-purge so unticking a trade removes
          // its child services from service_categories AND clears
          // service_priority if it pointed at one of those services.
          const isServiceTrades = field.name === 'service_trades';
          const applyTradesChange = (newTrades: string[]) => {
            onChange(field.name, newTrades);
            if (!isServiceTrades) return;
            const currentCategories = (values.service_categories as string[]) || [];
            const prunedCategories = pruneOrphanServices(newTrades, currentCategories);
            if (prunedCategories.length !== currentCategories.length) {
              onChange('service_categories', prunedCategories);
            }
            const currentPriority = values.service_priority as string | undefined;
            if (currentPriority && !prunedCategories.includes(currentPriority)) {
              onChange('service_priority', '');
            }
          };

          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {field.options?.map((option) => (
                <label
                  key={option.value}
                  className={`flex items-center gap-2 px-3 py-2 border rounded-lg cursor-pointer transition-all duration-150 text-sm ${
                    selectedValues.includes(option.value)
                      ? 'border-[#25DC7F] bg-[#25DC7F]/5'
                      : 'border-[#E6E8EA] hover:border-[#A0A0A0]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedValues.includes(option.value)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selectedValues, option.value]
                        : selectedValues.filter((v) => v !== option.value);
                      if (isServiceTrades) {
                        applyTradesChange(next);
                      } else {
                        onChange(field.name, next);
                      }
                    }}
                    className="w-4 h-4 text-[#25DC7F] rounded border-[#E6E8EA] focus:ring-[#25DC7F] focus:ring-offset-0"
                  />
                  <span className="text-[#1A1A1A]">{option.label}</span>
                </label>
              ))}
            </div>
          );
        }

        case 'checkbox':
          return (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                id={field.name}
                name={field.name}
                checked={(value as boolean) || false}
                onChange={(e) => onChange(field.name, e.target.checked)}
                className="w-5 h-5 mt-0.5 text-[#25DC7F] rounded border-[#E6E8EA] focus:ring-[#25DC7F] focus:ring-offset-0"
              />
              <span className="text-[#1A1A1A]">{override?.label_override || labelFor(field)}</span>
            </label>
          );

        case 'radio': {
          // Same dynamic-option resolution as `select` so radios can cascade
          // (e.g. case_priority → primary_case_types_keywords selections).
          const dynamicOptions = resolveDynamicOptions(field, values, step);
          const opts = dynamicOptions ?? field.options ?? [];
          if (field.optionsFromField && dynamicOptions !== null && dynamicOptions.length === 0) {
            return (
              <p className="text-sm text-[#6B6B6B] italic px-3 py-2 bg-[#F4F5F6] rounded-lg">
                Select at least one option above to choose from here.
              </p>
            );
          }
          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {opts.map((option) => (
                <label
                  key={option.value}
                  className={`flex items-center gap-2 px-3 py-2 border rounded-lg cursor-pointer transition-all duration-150 text-sm ${
                    value === option.value
                      ? 'border-[#25DC7F] bg-[#25DC7F]/5'
                      : 'border-[#E6E8EA] hover:border-[#A0A0A0]'
                  }`}
                >
                  <input
                    type="radio"
                    name={field.name}
                    value={option.value}
                    checked={value === option.value}
                    onChange={(e) => onChange(field.name, e.target.value)}
                    className="w-4 h-4 text-[#25DC7F] border-[#E6E8EA] focus:ring-[#25DC7F] focus:ring-offset-0"
                  />
                  <span className="text-[#1A1A1A]">{option.label}</span>
                </label>
              ))}
            </div>
          );
        }

        default:
          return null;
      }
    })();

    return fieldElement;
  };

  // Filter out hidden fields using the centralised dependsOn check so the
  // outer layout matches what renderField produces. A field with a
  // `sectionHeader` is rendered as its own row above the field, so we keep
  // them in the same flat sequence and let the layout split rows as it goes.
  const visibleFields = step.fields.filter((field) => isFieldVisible(field, values, vertical));

  return (
    <div>
      {/* Two-column grid layout for fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-x-6 md:gap-y-4">
        {visibleFields.map((field) => {
          const spanFull = shouldSpanFullWidth(field);
          const override = getOverride(field.name);

          // Optional section header that introduces this field as the first
          // entry in a new visually distinct group (e.g. the welcome-gift
          // block at the bottom of the Other Contacts step).
          const headerNode = field.sectionHeader ? (
            <div key={`${field.name}__hdr`} className="md:col-span-2 mt-6 pt-6 border-t border-[#E6E8EA]">
              <h2 className="text-lg font-bold text-[#0B0B0B]">{field.sectionHeader.title}</h2>
              {field.sectionHeader.subtitle && (
                <p className="text-sm italic text-[#6B6B6B] mt-1">{field.sectionHeader.subtitle}</p>
              )}
            </div>
          ) : null;

          // For checkboxes, we handle the label differently
          if (field.type === 'checkbox') {
            return (
              <Fragment key={field.name}>
                {headerNode}
                <div className={spanFull ? 'md:col-span-2' : ''}>
                  {field.videoUrl && field.videoTitle && (
                    <VideoTutorial url={field.videoUrl} title={field.videoTitle} />
                  )}
                  {renderField(field)}
                  {(override?.help_override || helpTextFor(field)) && (
                    <p className="mt-1 text-xs text-[#6B6B6B] ml-8">{override?.help_override || helpTextFor(field)}</p>
                  )}
                  {errors[field.name] && (
                    <p className="mt-1 text-xs text-[#E5484D] ml-8">{errors[field.name]}</p>
                  )}
                </div>
              </Fragment>
            );
          }

          // Confirmation pattern — wrap field with Yes/No confirmation
          if (override?.ui_pattern === 'confirmation') {
            return (
              <Fragment key={field.name}>
                {headerNode}
                <div className="md:col-span-2">
                  {field.videoUrl && field.videoTitle && (
                    <VideoTutorial url={field.videoUrl} title={field.videoTitle} />
                  )}
                  <ConfirmationField
                    field={field}
                    override={override}
                    value={values[field.name]}
                    error={errors[field.name]}
                    onChange={onChange}
                    onDismiss={() => setDismissedOverrides(prev => new Set(prev).add(field.name))}
                    renderField={() => renderField(field)}
                  />
                </div>
              </Fragment>
            );
          }

          return (
            <Fragment key={field.name}>
              {headerNode}
              <div className={spanFull ? 'md:col-span-2' : ''}>
                {field.videoUrl && field.videoTitle && (
                  <VideoTutorial url={field.videoUrl} title={field.videoTitle} />
                )}
                <label
                  htmlFor={field.name}
                  className="block text-sm font-semibold text-[#0B0B0B] mb-1.5"
                >
                  {override?.label_override || labelFor(field)}
                  {field.required && <span className="text-[#E5484D] ml-1">*</span>}
                </label>
                {renderField(field)}
                {(override?.help_override || helpTextFor(field)) && (
                  <p className="mt-1 text-xs text-[#6B6B6B]">{override?.help_override || helpTextFor(field)}</p>
                )}
                {errors[field.name] && (
                  <p className="mt-1 text-xs text-[#E5484D]">{errors[field.name]}</p>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

// =============================================
// Confirmation Field Component
// =============================================

function ConfirmationField({
  field,
  override,
  value,
  error,
  onChange,
  onDismiss,
  renderField,
}: {
  field: OnboardingField;
  override: QuestionOverride;
  value: unknown;
  error?: string;
  onChange: (name: string, value: unknown) => void;
  onDismiss: () => void;
  renderField: () => React.ReactNode;
}) {
  const [confirmed, setConfirmed] = useState<boolean | null>(null);

  // If value exists and confirmation hasn't been answered yet, default to showing confirmation
  const hasValue = value !== undefined && value !== null && value !== '' &&
    !(Array.isArray(value) && value.length === 0);

  return (
    <div className="bg-[#25DC7F]/5 border border-[#25DC7F]/20 rounded-lg p-4">
      <label className="block text-sm font-semibold text-[#0B0B0B] mb-3">
        {override.label_override}
        {field.required && <span className="text-[#E5484D] ml-1">*</span>}
      </label>

      {confirmed === null && hasValue && (
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            onClick={() => setConfirmed(true)}
            className="px-4 py-2 bg-[#25DC7F] text-white rounded-lg text-sm font-semibold hover:bg-[#1DB96A] transition-colors"
          >
            Yes, that&apos;s correct
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmed(false);
              onDismiss();
            }}
            className="px-4 py-2 border border-[#E6E8EA] text-[#0B0B0B] rounded-lg text-sm font-semibold hover:bg-[#F4F5F6] transition-colors"
          >
            No, let me edit
          </button>
        </div>
      )}

      {/* S6.2: show the underlying field only when:
          - User clicked "No, let me edit" (confirmed === false), or
          - We never had a prefilled value to confirm against (!hasValue).
        While the user hasn't decided yet (confirmed === null && hasValue)
        the Yes/No buttons ARE the question — rendering the input alongside
        is redundant (and was the source of the call-tracking dropdown
        appearing twice). The detected value is already in label_override. */}
      {(confirmed === false || !hasValue) && (
        <div>
          {renderField()}
          {override.help_override && (
            <p className="mt-1 text-xs text-[#6B6B6B]">{override.help_override}</p>
          )}
        </div>
      )}

      {confirmed === true && hasValue && (
        <div className="flex items-center gap-2 text-sm text-[#25DC7F]">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span>Confirmed</span>
          <button
            type="button"
            onClick={() => setConfirmed(null)}
            className="text-xs text-[#6B6B6B] hover:text-[#0B0B0B] ml-2"
          >
            Change
          </button>
        </div>
      )}

      {error && (
        <p className="mt-1 text-xs text-[#E5484D]">{error}</p>
      )}
    </div>
  );
}
