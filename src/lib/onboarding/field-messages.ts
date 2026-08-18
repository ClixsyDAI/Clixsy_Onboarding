// =============================================================
// field-messages — client-facing validation copy
// =============================================================
//
// WHY THIS EXISTS
//
// The public onboarding form showed clients the validator's own words.
// Measured on production 2026-08-17, after pressing Next on step 1 with
// three required fields untouched, all three read:
//
//   "Invalid input: expected string, received undefined"
//
// The schemas in steps-v2.ts DO carry human messages -- 'Title/Role is
// required', 'Please enter a valid email'. They never fired. Those are
// attached to `.min(1, msg)`, which only runs once a string is present;
// a field the client has not touched is `undefined`, fails the type
// check first, and emits Zod's default text. So the copy existed and
// the common case skipped past it.
//
// The fix is to build the message from the FIELD, at the point where
// issues are converted into the errors map, and to never pass
// `issue.message` through. That has two properties worth keeping:
//
//   1. Consistency. Every render site -- the six control types in
//      StepRenderer, the confirmation-pattern variant, and the
//      access-checklist select -- reads the same errors map, so they
//      all inherit this copy and the aria wiring added alongside it.
//   2. It closes the class, not the instance. A schema authored later
//      without a custom message cannot leak validator text, because no
//      path returns validator text.
//
// The label is resolved per vertical, matching `labelFor` in
// StepRenderer, so the error names the field the client is actually
// looking at rather than the default label.

import type { OnboardingField, VerticalId } from "./steps";

/** Minimal shape we read off a Zod issue. Deliberately loose: Zod v3 and
 *  v4 name these differently (`validation` vs `format`), and this must
 *  not break on an upgrade. Anything unrecognised falls through to the
 *  generic human message, never to the raw one. */
export interface ValidationIssueLike {
  code?: string;
  message?: string;
  format?: string;
  validation?: string;
  received?: unknown;
}

/** The label the CLIENT sees, which is what the error should name. */
export function visibleLabel(field: OnboardingField, vertical?: VerticalId): string {
  return (vertical && field.labelByVertical?.[vertical]) || field.label;
}

const isQuestion = (label: string) => /\?\s*$/.test(label.trim());

/**
 * Labels that are already a sentence addressed to the client -- "List your
 * target cities/areas", "Describe what success looks like" -- cannot be
 * dropped into "Enter your ___." The first draft did exactly that and the
 * test caught "Enter your list your target cities/areas."
 */
const IMPERATIVE_OR_INTERROGATIVE =
  /^(list|describe|tell|add|select|choose|enter|upload|provide|share|explain|confirm|what|who|when|where|why|how|do|does|did|are|is|was|have|has|can|would|should)\b/i;

/** "Your Website" -> "Website". The sentence supplies its own "your". */
function nounPhrase(label: string): string {
  return label.trim().replace(/\s*\*+\s*$/, "").replace(/^your\s+/i, "");
}

/**
 * "Full Name" -> "full name", "Title/Role" -> "title/role", but acronyms
 * survive: "GBP profile" stays "GBP profile", "GA4" stays "GA4". Lowering
 * only the first character left "full Name", which the test also caught.
 */
function lowerWords(label: string): string {
  return label
    .split(/(\s+)/)
    .map((w) => (/^[A-Z0-9][A-Z0-9]+$/.test(w) ? w : w.toLowerCase()))
    .join("");
}

/**
 * A label that can sit inside "Enter your ___." without reading badly:
 * short, not a question, not already a sentence, and not carrying its own
 * "your" (which would double up).
 */
function usableInSentence(label: string): boolean {
  const t = nounPhrase(label);
  return (
    !isQuestion(label) &&
    t.length > 0 &&
    t.length <= 46 &&
    !IMPERATIVE_OR_INTERROGATIVE.test(t) &&
    !/\syour\s/i.test(t)
  );
}

function looksLike(issue: ValidationIssueLike, what: string): boolean {
  const hay = `${issue.format ?? ""} ${issue.validation ?? ""} ${issue.message ?? ""}`.toLowerCase();
  return hay.includes(what);
}

/**
 * Is this issue "you have not filled this in" rather than "what you
 * typed is the wrong shape"? Missing dominates: an absent value fails
 * the type check, and a present-but-empty string fails the min check.
 */
function isMissing(issue: ValidationIssueLike): boolean {
  if (issue.code === "invalid_type") return true; // undefined / null
  if (issue.code === "too_small") return true; // .min(1) on ""
  if (issue.code === "invalid_value" || issue.code === "invalid_enum_value") return true;
  return looksLike(issue, "required") || looksLike(issue, "received undefined");
}

/**
 * Client-facing copy for one failed field. Says what to do, not what the
 * validator saw. Never returns `issue.message`.
 */
export function messageForField(
  field: OnboardingField | undefined,
  issue: ValidationIssueLike,
  vertical?: VerticalId,
): string {
  // No field definition (a schema key with no matching field) -- still
  // must not leak validator text.
  if (!field) return "Please check this answer and try again.";

  const label = visibleLabel(field, vertical);
  const named = usableInSentence(label);
  const it = named ? `your ${lowerWords(nounPhrase(label))}` : "this";

  if (!isMissing(issue)) {
    // Present but the wrong shape. Only a few types can get here.
    if (field.type === "email" || looksLike(issue, "email")) {
      return "That email address does not look right. Check for a typo, such as a missing @ or a missing .com";
    }
    if (field.type === "url" || looksLike(issue, "url")) {
      return "That web address does not look right. It should start with https:// and include a domain, like https://example.com";
    }
    if (field.type === "tel") {
      return "That phone number does not look right. Include the area code, like (555) 123-4567";
    }
    return named
      ? `Please check ${it} and try again.`
      : "Please check this answer and try again.";
  }

  // Missing.
  switch (field.type) {
    case "email":
      return named
        ? `Enter ${it}, like name@example.com`
        : "Enter an email address, like name@example.com";
    case "url":
      return named
        ? `Enter ${it}, starting with https://`
        : "Enter a web address, starting with https://";
    case "tel":
      return named
        ? `Enter ${it}, including the area code.`
        : "Enter a phone number, including the area code.";
    case "select":
    case "radio":
      return named ? `Choose ${it}.` : "Choose one of the options above.";
    case "multiselect":
      return "Choose at least one option above.";
    case "checkbox":
      return "Tick this box to continue.";
    case "repeating":
      return "Add at least one entry above.";
    case "file":
      return named ? `Upload ${it}.` : "Upload a file to continue.";
    case "textarea":
    case "text":
    default:
      return named
        ? `Enter ${it}.`
        : isQuestion(label)
          ? "Please answer this question to continue."
          : "Please fill this in to continue.";
  }
}

/**
 * Convert a set of Zod issues into the field -> message map the wizard
 * renders. `findField` maps a field name to its definition; each steps
 * module supplies its own, because v1 and v2 have separate step arrays.
 */
export function buildErrorMap(
  issues: readonly { path: PropertyKey[]; code?: string; message?: string }[],
  findField: (fieldName: string) => OnboardingField | undefined,
  vertical?: VerticalId,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const fieldName = issue.path?.[0];
    if (typeof fieldName !== "string" || !fieldName) continue;
    // First issue per field wins: Zod can report several for one value
    // and the client only needs one instruction.
    if (errors[fieldName]) continue;
    errors[fieldName] = messageForField(
      findField(fieldName),
      issue as ValidationIssueLike,
      vertical,
    );
  }
  return errors;
}
