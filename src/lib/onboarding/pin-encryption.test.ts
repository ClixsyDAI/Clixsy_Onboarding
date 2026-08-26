// =============================================================
// Tests for pin-encryption.ts. Run with: npm test
// =============================================================
//
// D7 of the crypto critique: the tag-length check, the hex-leniency guard and
// the six-digit re-validation had 56 assertions between them and every one was
// scratchpad-only. Nothing in the repo held them, so any of the three could be
// deleted and the suite would stay green.
//
// Each test here PROVES THE RAW HAZARD FIRST, then proves the module closes it.
// That ordering is deliberate. An assertion that "a bad envelope throws" passes
// just as happily when the guard is gone and something else happens to reject the
// input, so each test also pins WHICH layer does the work. Where a guard is
// defence in depth rather than the primary control, the test says so, because a
// test that misattributes protection is how a guard gets deleted as redundant.
//
// MUTATION-TESTED, with one gap that is stated rather than papered over. Each
// guard was disabled in turn and the suite re-run:
//
//   explicit auth-tag length check  -> RED
//   HEX_FIELD loosened              -> RED
//   six-digit re-validation removed -> RED
//   authTagLength option removed    -> STILL GREEN   <-- the gap
//
// The last one is structural, not an oversight in these tests. The explicit
// length check lives in parseEnvelope and runs BEFORE createDecipheriv is
// constructed, so a short tag never reaches the option and its presence has no
// observable behaviour to assert. That is precisely what defence in depth means
// here, and it is also why the option could be deleted as "unused" by someone
// reading only the code: nothing goes red.
//
// So the option's presence is held by the comment at its call site and by review,
// NOT by this suite. Pinning it would need source inspection rather than
// behaviour, which is a different kind of test and a worse one to fake. If the
// explicit check is ever removed in favour of relying on the option, this suite
// starts covering the option and the note should go.

import crypto from "node:crypto";
import {
  encryptPin,
  decryptPin,
  isPinEnvelope,
  isPinEncryptionConfigured,
  isPinEncryptionError,
  PinEncryptedContentIntegrityError,
  PinEnvelopeEncodingError,
  PinDecryptionError,
} from "./pin-encryption";

let checks = 0;
function assert(cond: boolean, label: string) {
  checks++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
}

// Fixed, not random: a test that generates its own key cannot fail the way a
// misconfigured env var does, and a fixed key makes a failure reproducible.
//
// 0xfb specifically, and the precondition below is not decoration. The first
// version used Buffer.alloc(32, 7), whose base64 is "BwcHBwcH..." and contains
// NEITHER + NOR /. The base64url case built from it by replacing + and / was
// therefore a no-op, the "key" was the valid key unchanged, and the assertion
// that a base64url key reads as unconfigured passed for the wrong reason in one
// direction and failed in the other. 0xfb encodes to "+/v7+/v7..." which carries
// both characters, and the precondition makes a future change to this constant
// fail loudly instead of quietly disarming the case.
const VALID_KEY = Buffer.alloc(32, 0xfb).toString("base64");
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

const originalKey = process.env.PIN_ENCRYPTION_KEY;
const setKey = (v: string | undefined) => {
  if (v === undefined) delete process.env.PIN_ENCRYPTION_KEY;
  else process.env.PIN_ENCRYPTION_KEY = v;
};

/** Build an envelope by hand, so a field can be malformed deliberately. */
function envelope(ivHex: string, tagHex: string, ctHex: string, version = "1") {
  return `${ALGORITHM}$${version}$${ivHex}$${tagHex}$${ctHex}`;
}

/** Encrypt arbitrary plaintext under the test key, bypassing the PIN shape gate. */
function rawEncrypt(plaintext: string) {
  const key = Buffer.from(VALID_KEY, "base64");
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ivHex: iv.toString("hex"), tagHex: c.getAuthTag().toString("hex"), ctHex: ct.toString("hex") };
}

function main() {
  setKey(VALID_KEY);
  try {
    // ---------------------------------------------------------------
    console.log("\n0. PRECONDITIONS on the test's own fixtures.");
    // ---------------------------------------------------------------
    // Without these, a later change to VALID_KEY can silently disarm the
    // base64url and padding cases below without any test going red.
    assert(
      VALID_KEY.includes("+") && VALID_KEY.includes("/"),
      "VALID_KEY's base64 contains both + and /, so the base64url case is a real substitution",
    );
    assert(
      VALID_KEY.endsWith("="),
      "VALID_KEY is padded, so the unpadded case is a real change",
    );
    assert(
      Buffer.from(VALID_KEY, "base64").length === 32,
      "VALID_KEY decodes to exactly 32 bytes",
    );

    // ---------------------------------------------------------------
    console.log("\n1. TAG LENGTH. A truncated auth tag must be rejected.");
    // ---------------------------------------------------------------
    // The hazard, quoted in the module from Rails: OpenSSL does not object to a
    // truncated tag, so a 4-byte tag leaves a 1-in-2^32 forgery instead of
    // 1-in-2^128. Prove Node's behaviour BOTH ways first, because which layer
    // protects us is version-dependent and the module's comment asserts it.
    {
      const key = Buffer.from(VALID_KEY, "base64");
      const iv = crypto.randomBytes(IV_BYTES);
      const c = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      const ct = Buffer.concat([c.update("123456", "utf8"), c.final()]);
      const fullTag = c.getAuthTag();

      // WITHOUT authTagLength, Node accepts a 4-byte tag and final() SUCCEEDS.
      let permissiveAccepted = false;
      try {
        const d = crypto.createDecipheriv(ALGORITHM, key, iv);
        d.setAuthTag(fullTag.subarray(0, 4));
        permissiveAccepted =
          Buffer.concat([d.update(ct), d.final()]).toString("utf8") === "123456";
      } catch {
        permissiveAccepted = false;
      }
      assert(
        permissiveAccepted,
        "raw Node WITHOUT authTagLength accepts a 4-byte tag and returns the real plaintext " +
          "(this is the hazard; if this ever fails, Node changed and the module comment needs re-probing)",
      );

      // WITH authTagLength, setAuthTag itself rejects short tags. This is the
      // primary control; the module's explicit length check is defence in depth.
      let optionRejected = false;
      try {
        const d = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        d.setAuthTag(fullTag.subarray(0, 4));
      } catch (e) {
        optionRejected = /authentication tag length/i.test((e as Error).message);
      }
      assert(
        optionRejected,
        "raw Node WITH authTagLength:16 rejects a 4-byte tag at setAuthTag (the primary control)",
      );
    }

    // Now the module. Every short tag length GCM permits must be refused, and
    // refused as an INTEGRITY error rather than a generic decrypt failure, so an
    // operator can tell a tampered envelope from a wrong key.
    for (const n of [4, 8, 12, 15]) {
      const { ivHex, tagHex, ctHex } = rawEncrypt("123456");
      const truncated = tagHex.slice(0, n * 2);
      const env = envelope(ivHex, truncated, ctHex);
      let err: unknown;
      try { decryptPin(env); } catch (e) { err = e; }
      assert(
        err instanceof PinEncryptedContentIntegrityError,
        `decryptPin refuses a ${n}-byte auth tag with a named integrity error`,
      );
      assert(isPinEnvelope(env) === false, `isPinEnvelope rejects a ${n}-byte auth tag`);
    }
    // And the boundary: a full 16-byte tag must still work, or the guard is just
    // rejecting everything.
    {
      const { ivHex, tagHex, ctHex } = rawEncrypt("123456");
      assert(decryptPin(envelope(ivHex, tagHex, ctHex)) === "123456",
        "a full 16-byte tag still decrypts (the guard is not rejecting everything)");
    }

    // ---------------------------------------------------------------
    console.log("\n2. HEX LENIENCY. Buffer.from stops at the first non-hex character.");
    // ---------------------------------------------------------------
    // The raw hazard, proven rather than asserted: Buffer.from returns the SHORT
    // PREFIX it managed, with no error. Unguarded, a corrupted envelope decodes
    // to a truncated key or tag instead of failing.
    {
      const lenient = Buffer.from("aabbZZcc", "hex");
      assert(
        lenient.length === 2,
        `Buffer.from("aabbZZcc","hex") silently yields ${lenient.length} bytes, not 4 (the hazard)`,
      );
      const oddLen = Buffer.from("abc", "hex");
      assert(
        oddLen.length === 1,
        `Buffer.from("abc","hex") silently drops the odd nibble, yielding ${oddLen.length} byte`,
      );
    }
    // The module must reject every such field rather than decode a prefix.
    {
      const good = rawEncrypt("123456");
      const cases: Array<[string, string]> = [
        ["IV with non-hex", envelope("aabbZZ" + "aa".repeat(9), good.tagHex, good.ctHex)],
        ["tag with non-hex", envelope(good.ivHex, "aabbZZ" + "bb".repeat(13), good.ctHex)],
        ["ciphertext with non-hex", envelope(good.ivHex, good.tagHex, "aaZZbb")],
        ["odd-length IV", envelope("abc", good.tagHex, good.ctHex)],
        ["uppercase hex IV", envelope("AA".repeat(IV_BYTES), good.tagHex, good.ctHex)],
        ["empty ciphertext field", envelope(good.ivHex, good.tagHex, "")],
      ];
      for (const [label, env] of cases) {
        let err: unknown;
        try { decryptPin(env); } catch (e) { err = e; }
        assert(
          err instanceof PinEnvelopeEncodingError,
          `decryptPin rejects ${label} as an encoding error, not a short decode`,
        );
        assert(isPinEnvelope(env) === false, `isPinEnvelope rejects ${label}`);
      }
    }

    // ---------------------------------------------------------------
    console.log("\n3. SIX-DIGIT RE-VALIDATION on the way OUT of decrypt.");
    // ---------------------------------------------------------------
    // A payload that decrypts AND authenticates correctly but is not a six-digit
    // PIN must be reported as a fault, never returned. This is the case that
    // cannot be caught on the way in: the envelope is valid, the tag verifies,
    // the bytes are genuinely what was stored. Constructed with the module's own
    // key so the tag is real, not forged.
    for (const bad of ["", "12345", "1234567", "12345a", "abcdef", "  1234", "12 345"]) {
      const { ivHex, tagHex, ctHex } = rawEncrypt(bad);
      const env = envelope(ivHex, tagHex, ctHex);
      let err: unknown;
      let returned: string | undefined;
      try { returned = decryptPin(env); } catch (e) { err = e; }
      assert(
        returned === undefined,
        `decryptPin does NOT return a non-PIN plaintext ${JSON.stringify(bad)}`,
      );
      assert(
        isPinEncryptionError(err),
        `decryptPin reports ${JSON.stringify(bad)} as a named encryption fault`,
      );
    }
    // The control: a genuine six-digit payload does come back.
    {
      const { ivHex, tagHex, ctHex } = rawEncrypt("000000");
      assert(decryptPin(envelope(ivHex, tagHex, ctHex)) === "000000",
        "a leading-zero PIN round-trips (the re-validation is not rejecting valid PINs)");
    }
    // A wrong key must be a DECRYPTION fault, distinct from the above, so the
    // two are not conflated in an operator's hands.
    {
      const { ivHex, tagHex, ctHex } = rawEncrypt("123456");
      setKey(Buffer.alloc(32, 9).toString("base64"));
      let err: unknown;
      try { decryptPin(envelope(ivHex, tagHex, ctHex)); } catch (e) { err = e; }
      assert(
        err instanceof PinDecryptionError || err instanceof PinEncryptedContentIntegrityError,
        "a wrong key is a decryption or integrity fault, distinct from a shape fault",
      );
      setKey(VALID_KEY);
    }

    // ---------------------------------------------------------------
    console.log("\n4. isPinEncryptionConfigured, the predicate the read side hangs on.");
    // ---------------------------------------------------------------
    // It must never throw, must not report a set-but-unusable key as configured,
    // and must not leak key material.
    const configCases: Array<[string, string | undefined, boolean]> = [
      ["a valid 32-byte key", VALID_KEY, true],
      ["a valid key with surrounding whitespace", `  ${VALID_KEY}  `, true],
      ["unset", undefined, false],
      ["empty string", "", false],
      ["whitespace only", "   ", false],
      ["base64url (- and _)", VALID_KEY.replace(/\+/g, "-").replace(/\//g, "_"), false],
      ["unpadded base64", VALID_KEY.replace(/=+$/, ""), false],
      ["16 bytes, too short", Buffer.alloc(16, 7).toString("base64"), false],
      ["64 bytes, too long", Buffer.alloc(64, 7).toString("base64"), false],
      ["a stray leading quote", `"${VALID_KEY}`, false],
      ["an embedded newline", VALID_KEY.slice(0, 20) + "\n" + VALID_KEY.slice(20), false],
    ];
    for (const [label, value, expected] of configCases) {
      setKey(value);
      let threw = false;
      let got: boolean | undefined;
      try { got = isPinEncryptionConfigured(); } catch { threw = true; }
      assert(!threw, `isPinEncryptionConfigured does not throw for ${label}`);
      assert(got === expected, `isPinEncryptionConfigured returns ${expected} for ${label}`);
    }
    // The reason a malformed key must read false: otherwise the read endpoint
    // proceeds and reports a decrypt fault about a row that is fine.
    {
      setKey(VALID_KEY.replace(/\+/g, "-").replace(/\//g, "_"));
      assert(
        isPinEncryptionConfigured() === false,
        "a present-but-unusable key reads as NOT configured, so the read side 503s " +
          "rather than blaming the data",
      );
      setKey(VALID_KEY);
    }
    // No key material in what it returns. A boolean cannot carry it, which is
    // the point of returning one; pinned so a future change to a richer return
    // type has to confront this.
    assert(
      typeof isPinEncryptionConfigured() === "boolean",
      "isPinEncryptionConfigured returns a bare boolean, so it cannot carry key material",
    );

    // ---------------------------------------------------------------
    console.log("\n5. Round trip, and the envelope's shape.");
    // ---------------------------------------------------------------
    {
      const env = encryptPin("428913");
      assert(decryptPin(env) === "428913", "encryptPin then decryptPin returns the same PIN");
      assert(isPinEnvelope(env) === true, "isPinEnvelope accepts a freshly minted envelope");
      const parts = env.split("$");
      assert(parts.length === 5, "the envelope has 5 dollar-separated fields");
      assert(parts[0] === ALGORITHM, "field 1 names the algorithm");
      assert(parts[2].length === IV_BYTES * 2, "the IV field is 12 bytes of hex");
      assert(parts[3].length === TAG_BYTES * 2, "the tag field is 16 bytes of hex");
      assert(/^[0-9a-f]+$/.test(parts[2] + parts[3] + parts[4]), "all hex fields are lowercase hex");
      // Two encryptions of the same PIN must differ, or the IV is being reused.
      assert(encryptPin("428913") !== encryptPin("428913"),
        "two encryptions of the same PIN differ (a fresh IV per call)");
    }

    // ---------------------------------------------------------------
    // Self-denominator. A silently dropped assertion is a failure, not a pass.
    // ---------------------------------------------------------------
    const total = checks;
    assert(total === 76, `all 76 checks ran, none skipped (ran ${total})`);
  } finally {
    setKey(originalKey);
  }

  console.log("\n=========================================");
  console.log(`  ${process.exitCode !== 1 ? "ALL TESTS PASS" : "ONE OR MORE TESTS FAILED"}`);
  console.log("=========================================");
}

main();
