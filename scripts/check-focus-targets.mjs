#!/usr/bin/env node
// =============================================================
// scripts/check-focus-targets.mjs
// =============================================================
//
// INVARIANT
//   Every field the Almost-There summary can list must be reachable.
//   The summary's entries call navigateToStep(stepIndex, fieldName), and the
//   focus hand-off in Wizard.tsx resolves the target with
//   document.getElementById(fieldName). So every control type StepRenderer
//   can render must put id={field.name} on SOMETHING focusable.
//
// WHY THIS EXISTS
//   The summary shipped working, and it was true that it worked -- on the
//   five field types anyone tested it against. `radio` and `multiselect`
//   render N inputs and hung id={field.name} on none of them, so
//   getElementById returned null, the rAF loop span its 120 frames and gave
//   up in silence. The client landed on the right step with nothing focused.
//   Nothing threw and nothing logged; it just quietly did half its job.
//
//   That was found by walking a real session, not by reading the code --
//   which is exactly the kind of gap a guard should be holding instead. The
//   same silence would return the moment someone adds a seventh control
//   type, so the check is over ALL types, not the two that were broken.
//
//   Blast radius when found: 1 of the 11 required fields on EACH vertical
//   (primary_case_types_keywords on law_firm, service_trades on
//   home_services) -- and it is the long checkbox list clients skip most.
//
// Usage:  node scripts/check-focus-targets.mjs
// Exits 1 naming the control type and the case line.

import { readFile } from "node:fs/promises";

const RENDERER = "src/components/onboarding/StepRenderer.tsx";
const STEPS = "src/lib/onboarding/steps-v2.ts";

const src = await readFile(RENDERER, "utf-8");
const stepsSrc = await readFile(STEPS, "utf-8");

// ---------------------------------------------------------------
// 1. Carve the renderField switch into per-type bodies.
// ---------------------------------------------------------------

const switchStart = src.indexOf("switch (field.type)");
if (switchStart < 0) {
  console.error("[focus-targets] could not find `switch (field.type)` in " + RENDERER + ".");
  console.error("                The renderer was restructured; this guard must be updated, not deleted.");
  process.exit(1);
}

// Case labels at the top level of that switch, in source order.
const labelRe = /^\s*case '([a-z]+)':|^\s*(default):/gm;
labelRe.lastIndex = switchStart;
const labels = [];
let m;
while ((m = labelRe.exec(src))) {
  labels.push({
    type: m[1] ?? null,
    isDefault: !!m[2],
    start: m.index,
    end: labelRe.lastIndex,
    line: src.slice(0, m.index).split("\n").length,
  });
  if (m[2]) break; // stop at `default:`
}

if (labels.length < 5) {
  console.error("[focus-targets] parsed only " + labels.length + " case labels — that is a parse failure, not a small switch.");
  process.exit(1);
}

// Consecutive labels with no code between them fall through and share a body.
const blocks = [];
for (let i = 0; i < labels.length; i++) {
  if (labels[i].isDefault) continue;
  const next = labels[i + 1];
  const body = src.slice(labels[i].end, next ? next.start : src.length);
  const fallsThrough = /^\s*$/.test(body);
  if (fallsThrough) {
    blocks.push({ types: [labels[i].type], line: labels[i].line, shareWithNext: true });
  } else {
    blocks.push({
      types: [labels[i].type],
      line: labels[i].line,
      body,
      bodyStart: labels[i].end,
      shareWithNext: false,
    });
  }
}
// Merge fall-through runs into the next real body.
const merged = [];
let pending = [];
for (const b of blocks) {
  if (b.shareWithNext) { pending.push(b); continue; }
  merged.push({
    types: [...pending.flatMap((p) => p.types), ...b.types],
    line: pending.length ? pending[0].line : b.line,
    body: b.body,
    bodyStart: b.bodyStart,
  });
  pending = [];
}

// ---------------------------------------------------------------
// 2. Every type must land id={field.name} on something.
// ---------------------------------------------------------------

// Two accepted shapes: the id written directly on a single control, or the
// groupAria spread, which is where a multi-input group carries it.
const HAS_TARGET = /id=\{field\.name\}|\{\.\.\.groupAria\}/;

// Anything that is an actual control. A return path rendering one of these
// owes a focus target; a path rendering only explanatory prose does not.
const RENDERS_CONTROL =
  /<input\b|<select\b|<textarea\b|<AutoGrowTextarea\b|<RepeatingRows\b|<ScrapedValuePreview\b/;

/**
 * Case bodies are checked PER RETURN PATH, not as one blob.
 *
 * The first version of this guard tested the whole case body, and a mutation
 * test caught it letting the original bug straight back through: `multiselect`
 * has two return paths (the grouped service_categories tree and the flat
 * option list), and groupAria on either one satisfied a body-wide regex. That
 * is exactly the defect being guarded -- one path wired, another not.
 */
const BACKSLASH = String.fromCharCode(92);

/**
 * Blank out comments and string bodies, preserving length and newlines, so
 * paren matching sees only code.
 *
 * This is not defensive dressing. Without comment handling the scanner read
 * the apostrophe in the comment "so the radio doesn't hold a stale id" as an
 * opening quote, desynchronised, and ran the grouped multiselect's return
 * straight through the flat one -- merging two paths into one and letting the
 * mutation test's planted bug pass. The mutation test is the only reason that
 * was noticed.
 */
function maskNonCode(s) {
  const out = s.split("");
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === "/" && d === "/") {
      let j = i + 2;
      while (j < s.length && s[j] !== "\n") j++;
      blank(i, j); i = j; continue;
    }
    if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < s.length && !(s[j] === "*" && s[j + 1] === "/")) j++;
      blank(i, Math.min(j + 2, s.length)); i = j + 2; continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === BACKSLASH) { j += 2; continue; }
        if (s[j] === c) break;
        j++;
      }
      blank(i + 1, j); i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

function returnPaths(body) {
  const masked = maskNonCode(body);
  const paths = [];
  const re = /\breturn\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < masked.length; j++) {
      const c = masked[j];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
    }
    // Slice from the ORIGINAL text so the content checks see real code.
    paths.push({ text: body.slice(m.index, j + 1), offset: m.index });
    re.lastIndex = j + 1;
  }
  return paths;
}

const failures = [];
const covered = new Set();
let pathsChecked = 0;
for (const block of merged) {
  for (const t of block.types) covered.add(t);
  const paths = returnPaths(block.body);
  // A case with no parenthesised return renders via a single expression;
  // fall back to the whole body so such a case is still checked.
  const candidates = paths.length ? paths : [{ text: block.body, offset: 0 }];
  for (const p of candidates) {
    if (!RENDERS_CONTROL.test(p.text)) continue; // prose-only path: nothing to focus
    pathsChecked++;
    if (HAS_TARGET.test(p.text)) continue;
    failures.push({
      types: block.types,
      line: src.slice(0, block.bodyStart + p.offset).split("\n").length,
      caseLine: block.line,
    });
  }
}

// Sanity: groupAria must actually set the id, or the regex above is a lie.
if (!/const groupAria\s*=\s*\{[\s\S]{0,400}?id:\s*field\.name/.test(src)) {
  console.error("[focus-targets] `groupAria` no longer sets `id: field.name`.");
  console.error("                This guard accepts {...groupAria} as a focus target on that basis.");
  process.exit(1);
}

// GROUP_CONTROL_TYPES drives the <label> switch from htmlFor to
// aria-labelledby. If a case spreads groupAria but its type is missing from
// that set, the label points htmlFor at a <div> -- invalid, and the group
// goes unlabelled. Two lists that must agree, so check they do.
const setMatch = /const GROUP_CONTROL_TYPES = new Set\(\[([^\]]*)\]\)/.exec(src);
if (!setMatch) {
  console.error("[focus-targets] could not find GROUP_CONTROL_TYPES in " + RENDERER + ".");
  process.exit(1);
}
const declaredGroups = new Set([...setMatch[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]));
const spreadsGroupAria = new Set(
  merged.filter((b) => /\{\.\.\.groupAria\}/.test(b.body)).flatMap((b) => b.types),
);
const groupMismatch = [
  ...[...spreadsGroupAria].filter((t) => !declaredGroups.has(t))
    .map((t) => "case '" + t + "' spreads groupAria but is not in GROUP_CONTROL_TYPES — its <label> will point htmlFor at a <div>"),
  ...[...declaredGroups].filter((t) => !spreadsGroupAria.has(t))
    .map((t) => "'" + t + "' is in GROUP_CONTROL_TYPES but its case does not spread groupAria — its label will reference an id nothing carries"),
];

// ---------------------------------------------------------------
// 3. Denominator: no type in the data may be unknown to the switch.
// ---------------------------------------------------------------

const typesInData = new Set([...stepsSrc.matchAll(/(?:^|[^a-zA-Z])type:\s*'([a-z]+)'/g)].map((x) => x[1]));
// `type:` also appears on non-field objects; keep only what the switch knows,
// and report anything the data uses that the switch does not handle.
const unhandled = [...typesInData].filter((t) => !covered.has(t) && t !== "hidden");

if (covered.size === 0 || pathsChecked === 0) {
  console.error(
    "[focus-targets] matched " + covered.size + " control types over " + pathsChecked +
      " control-rendering return paths — refusing to pass on a scan that covered nothing.",
  );
  process.exit(1);
}

const coverage =
  covered.size + " control types over " + pathsChecked +
  " control-rendering return paths (" + [...covered].sort().join(", ") + ")";

if (failures.length === 0 && unhandled.length === 0 && groupMismatch.length === 0) {
  console.log(
    "[focus-targets] OK: " + coverage + ". Every type the summary can list has a\n" +
      "                focus target, and GROUP_CONTROL_TYPES (" + [...declaredGroups].sort().join(", ") +
      ") matches the cases that spread groupAria.",
  );
  process.exit(0);
}

console.error("");
for (const f of failures) {
  console.error(
    "[focus-targets] " + RENDERER + ":" + f.line + "  case '" + f.types.join("' / '") + "'\n" +
      "     renders no element carrying id={field.name}, so the Almost-There\n" +
      "     summary will navigate to the step and then focus nothing. Put the id\n" +
      "     on the single control, or spread {...groupAria} on the group container\n" +
      "     (NOT on the first input — that makes clicking the question heading\n" +
      "     select the first option).\n",
  );
}
for (const t of unhandled) {
  console.error(
    "[focus-targets] steps data uses type '" + t + "' but the renderField switch\n" +
      "     has no case for it. It will fall to `default: return null` and render\n" +
      "     nothing at all.\n",
  );
}
for (const g of groupMismatch) {
  console.error("[focus-targets] " + g + "\n");
}
console.error("[focus-targets] scanned: " + coverage);
process.exit(1);
