'use client';

import { Fragment, useState } from 'react';
import { OnboardingStep, OnboardingField } from '@/lib/onboarding/steps';

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
}

// Helper function to convert YouTube URL to embed URL
function getYouTubeEmbedUrl(url: string): string | null {
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
  if (shortMatch) return `https://www.youtube.com/embed/${shortMatch[1]}`;
  const longMatch = url.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/);
  if (longMatch) return `https://www.youtube.com/embed/${longMatch[1]}`;
  if (url.includes('youtube.com/embed/')) return url.split('?')[0];
  return null;
}

// Video Tutorial Component
function VideoTutorial({ url, title }: { url: string; title: string }) {
  const embedUrl = getYouTubeEmbedUrl(url);

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
  values: Record<string, unknown>
): boolean {
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
function resolveDynamicOptions(
  field: OnboardingField,
  values: Record<string, unknown>,
  step: OnboardingStep
): { value: string; label: string }[] | null {
  if (!field.optionsFromField) return null;
  const sourceValue = values[field.optionsFromField];
  const selected = Array.isArray(sourceValue) ? (sourceValue as string[]) : [];
  if (selected.length === 0) return [];
  // Pull labels from the source field's declared `options` for nicer copy;
  // fall back to the raw value as label if the source is purely free-text.
  const sourceField = step.fields.find((f) => f.name === field.optionsFromField);
  const labelLookup = new Map(
    (sourceField?.options ?? []).map((o) => [o.value, o.label])
  );
  return selected.map((v) => ({ value: v, label: labelLookup.get(v) ?? v }));
}

export default function StepRenderer({ step, values, errors, onChange, questionOverrides, prefillMap }: StepRendererProps) {
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
    if (!isFieldVisible(field, values)) {
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
        case 'tel':
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

        case 'textarea':
          return (
            <>
              <textarea
                id={field.name}
                name={field.name}
                value={(value as string) || ''}
                onChange={(e) => onChange(field.name, e.target.value)}
                placeholder={field.placeholder}
                rows={3}
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

        case 'multiselect':
          const selectedValues = (value as string[]) || [];
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
                      if (e.target.checked) {
                        onChange(field.name, [...selectedValues, option.value]);
                      } else {
                        onChange(field.name, selectedValues.filter((v) => v !== option.value));
                      }
                    }}
                    className="w-4 h-4 text-[#25DC7F] rounded border-[#E6E8EA] focus:ring-[#25DC7F] focus:ring-offset-0"
                  />
                  <span className="text-[#1A1A1A]">{option.label}</span>
                </label>
              ))}
            </div>
          );

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
              <span className="text-[#1A1A1A]">{override?.label_override || field.label}</span>
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
  const visibleFields = step.fields.filter((field) => isFieldVisible(field, values));

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
                  {(override?.help_override || field.helpText) && (
                    <p className="mt-1 text-xs text-[#6B6B6B] ml-8">{override?.help_override || field.helpText}</p>
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
                  {override?.label_override || field.label}
                  {field.required && <span className="text-[#E5484D] ml-1">*</span>}
                </label>
                {renderField(field)}
                {(override?.help_override || field.helpText) && (
                  <p className="mt-1 text-xs text-[#6B6B6B]">{override?.help_override || field.helpText}</p>
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
