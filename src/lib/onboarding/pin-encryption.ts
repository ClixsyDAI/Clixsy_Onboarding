// =============================================================
// PIN encryption module - reversible envelope for the stored PIN
// =============================================================
//
// Uses Node's built-in crypto AES-256-GCM. No external dependency.
//
// This module is the RECOVERY path, not the verification path.
// pin_hash (see ./pin.ts) stays the only thing verify-pin ever
// compares against. The envelope written here exists purely so an
// admin can be shown the PIN again instead of being forced to
// rotate it, which would lock out a client who already has it.
//
// Envelope format is self-describing, and is a deliberate sibling
// of the scrypt string in ./pin.ts:
//
//   pin.ts:      scrypt$<N>$<r>$<p>$<saltHex>$<derivedHex>
//   this module: aes-256-gcm$<version>$<ivHex>$<authTagHex>$<ciphertextHex>
//
// Same delimiter, same lowercase-hex encoding, algorithm named
// first. A reader who has seen one can read the other without a
// schema doc, and decryptPin can reject an unknown version instead
// of guessing at the layout.
//
// Hex rather than base64 is on purpose: it matches pin_hash, it has
// exactly one representation per byte string (so a round-trip check
// is trivial), and its alphabet cannot collide with the "$" field
// delimiter.
//
// Everything here either returns a real six-digit PIN or throws one
// of the typed errors below. There is no boolean, no null and no
// empty-string failure channel, because the caller that matters
// puts the result into an admin-facing response body: a silent ""
// would render as "the PIN is blank" rather than "the PIN could not
// be read".

import crypto from "node:crypto";

// Node's cipher name doubles as the on-wire algorithm tag, so the
// envelope always names the exact primitive that produced it.
const ALGORITHM = "aes-256-gcm";

// Bumped only when the field layout after the version changes. A
// future v2 (for example one binding the ciphertext to the session
// id as additional authenticated data) parses in its own branch of
// decryptPin, so rows written under v1 keep decrypting.
const ENVELOPE_VERSION = "1";

const KEY_LENGTH_BYTES = 32; // AES-256.
const IV_LENGTH_BYTES = 12; // 96-bit nonce, the GCM standard size.
const AUTH_TAG_LENGTH_BYTES = 16; // Full 128-bit tag, never truncated.

// A stored PIN is always exactly what ./pin.ts generates. Checked on
// the input to encryptPin AND on the plaintext out of decryptPin, so
// a row that decrypts to something other than a PIN is reported as a
// fault instead of being handed to an admin as if it were one.
const PIN_SHAPE = /^\d{6}$/;

// Buffer.from(x, "hex") is lenient: it stops at the first character
// outside the hex alphabet and returns the short prefix it managed
// to decode, with no error at all. That would silently turn a
// truncated auth tag into a shorter-but-valid-looking Buffer, so
// every hex field is regex-checked for a complete even-length hex
// string BEFORE it is decoded.
const HEX_FIELD = /^(?:[0-9a-f]{2})+$/;

// =============================================================
// Error taxonomy
// =============================================================
// Modelled on ActiveRecord::Encryption::Errors, which splits
// Configuration / Encoding / Decryption / EncryptedContentIntegrity
// into distinct classes.
//
// Rails then collapses all of them into one opaque public error so a
// remote attacker feeding it ciphertext learns nothing (an oracle).
// We keep them distinct on purpose, because the ciphertext here is
// never attacker-supplied: it comes out of our own
// onboarding_sessions column and is read only behind an
// authenticated admin endpoint. The distinction is the difference
// between two very different operator actions:
//
//   configuration -> PIN_ENCRYPTION_KEY is missing or wrong. Fix the
//                    env var, the stored data is fine.
//   decryption    -> the key changed since the row was written, so
//                    that row is unrecoverable. Regenerate the PIN.
//   integrity     -> the column was tampered with or truncated.
//
// The endpoint consuming these must still flatten them into one
// generic response so nothing about the key reaches a client.
//
// Each class carries a literal `code` as well as its identity.
// instanceof is unreliable when a bundler ends up with two copies of
// this module in one process (route handler plus server action), and
// a missed instanceof here would look like a successful read, so
// callers should branch on `code`.

export type PinEncryptionErrorCode =
  | "configuration"
  | "input"
  | "encoding"
  | "decryption"
  | "integrity";

/** Base class. Never thrown directly, only used for catch-all checks. */
export class PinEncryptionError extends Error {
  readonly code: PinEncryptionErrorCode;

  constructor(code: PinEncryptionErrorCode, message: string) {
    super(message);
    this.code = code;
    // Error.prototype.name is "Error" and subclasses do not override
    // it, so without this every one of these logs as a bare "Error"
    // and a server log cannot tell a bad env var from a bad row. A
    // bundler may still mangle the name, which is why `code` and not
    // this is the field callers branch on.
    this.name = new.target.name;
  }
}

/** PIN_ENCRYPTION_KEY is absent, not canonical base64, or not 32 bytes. */
export class PinEncryptionConfigurationError extends PinEncryptionError {
  constructor(message: string) {
    super("configuration", message);
  }
}

/** Caller passed something that is not a six-digit PIN to encryptPin. */
export class PinEncryptionInputError extends PinEncryptionError {
  constructor(message: string) {
    super("input", message);
  }
}

/** The envelope string is not in a layout this module can parse. */
export class PinEnvelopeEncodingError extends PinEncryptionError {
  constructor(message: string) {
    super("encoding", message);
  }
}

/** Well-formed envelope, but AES-GCM refused it: wrong key, tampered bytes. */
export class PinDecryptionError extends PinEncryptionError {
  constructor(message: string) {
    super("decryption", message);
  }
}

/**
 * The envelope's own integrity claims do not hold: a tag or IV of
 * the wrong length, or a plaintext that authenticated but is not a
 * PIN. Named after Rails' EncryptedContentIntegrity.
 */
export class PinEncryptedContentIntegrityError extends PinEncryptionError {
  constructor(message: string) {
    super("integrity", message);
  }
}

/**
 * Total type guard. Never throws, for any input, including null and
 * an error object that crossed a module boundary.
 */
export function isPinEncryptionError(
  value: unknown,
): value is PinEncryptionError {
  if (value instanceof PinEncryptionError) return true;
  // Duplicate-module fallback: same shape, different class identity.
  if (!(value instanceof Error)) return false;
  const code = (value as { code?: unknown }).code;
  return (
    code === "configuration" ||
    code === "input" ||
    code === "encoding" ||
    code === "decryption" ||
    code === "integrity"
  );
}

// =============================================================
// Key loading
// =============================================================

/**
 * Read PIN_ENCRYPTION_KEY and return the raw 32-byte key.
 *
 * Throws PinEncryptionConfigurationError on every failure and NEVER
 * returns a fallback or a zero key. A missing key must be impossible
 * to confuse with "this session has no stored PIN": those are
 * different answers for the caller (fix the deployment, versus
 * regenerate the PIN) and collapsing them would have an admin
 * rotating a client's working PIN to route around an unset env var.
 *
 * Read from process.env on every call rather than captured at module
 * scope, because module-scope capture makes the value unsettable by
 * anything that imports this file first, tests included.
 *
 * MODULE-PRIVATE ON PURPOSE. This is the only function here that ever
 * holds raw key material in its return value, so the narrower its
 * reach the better. Nothing outside this file needs a key: callers
 * need an envelope (encryptPin), a PIN (decryptPin), or a yes/no about
 * the deployment (isPinEncryptionConfigured, below). Exporting it
 * offered exactly one thing the module does not otherwise expose, "ask
 * whether the key is usable by calling this and catching", which put
 * the definition of a configuration fault in the caller. That is what
 * isPinEncryptionConfigured now owns. If a future caller genuinely
 * needs the bytes, that is a new function with a named purpose, not a
 * re-export of this one.
 */
function loadPinEncryptionKey(): Buffer {
  const raw = process.env.PIN_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new PinEncryptionConfigurationError(
      "PIN_ENCRYPTION_KEY is not set. Generate one with " +
        "require('crypto').randomBytes(32).toString('base64')",
    );
  }
  const trimmed = raw.trim();
  const key = Buffer.from(trimmed, "base64");

  // THIS IS A CANONICALISATION GATE, NOT A WRONG-KEY DETECTOR, and an earlier
  // version of this comment had the mechanism wrong. It claimed Buffer.from
  // "silently discards anything outside the base64 alphabet" so a base64url key
  // would decode to some DIFFERENT 32-byte value. Measured, that is false:
  //
  //   Buffer.from("-_", "base64").length === 1
  //
  // Node MAPS - and _ as base64url digits 62 and 63 rather than discarding them.
  // Only genuinely invalid characters are dropped (Buffer.from("!@","base64") is
  // empty). So a base64url key, an unpadded key, a newline-wrapped key and a key
  // with a stray leading quote all decode to bytes IDENTICAL to the real key.
  //
  // Which means rejecting them is a STRICTNESS CHOICE, not a safety one. It is
  // kept deliberately: one canonical spelling of the key is what makes "the value
  // in Vercel is the value this code uses" checkable by eye, and accepting four
  // spellings silently would make a genuine mismatch harder to spot later. But it
  // is not protecting against a wrong key, and the error message must not imply
  // that it is.
  //
  // The one variant that DOES decode to different bytes is non-canonical trailing
  // bits, where the final character encodes bits beyond the 32nd byte. That is
  // also caught here, and it is the only case where this check prevents a real
  // wrong-key deployment rather than enforcing a spelling.
  // The message names the LIKELY CAUSES, not just the rule it broke.
  // This check fails closed on keys whose 32 bytes are perfectly correct
  // but whose encoding is not byte-identical after a round trip: a
  // newline-wrapped value pasted from a terminal, a base64url variant
  // with - or _ substituted, or a missing '=' pad. Failing closed on
  // those is right, because none of them can be distinguished from a
  // genuinely wrong key without guessing. But an operator holding what
  // is in fact the correct key needs to be told WHERE to look, or the
  // message reads as "your key is wrong" when the real fault is a line
  // break the paste introduced.
  if (key.toString("base64") !== trimmed) {
    throw new PinEncryptionConfigurationError(
      "PIN_ENCRYPTION_KEY decodes to the right number of bytes but is not " +
        "canonical base64, so THE KEY ITSELF IS PROBABLY FINE and only its " +
        "spelling is wrong. Do not go looking for a wrong or rotated key. The " +
        "usual causes, in order: a line break or stray whitespace inside the " +
        "value, base64url characters (- or _) where + and / belong, a missing " +
        "'=' pad, or a quote picked up from a shell. Fix: re-encode the same " +
        "bytes as standard base64 with padding, on one line. If you are minting " +
        "a new key instead, use " +
        "require('crypto').randomBytes(32).toString('base64')",
    );
  }

  if (key.length !== KEY_LENGTH_BYTES) {
    throw new PinEncryptionConfigurationError(
      `PIN_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes ` +
        `for AES-256, got ${key.length}`,
    );
  }

  return key;
}

/**
 * Can this deployment encrypt and decrypt a PIN at all?
 *
 * The read endpoint fails CLOSED on an unconfigured key: a 503
 * configuration fault, distinct from "this session has no recoverable
 * copy, regenerate to populate". It needs somewhere to hang that
 * decision, and this is it.
 *
 * WHAT IT CHECKS, AND WHY IT IS NOT JUST PRESENCE. A set-but-unusable
 * key is NOT configured. Presence of the env var is the tempting test
 * and it is the wrong one: a base64url key, a half-pasted key or one
 * with a stray quote is present, so a presence check reports true, the
 * read endpoint then proceeds, and the caller gets a decrypt or
 * integrity error about a row that is in fact fine. That misdirects
 * whoever is debugging towards the data and away from the deployment.
 * So this runs the same validation the encrypt and decrypt paths run,
 * by attempting the load, and answers false for every configuration
 * fault: unset, non-canonical base64, and wrong decoded length.
 *
 * It cannot throw. A configuration fault is the answer, not an
 * exception, and an unexpected error is also answered as false, because
 * a predicate that throws is a predicate a caller has to wrap, which is
 * the pattern this function exists to remove.
 *
 * It returns no key material and logs nothing. The loaded key is
 * discarded unread. The REASON for a false is deliberately not exposed:
 * the three faults all mean the same thing to the endpoint, one 503,
 * and keeping the distinction inside the module stops the response
 * becoming a configuration oracle. An operator gets the specific reason
 * from the encrypt path's own thrown message, which names which of the
 * three it was.
 */
/**
 * The states a session's PIN can be in, from the caller's point of view.
 *
 * `no_gate`             no PIN protects this session at all. pin_hash is absent.
 * `recoverable`         a PIN exists AND a structurally valid copy is stored.
 * `unrecoverable`       a PIN exists and there is NO envelope at all: the column
 *                       is NULL, absent, or blank. Written before this feature,
 *                       or written while the key was unset. The remedy is to
 *                       regenerate, which changes the PIN the client holds.
 * `envelope_unreadable` a PIN exists and SOMETHING is stored, but it is not a
 *                       well-formed envelope. This is corrupt or foreign data,
 *                       NOT a missing copy, and regenerating would destroy
 *                       whatever it is before anyone looked at it.
 *
 * WHY THE FOURTH STATE EXISTS, since three would look tidier. A critic found
 * that folding it into `unrecoverable` made this endpoint tell an operator that
 * a corrupt row "predates this feature" and should be regenerated. Both halves
 * were false and the advice was the destructive one. Measured, every one of
 * these landed on `unrecoverable` with no log line: a bumped version prefix, a
 * 4-byte auth tag, a wrong-length IV, non-hex fields, and the strings "hello"
 * and "   ".
 *
 * The sharpest way in is a rolling deploy after an ENVELOPE_VERSION bump. Old
 * instances would report every row the new instances minted as "predates this
 * feature, regenerate", silently and at scale, while `decryptPin` would have
 * rejected the unknown version correctly if it had ever been asked.
 *
 * Note the migration disagrees with the old taxonomy too, in the same place.
 * 011_pin_envelope.sql defines its state (c) as `pin_envelope IS NOT NULL`, so
 * its own census counts a corrupt row as recoverable, and it deliberately
 * declines a shape CHECK on the grounds that this module validates every field.
 * That is only true if this module is actually asked, which is what the fourth
 * state guarantees.
 */
export type PinState =
  | "no_gate"
  | "recoverable"
  | "unrecoverable"
  | "envelope_unreadable";

/**
 * Classify a session row's PIN state in ONE place.
 *
 * Extracted because keeping these three apart needs BOTH columns and got
 * hand-rolled at every call site, which is how two of them end up disagreeing.
 * A caller that tests only `pin_envelope` cannot tell `no_gate` from
 * `unrecoverable`, and those have opposite remedies: one is "this session was
 * never gated", the other is "regenerate and tell the client their PIN changed".
 *
 * THE INTERFACE IS KNOWN-STALE AND THAT IS WHY THIS TAKES A LOOSE SHAPE.
 * `OnboardingSession` is hand-maintained and has lagged the real schema since
 * before this feature; the standing instruction on this repo is to trust
 * supabase/migrations over the interface. So the parameter is widened to
 * `string | null | undefined` rather than narrowed to match the interface, and
 * undefined and null are treated IDENTICALLY: both mean "no envelope here". DO
 * NOT narrow this back to `string | null`. The looser type is the accurate one,
 * and narrowing it reintroduces the `!== null` bug that reports an absent
 * envelope as recoverable.
 *
 * ONE THING THIS COMMENT USED TO CLAIM AND SHOULD NOT HAVE. It said the
 * `undefined` arrives from a database where migration 011 has not been applied.
 * That is wrong for the caller that matters: the reveal endpoint selects
 * `pin_envelope` by name, and PostgREST answers a missing column with 400 /
 * 42703, so the route returns `session_read_failed` and never reaches this
 * function. Measured against a simulated 42703. The widening is still correct,
 * because a caller with a `select("*")` or a hand-built row object CAN deliver
 * `undefined`, but the specific provenance named here was not verified and was
 * not real. Keep the defence, drop the story.
 *
 * Structural only. It does NOT decrypt and does not touch the key, so it is safe
 * to call before the configuration gate and says nothing about whether this
 * deployment can actually read the envelope.
 */
export function classifyPinState(row: {
  pin_hash?: string | null;
  pin_envelope?: string | null;
}): PinState {
  const hash = typeof row?.pin_hash === "string" ? row.pin_hash.trim() : "";
  if (hash.length === 0) return "no_gate";

  // A positive test on the VALUE, never `!== null`: undefined must not pass.
  if (isPinEnvelope(row?.pin_envelope)) return "recoverable";

  // NOTHING THERE vs SOMETHING BROKEN. These have opposite remedies, so the
  // absence test is explicit rather than "whatever did not parse".
  //
  // Blank counts as absent, matching the pin_hash trim above: a column holding
  // "" or "   " has no envelope in it by any reading, and regenerating IS the
  // right remedy. Anything else that is present and does not parse is corrupt,
  // including a non-string, which means something wrote a shape nobody expected.
  const env = row?.pin_envelope;
  const absent = env === null || env === undefined ||
    (typeof env === "string" && env.trim().length === 0);
  return absent ? "unrecoverable" : "envelope_unreadable";
}

export function isPinEncryptionConfigured(): boolean {
  try {
    loadPinEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

// =============================================================
// Encrypt
// =============================================================

/**
 * Encrypt a six-digit PIN into a self-describing envelope string.
 *
 * A fresh random IV per call. Reusing one IV under a single AES-GCM
 * key is catastrophic: it leaks the XOR of the two plaintexts and
 * the authentication subkey, and against a six-digit plaintext space
 * that XOR recovers the PIN outright. So the IV is never derived
 * from anything, which is also why the deterministic mode in Rails'
 * cipher/aes256_gcm.rb (which HMACs the plaintext into the IV) is
 * NOT copied here.
 */
export function encryptPin(pin: string): string {
  if (typeof pin !== "string" || !PIN_SHAPE.test(pin)) {
    throw new PinEncryptionInputError(
      "encryptPin: PIN must be exactly 6 digits",
    );
  }

  const key = loadPinEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  const ciphertext = Buffer.concat([
    cipher.update(pin, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    ALGORITHM,
    ENVELOPE_VERSION,
    iv.toString("hex"),
    authTag.toString("hex"),
    ciphertext.toString("hex"),
  ].join("$");
}

// =============================================================
// Parse + decrypt
// =============================================================

type ParsedEnvelope = {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
};

/**
 * Structural validation, done in full BEFORE any key material or
 * cipher object is touched. Throws on anything unexpected.
 */
function parseEnvelope(envelope: unknown): ParsedEnvelope {
  if (typeof envelope !== "string" || envelope.length === 0) {
    throw new PinEnvelopeEncodingError(
      "PIN envelope is not a non-empty string",
    );
  }

  const parts = envelope.split("$");
  if (parts.length !== 5) {
    throw new PinEnvelopeEncodingError(
      `PIN envelope must have 5 dollar-separated fields, got ${parts.length}`,
    );
  }

  const [algorithm, version, ivHex, authTagHex, ciphertextHex] = parts;

  if (algorithm !== ALGORITHM) {
    throw new PinEnvelopeEncodingError(
      `Unknown PIN envelope algorithm: ${JSON.stringify(algorithm)}`,
    );
  }
  if (version !== ENVELOPE_VERSION) {
    throw new PinEnvelopeEncodingError(
      `Unknown PIN envelope version: ${JSON.stringify(version)}`,
    );
  }

  const hexFields = [
    ["IV", ivHex],
    ["auth tag", authTagHex],
    ["ciphertext", ciphertextHex],
  ] as const;
  for (const [label, field] of hexFields) {
    if (!HEX_FIELD.test(field)) {
      throw new PinEnvelopeEncodingError(
        `PIN envelope ${label} is not complete even-length lowercase hex`,
      );
    }
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  // Quoting the reasoning from Rails, cipher/aes256_gcm.rb:61-64,
  // because Node has the identical hazard:
  //
  //   "Currently the OpenSSL bindings do not raise an error if
  //    auth_tag is truncated, which would allow an attacker to
  //    easily forge it. See https://github.com/ruby/openssl/issues/63"
  //
  // Node has the same hazard, but ONLY when authTagLength is omitted.
  // An earlier version of this comment claimed the option "constrains
  // what setAuthTag will accept but the short-tag lengths stay legal".
  // That is false, and it is worth saying so rather than silently
  // rewriting, because this file has already carried one fabricated
  // claim about a runtime.
  //
  // MEASURED, not assumed. Probe: encrypt a 6-digit PIN, take the real
  // 16-byte tag, and hand truncations of it to createDecipheriv.
  //
  //   with { authTagLength: 16 }   4B/8B/12B/15B -> setAuthTag THROWS
  //                                "Invalid authentication tag length: N"
  //                                16B           -> accepted
  //   without the option          4B/8B/12B/15B -> ACCEPTED, and final()
  //                                SUCCEEDS, returning the real plaintext
  //
  // So a 4-byte tag on the permissive path leaves a 1-in-2^32 forgery
  // instead of 1-in-2^128, and the option is what closes it. Node also
  // emits DEP0182 deprecating the permissive path, which is confirmation
  // that omitting the option is the unsafe spelling rather than a
  // neutral one.
  //
  // VERSIONS, because this is runtime behaviour and the numbers differ.
  // Probed on Node v24.15.0 locally. The clixsy-onboarding Vercel project
  // is configured for Node 24.x, so the same major, but the exact patch
  // running in a given deployment is not observable from here and was NOT
  // probed. Same-major is the strongest claim this comment can make; if
  // that runtime is ever changed to a different major, re-run the probe
  // rather than trusting these lines.
  //
  // The explicit check below is therefore DEFENCE IN DEPTH, not the
  // primary control. The option above it is the control. The check
  // survives an accidental removal of the option, and turns what would
  // be a silent weakening into a named error.
  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new PinEncryptedContentIntegrityError(
      `PIN envelope auth tag must be exactly ${AUTH_TAG_LENGTH_BYTES} bytes, ` +
        `got ${authTag.length}`,
    );
  }

  // Same class of problem one field over: GCM accepts a nonce of
  // almost any length, so a mangled IV does not fail here. It fails
  // later as a tag mismatch that is indistinguishable from a wrong
  // key, and gets misreported as "the key changed".
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new PinEncryptedContentIntegrityError(
      `PIN envelope IV must be exactly ${IV_LENGTH_BYTES} bytes, ` +
        `got ${iv.length}`,
    );
  }

  // No empty-ciphertext check here on purpose. HEX_FIELD is
  // /^(?:[0-9a-f]{2})+$/, one-or-more, so an empty ciphertext field has
  // already failed the hex check a block above and never reaches this
  // point. A guard that cannot fire reads as a live defence and is not
  // one, which is worse than its absence: the next person changing
  // HEX_FIELD would not know this depended on it. The dependency is
  // stated instead. If HEX_FIELD is ever loosened to allow an empty
  // match, restore an explicit length check here.

  return { iv, authTag, ciphertext };
}

/**
 * Total predicate: does this value parse as an envelope this module
 * could attempt to decrypt? Never throws, for any input. Says
 * nothing about whether the current key can actually decrypt it.
 *
 * Total by construction (catch everything), not by enumerating what
 * to catch. parseEnvelope raises a taxonomy that is still growing
 * (input, encoding, integrity, decryption), so an enumerated catch
 * here would silently stop being total the next time a code is
 * added. A probe that can throw is a probe every caller has to wrap.
 */
export function isPinEnvelope(value: unknown): boolean {
  try {
    parseEnvelope(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decrypt an envelope back to the six-digit PIN.
 *
 * Returns a validated PIN or throws. Every failure path above and
 * below is a throw, so the return value can never be "", null or
 * undefined: the caller renders this straight into an admin
 * response, where a blank string reads as a blank PIN.
 */
export function decryptPin(envelope: unknown): string {
  // THE KEY IS LOADED FIRST, BEFORE THE ROW IS JUDGED. The order matters and it
  // used to be the other way round.
  //
  // With parseEnvelope first, an unconfigured deployment reported whatever the
  // ROW happened to be wrong about: a malformed row came back as an `encoding`
  // fault and a short-tag row as an `integrity` fault, when the actual fault was
  // that nothing on this deployment can decrypt anything at all. That is a
  // missing key masquerading as a state of the data, and a caller reading the
  // error code would blame the row and go looking for corruption.
  //
  // Fixing it only at the read endpoint's gate would leave the trap armed for
  // every future caller of this function, so it is fixed here. You cannot
  // meaningfully judge a row when the deployment has no usable key: configuration
  // is a strictly more fundamental fault and now always wins.
  //
  // The endpoint gates on isPinEncryptionConfigured() as well. Two independent
  // checks is the point, not redundancy: this one guarantees the fault CODE is
  // right for every caller, the endpoint's guarantees it never reaches a row it
  // cannot read. A late env change between the gate and this call still surfaces
  // as `configuration` rather than as a row problem.
  const key = loadPinEncryptionKey();
  const { iv, authTag, ciphertext } = parseEnvelope(envelope);

  let plaintext: string;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      // Throws if the tag does not verify. This is the call that
      // makes a wrong key or a flipped bit an error instead of
      // garbage output, so it is never skipped and its result is
      // always concatenated.
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    // Wrong key, tampered ciphertext, tag mismatch. Collapsed into
    // one error on purpose: the underlying OpenSSL text varies by
    // build and says nothing the caller can act on differently,
    // since the remedy for all of them is to regenerate the PIN.
    throw new PinDecryptionError(
      `Failed to decrypt PIN envelope: ${
        err instanceof Error ? err.message : "unknown cipher error"
      }`,
    );
  }

  // The tag verified, so this really was written under our key, but a
  // plaintext that is not a PIN means the column holds something
  // else. Better a loud fault than handing an admin a "PIN" of "".
  if (!PIN_SHAPE.test(plaintext)) {
    throw new PinEncryptedContentIntegrityError(
      "Decrypted PIN envelope did not contain a 6-digit PIN",
    );
  }

  return plaintext;
}
