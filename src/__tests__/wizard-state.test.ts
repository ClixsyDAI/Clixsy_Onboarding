/**
 * Wizard-state unit tests.
 *
 * Run with: npx tsx src/__tests__/wizard-state.test.ts
 *
 * Covers clampInitialStep — the defensive fix for the
 * out-of-bounds-current_step crash flagged in the goarco production
 * smoke (Stage 9 / TECH_DEBT entry). See wizard-state.ts for full
 * background.
 */

import { clampInitialStep } from '../lib/onboarding/wizard-state';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    console.error(`  FAIL  ${message}`);
  }
}

console.log('\n--- clampInitialStep ---');

// 12-step v2 flow: valid range is 0..11
assert(clampInitialStep(-1, 12) === 0, 'current_step = -1 clamps to 0');
assert(clampInitialStep(0, 12) === 0, 'current_step = 0 stays at 0');
assert(clampInitialStep(5, 12) === 5, 'current_step = 5 (mid-range) unchanged');
assert(clampInitialStep(11, 12) === 11, 'current_step = 11 (last valid for 12) unchanged');
assert(clampInitialStep(12, 12) === 11, 'current_step = 12 (one past end) clamps to 11 — the actual goarco bug repro');
assert(clampInitialStep(100, 12) === 11, 'current_step = 100 clamps to 11');
assert(clampInitialStep(null, 12) === 0, 'null → 0');
assert(clampInitialStep(undefined, 12) === 0, 'undefined → 0');

// Edge: degenerate totalSteps
assert(clampInitialStep(5, 0) === 0, 'totalSteps = 0 always returns 0');
assert(clampInitialStep(5, 1) === 0, 'totalSteps = 1 always returns 0');

// Edge: non-finite numbers
assert(clampInitialStep(Number.NaN, 12) === 0, 'NaN → 0');
assert(clampInitialStep(Number.POSITIVE_INFINITY, 12) === 0, 'Infinity → 0 (not Finite)');
assert(clampInitialStep(Number.NEGATIVE_INFINITY, 12) === 0, '-Infinity → 0');

// Edge: fractional values are floored before clamping
assert(clampInitialStep(3.9, 12) === 3, '3.9 floored to 3');
assert(clampInitialStep(11.5, 12) === 11, '11.5 floored to 11');
assert(clampInitialStep(12.5, 12) === 11, '12.5 floored to 12 then clamped to 11');

console.log(`\n=========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`=========================================`);
if (failed > 0) process.exit(1);
