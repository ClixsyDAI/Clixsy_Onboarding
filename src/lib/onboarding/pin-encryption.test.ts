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
// MUTATION-TESTED. The table below is a RECORD OF DELETING EACH GUARD AND
// RE-RUNNING, not a claim about coverage. Every row was produced by disabling
// that guard in the source and observing this suite. Re-run it the same way if you
// change either file:
//
//   guard disabled                             result    failing assertions
//   -----------------------------------------  --------  ------------------
//   key presence (PIN_ENCRYPTION_KEY unset)    RED        5
//   base64 canonical round-trip                RED        5
//   key length (32 bytes)                      RED        2
//   envelope typeof string / non-empty         RED        7
//   field count === 5                          RED        2
//   algorithm match                            RED        3
//   version match                              RED        3
//   HEX_FIELD (loosened to /^[0-9a-zA-Z]*$/)   RED       11
//   auth-tag length check                      RED        9
//   IV length check                            RED       10
//   encryptPin input shape                     RED       12
//   six-digit re-validation on the way OUT     RED       16
//   configuration-before-structure ordering    RED        3
//   -----------------------------------------  --------  ------------------
//   authTagLength option on createDecipheriv   GREEN      0   <- see below
//
// 14 mutations, 13 RED, 1 GREEN. The pristine suite was confirmed GREEN first,
// since otherwise every row above is meaningless, and the source was verified
// byte-identical to pristine afterwards.
//
// THE ONE GREEN ROW IS STRUCTURAL AND IS THE ONLY ACCEPTED EXCEPTION. The
// explicit auth-tag length check lives in parseEnvelope and runs BEFORE
// createDecipheriv is constructed, so a short tag never reaches the option and
// its presence has no observable behaviour to assert. That is what defence in
// depth means here, and it is also how someone could delete the option as
// "unused" with nothing going red. Its presence is held by the comment at its
// call site and by review, NOT by this suite. Pinning it would need source
// inspection rather than behaviour, which is a worse test to fake. If the
// explicit check is ever removed in favour of the option, this suite starts
// covering it and this note should go.
//
// WHY THIS TABLE IS A TABLE AND NOT A SENTENCE. An earlier version of this header
// asserted "mutation-tested, with one gap". Six of the guards above were in fact
// uncovered at the time, and the claim was believed BECAUSE it admitted one
// exception: conceding the authTagLength gap made the surrounding sentence read
// as careful. It was not. A stated limitation verifies nothing next to it. The
// per-guard result is recorded so the claim cannot drift from the code again
// without somebody noticing which row is wrong.

import crypto from "node:crypto";
import {
  encryptPin,
  decryptPin,
  isPinEnvelope,
  isPinEncryptionConfigured,
  classifyPinState,
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
    console.log("\n2b. STRUCTURAL GUARDS. Each was uncovered until a critic checked.");
    // ---------------------------------------------------------------
    // These six had NO assertions. Every one is a real behaviour change when
    // removed, proven before these tests were written:
    //   typeof/non-empty gone  -> decryptPin(null) throws an untyped TypeError
    //   field count gone       -> a trailing 6th field is silently ignored
    //   algorithm gone         -> "rot13$1$..." decrypts as aes-256-gcm
    //   version gone           -> version "99" decrypts
    //   IV length gone         -> an 11, 13 or 1-byte IV envelope RETURNS "123456"
    //   encryptPin input gone  -> encryptPin("abc") mints a non-PIN envelope
    // Each asserts the EXACT error class, not the loose predicate, so a guard
    // being replaced by a different one that happens to reject is still caught.
    {
      const good = rawEncrypt("123456");
      const okEnv = envelope(good.ivHex, good.tagHex, good.ctHex);

      // typeof / non-empty. Untyped throws are the failure being prevented:
      // isPinEncryptionError() returns false for a TypeError, so a caller's
      // fault-code branch silently stops firing.
      for (const [label, input] of [
        ["null", null], ["undefined", undefined], ["a number", 42],
        ["an object", {}], ["an array", []], ["the empty string", ""],
        ["a Buffer", Buffer.from("x")], ["a String wrapper", new String(okEnv)],
      ] as Array<[string, unknown]>) {
        let err: unknown;
        try { decryptPin(input); } catch (e) { err = e; }
        assert(
          err instanceof PinEnvelopeEncodingError,
          `decryptPin rejects ${label} with a TYPED encoding error, not a raw TypeError`,
        );
      }

      // Field count. A trailing field must not be ignored.
      for (const [label, env] of [
        ["a 6th trailing field", `${okEnv}$deadbeef`],
        ["only 4 fields", `${ALGORITHM}$1$${good.ivHex}$${good.tagHex}`],
        ["only 1 field", ALGORITHM],
        ["an empty trailing field", `${okEnv}$`],
      ] as Array<[string, string]>) {
        let err: unknown;
        try { decryptPin(env); } catch (e) { err = e; }
        assert(
          err instanceof PinEnvelopeEncodingError,
          `decryptPin rejects ${label} on field count`,
        );
      }

      // Algorithm and version. Both must be matched, not merely present.
      for (const [label, env] of [
        ["a wrong algorithm", `rot13$1$${good.ivHex}$${good.tagHex}$${good.ctHex}`],
        ["an empty algorithm", `$1$${good.ivHex}$${good.tagHex}$${good.ctHex}`],
        ["aes-128-gcm", `aes-128-gcm$1$${good.ivHex}$${good.tagHex}$${good.ctHex}`],
        ["an unknown version 99", envelope(good.ivHex, good.tagHex, good.ctHex, "99")],
        ["a non-numeric version", envelope(good.ivHex, good.tagHex, good.ctHex, "x")],
        ["an empty version", envelope(good.ivHex, good.tagHex, good.ctHex, "")],
      ] as Array<[string, string]>) {
        let err: unknown;
        try { decryptPin(env); } catch (e) { err = e; }
        assert(
          err instanceof PinEnvelopeEncodingError,
          `decryptPin rejects ${label}`,
        );
      }

      // IV LENGTH. The worst of the six: without it, a short-IV envelope built
      // with a matching short IV decrypts and RETURNS the PIN. GCM accepts almost
      // any nonce length, so this cannot be left to the cipher.
      for (const n of [1, 8, 11, 13, 16]) {
        const iv = crypto.randomBytes(n);
        const key = Buffer.from(VALID_KEY, "base64");
        const c = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        const ct = Buffer.concat([c.update("123456", "utf8"), c.final()]);
        const env = envelope(iv.toString("hex"), c.getAuthTag().toString("hex"), ct.toString("hex"));
        let err: unknown;
        let returned: string | undefined;
        try { returned = decryptPin(env); } catch (e) { err = e; }
        assert(returned === undefined, `a ${n}-byte IV does not decrypt to a PIN`);
        assert(
          err instanceof PinEncryptedContentIntegrityError,
          `decryptPin rejects a ${n}-byte IV as an integrity fault`,
        );
      }

      // encryptPin's input gate. Without it a non-PIN is minted and stored, and
      // the fault only surfaces later on the way out, at a different site.
      for (const bad of ["", "abc", "12345", "1234567", "12345a", "１２３４５６"]) {
        let err: unknown;
        let minted: string | undefined;
        try { minted = encryptPin(bad); } catch (e) { err = e; }
        assert(minted === undefined, `encryptPin refuses to mint from ${JSON.stringify(bad)}`);
        assert(
          isPinEncryptionError(err) && (err as { code: string }).code === "input",
          `encryptPin reports ${JSON.stringify(bad)} as an INPUT fault`,
        );
      }

      // Key presence, and the fault code the read endpoint's 503 depends on.
      // Without this guard an unset key throws an untyped TypeError, so
      // isPinEncryptionError is false and errorCode degrades to "unknown".
      setKey(undefined);
      for (const [label, run] of [
        ["encryptPin", () => encryptPin("123456")],
        ["decryptPin", () => decryptPin(okEnv)],
      ] as Array<[string, () => unknown]>) {
        let err: unknown;
        try { run(); } catch (e) { err = e; }
        assert(
          isPinEncryptionError(err) && (err as { code: string }).code === "configuration",
          `${label} with no key reports code "configuration", the code the 503 hangs on`,
        );
      }
      // AND THE ORDERING. Configuration must beat a row-level fault, or a missing
      // key masquerades as a state of the data and a caller blames corruption.
      for (const [label, env] of [
        ["a malformed row", envelope(good.ivHex, good.tagHex, "ZZ")],
        ["a short-tag row", envelope(good.ivHex, "bb".repeat(4), good.ctHex)],
        ["a wrong-algorithm row", `rot13$1$${good.ivHex}$${good.tagHex}$${good.ctHex}`],
      ] as Array<[string, string]>) {
        let err: unknown;
        try { decryptPin(env); } catch (e) { err = e; }
        assert(
          (err as { code?: string })?.code === "configuration",
          `with no key, ${label} reports "configuration", NOT a row fault`,
        );
      }
      setKey(VALID_KEY);
      // Control: with a key set, those same rows report their OWN faults again.
      {
        let a: unknown, b: unknown;
        try { decryptPin(envelope(good.ivHex, good.tagHex, "ZZ")); } catch (e) { a = e; }
        try { decryptPin(envelope(good.ivHex, "bb".repeat(4), good.ctHex)); } catch (e) { b = e; }
        assert((a as { code?: string })?.code === "encoding",
          "with a key set, a malformed row reports encoding again (ordering did not swallow it)");
        assert((b as { code?: string })?.code === "integrity",
          "with a key set, a short-tag row reports integrity again");
      }
    }

    // ---------------------------------------------------------------
    console.log("\n2c. classifyPinState. undefined and null must be identical.");
    // ---------------------------------------------------------------
    {
      const valid = encryptPin("123456");
      const cases: Array<[string, Parameters<typeof classifyPinState>[0], string]> = [
        ["no pin_hash key at all", {}, "no_gate"],
        ["pin_hash null", { pin_hash: null }, "no_gate"],
        ["pin_hash whitespace", { pin_hash: "   " }, "no_gate"],
        ["hash set, envelope UNDEFINED (unmigrated db)", { pin_hash: "scrypt$x" }, "unrecoverable"],
        ["hash set, envelope null", { pin_hash: "scrypt$x", pin_envelope: null }, "unrecoverable"],
        ["hash set, envelope empty string", { pin_hash: "scrypt$x", pin_envelope: "" }, "unrecoverable"],
        ["hash set, envelope whitespace only", { pin_hash: "scrypt$x", pin_envelope: "   " }, "unrecoverable"],
        ["hash set, envelope valid", { pin_hash: "scrypt$x", pin_envelope: valid }, "recoverable"],
        ["no gate but an envelope present", { pin_envelope: valid }, "no_gate"],

        // THE FOURTH STATE. Every row below used to classify as "unrecoverable",
        // which made the reveal endpoint answer 200 and tell an operator the row
        // "predates this feature" and should be regenerated. Both halves false,
        // and the advice destructive. These are PRESENT and BROKEN, which is a
        // different fact with a different remedy.
        ["envelope: version bumped", { pin_hash: "scrypt$x", pin_envelope: "aes-256-gcm$2$" + "0".repeat(24) + "$" + "0".repeat(32) + "$" + "0".repeat(32) }, "envelope_unreadable"],
        ["envelope: auth tag too short", { pin_hash: "scrypt$x", pin_envelope: "aes-256-gcm$1$" + "0".repeat(24) + "$" + "0".repeat(8) + "$" + "0".repeat(32) }, "envelope_unreadable"],
        ["envelope: iv wrong length", { pin_hash: "scrypt$x", pin_envelope: "aes-256-gcm$1$" + "0".repeat(10) + "$" + "0".repeat(32) + "$" + "0".repeat(32) }, "envelope_unreadable"],
        ["envelope: non-hex fields", { pin_hash: "scrypt$x", pin_envelope: "aes-256-gcm$1$" + "z".repeat(24) + "$" + "z".repeat(32) + "$" + "z".repeat(32) }, "envelope_unreadable"],
        ["envelope: wrong algorithm name", { pin_hash: "scrypt$x", pin_envelope: "aes-128-gcm$1$" + "0".repeat(24) + "$" + "0".repeat(32) + "$" + "0".repeat(32) }, "envelope_unreadable"],
        ["envelope: too few fields", { pin_hash: "scrypt$x", pin_envelope: "aes-256-gcm$1$abc" }, "envelope_unreadable"],
        ["envelope: the string 'hello'", { pin_hash: "scrypt$x", pin_envelope: "hello" }, "envelope_unreadable"],
        ["envelope: a number", { pin_hash: "scrypt$x", pin_envelope: 12345 as unknown as string }, "envelope_unreadable"],
        ["envelope: an object", { pin_hash: "scrypt$x", pin_envelope: {} as unknown as string }, "envelope_unreadable"],
        ["envelope: an array", { pin_hash: "scrypt$x", pin_envelope: [] as unknown as string }, "envelope_unreadable"],
      ];
      for (const [label, row, want] of cases) {
        assert(classifyPinState(row) === want, `classifyPinState: ${label} -> ${want}`);
      }

      // THE SPLIT ITSELF, asserted as a property rather than only per-case, so a
      // future change that folds the two back together fails here even if
      // someone updates the table above to match the new behaviour.
      const absentRows = [
        { pin_hash: "scrypt$x", pin_envelope: null },
        { pin_hash: "scrypt$x", pin_envelope: "" },
        { pin_hash: "scrypt$x" },
      ];
      const corruptRows = [
        { pin_hash: "scrypt$x", pin_envelope: "hello" },
        { pin_hash: "scrypt$x", pin_envelope: "aes-256-gcm$2$" + "0".repeat(24) + "$" + "0".repeat(32) + "$" + "0".repeat(32) },
      ];
      const absentStates = new Set(absentRows.map((r) => classifyPinState(r)));
      const corruptStates = new Set(corruptRows.map((r) => classifyPinState(r)));
      assert(
        absentStates.size === 1 && corruptStates.size === 1,
        "each group classifies consistently within itself",
      );
      assert(
        [...absentStates][0] !== [...corruptStates][0],
        "AN ABSENT ENVELOPE AND A CORRUPT ONE MUST NOT SHARE A STATE: they carry " +
          "opposite remedies and one of them is destructive",
      );
      // The specific bug the helper exists to prevent.
      assert(
        classifyPinState({ pin_hash: "scrypt$x" }) ===
          classifyPinState({ pin_hash: "scrypt$x", pin_envelope: null }),
        "an unmigrated row (undefined) classifies IDENTICALLY to an explicit null",
      );
      // It must not touch the key, so it stays usable before the config gate.
      setKey(undefined);
      let threw = false;
      try { classifyPinState({ pin_hash: "scrypt$x", pin_envelope: valid }); } catch { threw = true; }
      assert(!threw, "classifyPinState works with no key configured (it is structural only)");
      setKey(VALID_KEY);
    }

    // ---------------------------------------------------------------
    console.log("\n3. SIX-DIGIT RE-VALIDATION on the way OUT of decrypt.");
    // ---------------------------------------------------------------
    // A payload that decrypts AND authenticates correctly but is not a six-digit
    // PIN must be reported as a fault, never returned. This is the case that
    // cannot be caught on the way in: the envelope is valid, the tag verifies,
    // the bytes are genuinely what was stored. Constructed with the module's own
    // key so the tag is real, not forged.
    // "" IS DELIBERATELY EXCLUDED, and that exclusion is the fix for a
    // misattribution a critic found. rawEncrypt("") yields an EMPTY CIPHERTEXT
    // FIELD, which HEX_FIELD rejects as an encoding fault before any key or tag
    // is touched. It was in this list, labelled as a case where "the envelope is
    // valid and the tag verifies", which was false: it is section 2's own
    // empty-ciphertext case wearing section 3's label, and it SURVIVED deleting
    // the six-digit re-validation while claiming to test it. Section 2 covers it.
    //
    // The exact class is pinned, not the loose isPinEncryptionError predicate, so
    // a case that reaches this point for the wrong reason fails instead of
    // passing. That loose predicate is what let the "" case hide.
    for (const bad of ["12345", "1234567", "12345a", "abcdef", "  1234", "12 345", "0", "1234567890"]) {
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
        err instanceof PinEncryptedContentIntegrityError,
        `decryptPin reports ${JSON.stringify(bad)} as an INTEGRITY fault, ` +
          `which is only reachable AFTER the tag verified`,
      );
    }
    // And prove the exclusion is honest: "" really does fail earlier, as encoding.
    {
      const { ivHex, tagHex } = rawEncrypt("");
      let err: unknown;
      try { decryptPin(envelope(ivHex, tagHex, "")); } catch (e) { err = e; }
      assert(
        err instanceof PinEnvelopeEncodingError,
        'the "" case is an ENCODING fault caught by HEX_FIELD, which is why it is not in the list above',
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
    assert(total === 149, `all 149 checks ran, none skipped (ran ${total})`);
  } finally {
    setKey(originalKey);
  }

  console.log("\n=========================================");
  console.log(`  ${process.exitCode !== 1 ? "ALL TESTS PASS" : "ONE OR MORE TESTS FAILED"}`);
  console.log("=========================================");
}

main();
