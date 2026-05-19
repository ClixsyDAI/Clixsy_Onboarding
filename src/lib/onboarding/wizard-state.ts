// =============================================================
// Wizard state helpers — pure functions, easy to unit test
// =============================================================

/**
 * Clamp a session-stored `current_step` value to a valid index within
 * `[0, totalSteps - 1]`.
 *
 * Defensive coding to prevent the TypeError crash flagged by the
 * goarco production smoke: when a session is rolled back from
 * `submitted` to `in_progress` (admin tool / manual DB edit / future
 * status-rollback feature) the row's `current_step` can equal
 * `steps.length` (the submit handler sets it there), but
 * `steps[currentStepIndex]` then returns `undefined` and the first
 * access to `.title` / `.key` crashes the page. Same risk if a future
 * step-count migration shrinks the flow and old sessions point past
 * the new max.
 *
 * Behaviour:
 *   - null / undefined / NaN → 0
 *   - negative → 0
 *   - within bounds → unchanged
 *   - >= totalSteps → totalSteps - 1
 *   - totalSteps <= 0 → 0 (degenerate but safe)
 */
export function clampInitialStep(
  current: number | null | undefined,
  totalSteps: number
): number {
  if (totalSteps <= 0) return 0;
  if (current === null || current === undefined) return 0;
  if (!Number.isFinite(current)) return 0;
  const i = Math.floor(current);
  if (i < 0) return 0;
  if (i >= totalSteps) return totalSteps - 1;
  return i;
}
