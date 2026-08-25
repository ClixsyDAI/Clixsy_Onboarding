// Run: npx tsx src/lib/onboarding/pin-envelope-write.test.ts
//
// Covers the WRITE half of PIN recovery: encryptPinForStorage and the
// two places a PIN comes into existence. Both are exercised here,
// because patching one and not the other is the way this feature
// silently half-works:
//
//   1. rotatePin(), driven directly against a fake Supabase client so
//      the exact update payload can be inspected.
//   2. POST /api/admin/onboarding/create, which mints its PIN inline.
//      The route itself needs a request, a real client and four table
//      writes, so what is asserted here is the part that can go wrong
//      silently: the helper it calls, and (by source assertion) that
//      its audit payload cannot carry a PIN.
//
// The sharpest property under test is that pin_envelope is written
// THROUGH on every rotation, including as null. Omitting the column
// when encryption fails would leave the PREVIOUS rotation's envelope
// beside the new hash, and that stale envelope still decrypts cleanly
// (right key, valid auth tag) to a PIN that no longer opens the
// session, so the retrieval endpoint would hand an admin a
// confidently wrong PIN. A conditional spread would reintroduce that
// with every type check and lint rule still green, which is why it
// gets an assertion and not a comment.
//
// The Supabase env vars below point the pin_rotated audit insert at a
// closed port. src/lib/supabase/server.ts captures those vars at
// MODULE scope, so they must be set before it is loaded, which is why
// rotatePin arrives via await import() inside run(). Two things fall
// out of that: rotation is proven to survive an audit sink that does
// not answer, and this test can never reach real Supabase, not even
// on a machine that has those vars exported.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptPin, isPinEnvelope } from './pin-encryption';
import { encryptPinForStorage } from './pin-envelope-write';

let checks = 0;

function assert(cond: boolean, label: string) {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

// Canonical base64 of 32 bytes. Fixed, not random: a test that
// generates its own key cannot fail the way a bad env var does.
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');
// Decodes to 32 bytes but re-encodes WITH the padding it is missing,
// which is what the canonical round-trip check in loadPinEncryptionKey
// catches. Same class of mistake as pasting a base64url key.
const UNPADDED_KEY = VALID_KEY.replace(/=+$/, '');
// Decodes to 16 bytes: valid base64, wrong cipher.
const SHORT_KEY = Buffer.alloc(16, 3).toString('base64');

const SESSION_ID = 'session-under-test';

function setKey(value: string | undefined) {
  if (value === undefined) {
    delete process.env.PIN_ENCRYPTION_KEY;
  } else {
    process.env.PIN_ENCRYPTION_KEY = value;
  }
}

/** Run fn with console.error captured, and return what it logged. */
function captureErrors(fn: () => void): string {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
}

type FakeUpdate = Record<string, unknown>;

/**
 * Minimum surface rotatePin touches: select().eq().single() for the
 * pre-read, and update().eq() for the write. Every update payload is
 * recorded so the assertions can look at what would hit the column.
 */
function makeFakeSupabase(row: Record<string, unknown> | null) {
  const updates: FakeUpdate[] = [];
  const fake = {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () =>
            row === null
              ? { data: null, error: { message: 'no rows returned' } }
              : { data: row, error: null },
        }),
      }),
      update: (payload: FakeUpdate) => {
        updates.push(payload);
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  return { supabase: fake as unknown as SupabaseClient, updates };
}

function existingRow() {
  return {
    id: SESSION_ID,
    pin_hash: 'scrypt$16384$8$1$aaaa$bbbb',
    pin_attempts: 3,
    pin_lockout_until: '2026-01-01T00:00:00.000Z',
    pin_locked_at: '2026-01-01T00:00:00.000Z',
  };
}

/** Read a source file from the repo root, loudly if it is not there. */
function readRepoFile(relative: string): string {
  const source = readFileSync(path.join(process.cwd(), relative), 'utf8');
  assert(source.length > 0, `read ${relative} (run from the repo root)`);
  return source;
}

async function run() {
  const originalKey = process.env.PIN_ENCRYPTION_KEY;
  try {
    // ---------------------------------------------------------------
    console.log('--- encryptPinForStorage: key present ---');
    // ---------------------------------------------------------------
    setKey(VALID_KEY);

    const ok = encryptPinForStorage('123456', SESSION_ID);
    assert(ok.errorCode === null, 'no error code on success');
    assert(ok.envelope !== null, 'an envelope comes back');
    assert(isPinEnvelope(ok.envelope), 'the envelope parses as an envelope');
    assert(
      (ok.envelope ?? '').startsWith('aes-256-gcm$1$'),
      'self-describing prefix, algorithm and version first',
    );
    assert(
      decryptPin(ok.envelope) === '123456',
      'round-trips to the same PIN under the same key',
    );

    const second = encryptPinForStorage('123456', SESSION_ID);
    assert(
      second.envelope !== ok.envelope,
      'same PIN encrypts differently each time (fresh IV, not deterministic)',
    );

    // ---------------------------------------------------------------
    console.log('--- encryptPinForStorage: fails open, never throws ---');
    // ---------------------------------------------------------------
    // Each of these is a real deployment mistake, and the contract is
    // identical for all of them: no throw, a null envelope, and a code
    // the caller can put on an audit row.
    setKey(undefined);
    let log = '';
    let unset = { envelope: 'unset' as string | null, errorCode: null as string | null };
    log = captureErrors(() => {
      unset = encryptPinForStorage('135790', SESSION_ID);
    });
    assert(unset.envelope === null, 'key unset: envelope is null, not a throw');
    assert(unset.errorCode === 'configuration', 'key unset: code is configuration');
    assert(log.includes(SESSION_ID), 'key unset: the log names the session');
    assert(
      log.includes('PIN_ENCRYPTION_KEY'),
      'key unset: the log names the env var to fix',
    );
    assert(!log.includes('135790'), 'key unset: the PIN is NOT in the log');

    setKey(UNPADDED_KEY);
    let unpadded = unset;
    log = captureErrors(() => {
      unpadded = encryptPinForStorage('135790', SESSION_ID);
    });
    assert(
      unpadded.envelope === null && unpadded.errorCode === 'configuration',
      'non-canonical base64 key is named as misconfiguration, not used',
    );
    assert(
      log.includes('canonical base64'),
      'and the log says WHICH misconfiguration, not just that one happened',
    );

    setKey(SHORT_KEY);
    let short = unset;
    log = captureErrors(() => {
      short = encryptPinForStorage('135790', SESSION_ID);
    });
    assert(
      short.envelope === null && short.errorCode === 'configuration',
      'a 16-byte key is refused rather than silently changing the cipher',
    );

    setKey(VALID_KEY);
    let badPin = { envelope: 'unset' as string | null, errorCode: null as string | null };
    log = captureErrors(() => {
      badPin = encryptPinForStorage('12345', SESSION_ID);
    });
    assert(
      badPin.envelope === null && badPin.errorCode === 'input',
      'a non-6-digit PIN is an input error, distinct from a config error',
    );
    assert(!log.includes('12345'), 'input error: the rejected value is NOT echoed');

    // ---------------------------------------------------------------
    console.log('--- rotatePin: writes pin_envelope THROUGH ---');
    // ---------------------------------------------------------------
    const { rotatePin } = await import('./rotate-pin');

    setKey(VALID_KEY);
    const rot = makeFakeSupabase(existingRow());
    const first = await rotatePin(rot.supabase, SESSION_ID);
    assert(first.kind === 'ok', 'rotation succeeds');
    assert(
      first.kind === 'ok' && /^\d{6}$/.test(first.pin),
      'the plaintext PIN is still returned once, unchanged contract',
    );
    assert(rot.updates.length === 1, 'exactly one update statement');

    const payload1 = rot.updates[0];
    assert(
      typeof payload1.pin_hash === 'string' &&
        (payload1.pin_hash as string).startsWith('scrypt$'),
      'pin_hash is written and still the scrypt encoding',
    );
    assert(
      typeof payload1.pin_envelope === 'string',
      'pin_envelope is written in the SAME statement as pin_hash',
    );
    assert(
      first.kind === 'ok' &&
        decryptPin(payload1.pin_envelope) === first.pin,
      'the stored envelope decrypts to exactly the PIN that was returned',
    );
    assert(
      payload1.pin_attempts === 0 &&
        payload1.pin_lockout_until === null &&
        payload1.pin_locked_at === null,
      'the lockout reset side effects are untouched by this feature',
    );

    // The property a conditional spread would break. Rotate the same
    // session again with the key gone: the column must be set to null,
    // NOT left out, or rotation 1's envelope survives beside rotation
    // 2's hash and later decrypts to a dead PIN.
    setKey(undefined);
    const secondRot = await captureAsync(() => rotatePin(rot.supabase, SESSION_ID));
    assert(secondRot.kind === 'ok', 'rotation still succeeds with no key at all');
    assert(
      secondRot.kind === 'ok' && /^\d{6}$/.test(secondRot.pin),
      'and still hands back a usable PIN, because pin_hash is the gate',
    );
    assert(rot.updates.length === 2, 'a second update statement ran');

    const payload2 = rot.updates[1];
    assert(
      Object.prototype.hasOwnProperty.call(payload2, 'pin_envelope'),
      'pin_envelope is PRESENT in the update even when encryption failed',
    );
    assert(
      payload2.pin_envelope === null,
      'and it is null, so no stale envelope survives beside the new hash',
    );
    setKey(VALID_KEY);
    let staleWouldDecrypt = false;
    try {
      staleWouldDecrypt = /^\d{6}$/.test(decryptPin(payload1.pin_envelope));
    } catch {
      staleWouldDecrypt = false;
    }
    assert(
      staleWouldDecrypt && payload2.pin_envelope === null,
      'rotation 1 envelope still decrypts cleanly: leaving it in place is the trap',
    );

    // Rotation survived two audit inserts aimed at a closed port. If
    // the audit were allowed to fail the rotation, both kind checks
    // above would already have failed.
    assert(
      first.kind === 'ok' && secondRot.kind === 'ok',
      'a pin_rotated audit that cannot be written does not fail the rotation',
    );

    // ---------------------------------------------------------------
    console.log('--- rotatePin: missing session touches nothing ---');
    // ---------------------------------------------------------------
    const missing = makeFakeSupabase(null);
    const notFound = await rotatePin(missing.supabase, 'no-such-session');
    assert(notFound.kind === 'not_found', 'an unknown session is not_found');
    assert(
      missing.updates.length === 0,
      'and no update is attempted, so nothing is encrypted or overwritten',
    );

    // ---------------------------------------------------------------
    console.log('--- audit payloads carry no secret ---');
    // ---------------------------------------------------------------
    // The payloads cannot be intercepted at runtime (the create route
    // needs a live client), so this reads the source. Crude, and still
    // the only guard that fails when someone adds `pin` or `envelope`
    // to a payload written to a table every service-role holder can
    // read.
    //
    // Anchored on `event_type: "pin_rotated"` rather than on a helper
    // call, because the rotation audit is now an INLINE insert whose
    // `.error` is checked: routing it through createAuditEvent meant
    // the insert could fail without throwing and without logging, and
    // that row is the only durable record of the outcome.
    const rotateSource = readRepoFile('src/lib/onboarding/rotate-pin.ts');
    const rotatePayload = between(rotateSource, 'event_type: "pin_rotated"', '});');
    assert(rotatePayload.length > 0, 'found the pin_rotated audit payload in source');
    assert(
      !/:\s*(pin|envelope)\s*[,}\n]/.test(rotatePayload),
      'pin_rotated payload assigns neither the raw PIN nor the raw envelope',
    );
    assert(
      /auditError/.test(rotateSource) &&
        /if\s*\(\s*auditError\s*\)/.test(rotateSource),
      'the rotation audit CHECKS its insert error rather than discarding it',
    );
    assert(
      !/createAuditEvent\s*\(/.test(rotateSource),
      'and does not route the only durable record through the helper that drops it',
    );
    assert(
      rotatePayload.includes('pin_encryption_error_code'),
      'pin_rotated payload carries the encryption error code',
    );

    const createSource = readRepoFile(
      'src/app/api/admin/onboarding/create/route.ts',
    );
    const createPayload = between(createSource, "'pin_envelope_write_failed'", '});');
    assert(
      createPayload.length > 0,
      'the create route writes a pin_envelope_write_failed audit event',
    );
    assert(
      !/:\s*(pin|pinEnvelope|envelope)\s*[,}\n]/.test(createPayload),
      'that payload assigns neither the PIN nor the envelope',
    );
    assert(
      createPayload.includes('pin_encryption_error_code'),
      'and it carries the encryption error code, the only durable trace',
    );
    assert(
      createSource.includes('errorCode: pinEnvelopeErrorCode'),
      'the create route keeps the error code instead of discarding it',
    );

    // ---------------------------------------------------------------
    console.log('--- both PIN birth sites are covered ---');
    // ---------------------------------------------------------------
    // If a third place starts minting PINs, this count moves and the
    // test says so, rather than passing while the new site writes no
    // envelope.
    const birthSites = [
      'src/app/api/admin/onboarding/create/route.ts',
      'src/lib/onboarding/rotate-pin.ts',
    ];
    let sitesEncrypting = 0;
    for (const site of birthSites) {
      const source = readRepoFile(site);
      const mints = source.includes('generatePin(');
      const encrypts = source.includes('encryptPinForStorage(');
      const writes = source.includes('pin_envelope');
      assert(
        mints && encrypts && writes,
        `${site} mints a PIN, encrypts it, and writes pin_envelope`,
      );
      if (mints && encrypts && writes) sitesEncrypting++;
    }
    assert(
      sitesEncrypting === 2,
      'both known PIN birth sites write an envelope (2 of 2)',
    );

    const total = checks;
    console.log(`\nswept ${total} checks / ${birthSites.length} PIN birth sites`);
    assert(
      total === 48,
      `all 48 checks ran, none skipped (ran ${total})`,
    );
  } finally {
    setKey(originalKey);
  }

  console.log('\n=========================================');
  console.log(
    `  ${process.exitCode !== 1 ? 'ALL TESTS PASS' : 'ONE OR MORE TESTS FAILED'}`,
  );
  console.log('=========================================');
}

/** Slice from the first marker to the next terminator after it. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  if (from === -1) return '';
  const to = source.indexOf(end, from);
  return to === -1 ? source.slice(from) : source.slice(from, to);
}

/** Await fn with console.error captured, so a failing audit insert
 * inside rotatePin does not spray the test output. */
async function captureAsync<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

run().catch((err) => {
  console.error('test harness failed:', err);
  process.exitCode = 1;
});
