// Run: npx tsx src/lib/onboarding/field-messages.test.ts
//
// The claim this file exists to hold: NO path returns validator text to a
// client. Asserting that about the one bug we saw ("Invalid input: expected
// string, received undefined" on three fields of step 1) is not enough --
// the whole point of fixing it at the conversion point rather than in the
// three schemas was to close the class. So the sweep below drives EVERY
// required field of EVERY step through the real validators with the field
// absent, which is the exact condition that produced the leak, and checks
// the output is human on all of them.
//
// It also carries a denominator: a run that validated nothing would pass a
// "no bad strings found" check trivially, which is [[M8]]. The counts are
// asserted, not just printed.

import { onboardingStepsV2 } from './steps-v2';
import { onboardingSteps } from './steps';
import { validateStepDataForVersion } from './flow-version';
import { messageForField, visibleLabel } from './field-messages';
import type { OnboardingField } from './steps';

function assert(cond: boolean, label: string) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

/** Fingerprints of validator-speak. Any of these reaching a client is the bug. */
const VALIDATOR_SPEAK = [
  'invalid input',
  'expected string',
  'received undefined',
  'received null',
  'invalid_type',
  'too_small',
  'zod',
  'undefined',
  'null',
  'nan',
];

const looksLikeValidatorSpeak = (msg: string) =>
  VALIDATOR_SPEAK.filter((bad) => msg.toLowerCase().includes(bad));

// =============================================================
// 1. Every step, both flows, with EVERY field absent
// =============================================================

console.log('--- no validator text escapes, v2 ---');

let v2Checked = 0;
let v2Messages = 0;
for (const step of onboardingStepsV2) {
  // Empty object == the client pressed Next without touching anything.
  const res = validateStepDataForVersion('v2', step.key, {});
  v2Checked++;
  if (res.success) continue;
  for (const [fieldName, msg] of Object.entries(res.errors ?? {})) {
    v2Messages++;
    const hits = looksLikeValidatorSpeak(msg);
    assert(hits.length === 0, `v2 ${step.key}.${fieldName} is human: "${msg}"${hits.length ? ` [leaked: ${hits.join(', ')}]` : ''}`);
    assert(msg.trim().length > 0, `v2 ${step.key}.${fieldName} is non-empty`);
    assert(/[.!?]$|https:\/\/$|example\.com$|123-4567$/.test(msg.trim()), `v2 ${step.key}.${fieldName} reads as a sentence`);
  }
}
assert(v2Checked === onboardingStepsV2.length, `v2 denominator: ${v2Checked} steps validated (of ${onboardingStepsV2.length})`);
assert(v2Messages > 0, `v2 denominator: ${v2Messages} messages actually produced (a zero here would pass everything above for free)`);

console.log('--- no validator text escapes, v1 ---');

let v1Messages = 0;
for (const step of onboardingSteps) {
  const res = validateStepDataForVersion('v1', step.key, {});
  if (res.success) continue;
  for (const [fieldName, msg] of Object.entries(res.errors ?? {})) {
    v1Messages++;
    const hits = looksLikeValidatorSpeak(msg);
    assert(hits.length === 0, `v1 ${step.key}.${fieldName} is human: "${msg}"${hits.length ? ` [leaked: ${hits.join(', ')}]` : ''}`);
  }
}
assert(v1Messages > 0, `v1 denominator: ${v1Messages} messages produced`);

// =============================================================
// 2. The exact regression, named
// =============================================================

console.log('--- the three fields that shipped the leak ---');

const step1 = validateStepDataForVersion('v2', 'primary_contact', {});
for (const f of ['main_contact_title', 'main_contact_email', 'main_contact_phone']) {
  const msg = step1.errors?.[f] ?? '';
  assert(!!msg, `${f} still reports a failure`);
  assert(
    msg !== 'Invalid input: expected string, received undefined',
    `${f} no longer shows the raw Zod string`,
  );
}
assert(
  (step1.errors?.main_contact_email ?? '').includes('name@example.com'),
  'the email field tells the client the shape it wants',
);

// =============================================================
// 3. Message shape by field type
// =============================================================

console.log('--- copy is specific to the control ---');

const mk = (type: OnboardingField['type'], label: string): OnboardingField =>
  ({ name: 'x', label, type }) as OnboardingField;
const missing = { code: 'invalid_type', message: 'Invalid input: expected string, received undefined' };

assert(messageForField(mk('select', 'Title/Role'), missing).startsWith('Choose'), 'a select says Choose, not Enter');
assert(messageForField(mk('multiselect', 'Languages'), missing).includes('at least one'), 'a multiselect asks for at least one');
assert(messageForField(mk('checkbox', 'Agree'), missing).startsWith('Tick'), 'a checkbox says Tick');
assert(messageForField(mk('text', 'Full Name'), missing) === 'Enter your full name.', 'a text field names itself in lower case');
assert(messageForField(mk('url', 'Your Website'), missing).includes('https://'), 'a url field states the prefix');
assert(
  messageForField(mk('text', 'What is your #1 goal for working with us?'), missing) ===
    'Please answer this question to continue.',
  'a question-shaped label is not jammed into a sentence',
);
assert(
  messageForField(mk('email', 'Email Address'), { code: 'invalid_format', format: 'email' }).includes('typo'),
  'a malformed email is told it is malformed, not that it is missing',
);
assert(
  messageForField(undefined, missing) === 'Please check this answer and try again.',
  'even an unmatched field name yields human copy',
);

// =============================================================
// 4. The label the client sees is the label named
// =============================================================

console.log('--- per-vertical labels ---');

const relabelled = {
  name: 'primary_case_types_keywords',
  label: 'Primary case types',
  labelByVertical: { home_services: 'Primary service categories' },
  type: 'text',
} as unknown as OnboardingField;

assert(visibleLabel(relabelled) === 'Primary case types', 'default label without a vertical');
assert(
  visibleLabel(relabelled, 'home_services' as never) === 'Primary service categories',
  'vertical override wins',
);
assert(
  messageForField(relabelled, missing, 'home_services' as never).includes('primary service categories'),
  'the message names what a home-services client is actually looking at',
);

console.log(`\nswept ${v2Checked} v2 steps / ${v2Messages} v2 messages / ${v1Messages} v1 messages`);
