'use client';

import type { RepeatingRowField } from '@/lib/onboarding/steps';

type RowValue = Record<string, string>;

interface RepeatingRowsProps {
  values: RowValue[];
  rowFields: RepeatingRowField[];
  onChange: (next: RowValue[]) => void;
  addButtonLabel: string;
}

function isValidHttpUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveHref(raw: string): string {
  return raw.includes('://') ? raw : `https://${raw}`;
}

/**
 * Reusable repeating-row renderer for `type: 'repeating'` fields. The
 * displayed grid is two columns on md+ and one on mobile; each cell is
 * a row of sub-field inputs (currently only url-style fields with an
 * optional linkAction), plus a delete button when there's more than one
 * row. The "add another" button sits bottom-left below the grid.
 *
 * Layout per operator spec (5a): two-column grid, each row has a URL
 * field + "View GBP" button, "Add another GBP profile" text button at
 * bottom left.
 */
export default function RepeatingRows({
  values,
  rowFields,
  onChange,
  addButtonLabel,
}: RepeatingRowsProps) {
  // Always show at least one row to type into — an empty array would
  // make the field invisible and the only affordance would be the
  // add button below an empty space.
  const rows: RowValue[] = values.length > 0 ? values : [{}];

  function updateCell(rowIdx: number, key: string, value: string) {
    const next = rows.map((row, i) =>
      i === rowIdx ? { ...row, [key]: value } : row,
    );
    onChange(next);
  }

  function addRow() {
    onChange([...rows, {}]);
  }

  function removeRow(rowIdx: number) {
    // Keep a single empty row when the user removes the last entry so
    // the input stays mountable and the visual structure doesn't
    // collapse. The save endpoint treats an empty-string row the same
    // as a missing value.
    const next = rows.filter((_, i) => i !== rowIdx);
    onChange(next.length > 0 ? next : [{}]);
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rows.map((row, rowIdx) => (
          <div key={rowIdx} className="flex gap-2 items-start">
            <div className="flex-1 flex gap-2 items-center">
              {rowFields.map((sub) => {
                const cellValue = (row[sub.name] as string) || '';
                const canOpen = sub.linkAction
                  ? isValidHttpUrl(cellValue)
                  : false;
                return (
                  <div key={sub.name} className="flex-1 flex gap-2 items-center">
                    <input
                      type={sub.type}
                      value={cellValue}
                      onChange={(e) =>
                        updateCell(rowIdx, sub.name, e.target.value)
                      }
                      placeholder={sub.placeholder}
                      aria-label={sub.label ?? sub.name}
                      className="flex-1 px-3 py-2.5 text-sm border border-[#E6E8EA] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#25DC7F] focus:border-transparent"
                    />
                    {sub.linkAction &&
                      (canOpen ? (
                        <a
                          href={resolveHref(cellValue)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium rounded-lg border border-[#25DC7F] text-[#25DC7F] hover:bg-[#25DC7F]/10 transition-colors whitespace-nowrap"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                            />
                          </svg>
                          {sub.linkAction.label}
                        </a>
                      ) : (
                        <button
                          type="button"
                          disabled
                          title="Enter a valid URL to enable this button"
                          className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium rounded-lg border border-[#E6E8EA] text-[#A0A0A0] cursor-not-allowed whitespace-nowrap"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                            />
                          </svg>
                          {sub.linkAction.label}
                        </button>
                      ))}
                  </div>
                );
              })}
            </div>
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => removeRow(rowIdx)}
                aria-label="Remove this profile"
                title="Remove this profile"
                className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[#E6E8EA] text-[#6B6B6B] hover:bg-[#F4F5F6] hover:text-[#E5484D] transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"
                  />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addRow}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-[#25DC7F] hover:text-[#1eb86a] transition-colors"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 4v16m8-8H4"
          />
        </svg>
        {addButtonLabel}
      </button>
    </div>
  );
}
