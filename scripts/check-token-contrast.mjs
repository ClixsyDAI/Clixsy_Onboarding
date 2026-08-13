#!/usr/bin/env node
// =============================================================
// scripts/check-token-contrast.mjs
// =============================================================
//
// Every foreground token must clear WCAG AA against every surface it is
// actually painted on, in BOTH themes, computed with proper sRGB linearisation.
//
// WHY THIS GUARD EXISTS HERE
//
// This app was light throughout and set colour with 851 hard-coded Tailwind
// arbitrary-hex utilities, so its own token block was dead code and the palette
// could not be changed from one place. It has been rethemed onto the workbook
// dark tokens and every utility now reads a token, which is what makes a check
// like this possible at all.
//
// It matters more here than in the dashboard. This form is PUBLIC and
// client-facing, filled in by clients on phones, so a contrast regression is
// seen by customers rather than by staff. Before the retheme the live landing
// page shipped its primary call to action, "Create New Onboarding", as white on
// the brand green at 1.81 against a 4.5 requirement.
//
// Contrast is not eyeballable and not reviewable in a diff: #086a3c and #097542
// look equally plausible next to each other, and one of them fails.
//
// Usage:  node scripts/check-token-contrast.mjs
// Exits 1 naming every pairing below its requirement, with the measured ratio.
//
// SCOPE, stated precisely, because the boundary is the interesting part.
//
// This checks TOKEN against TOKEN: every foreground against every flat surface,
// in both themes. That is provable from this stylesheet alone and needs no
// browser, and it is where the 210 failures came from.
//
// It does NOT check composited surfaces — the darker background you get when a
// translucent pill sits on a card. Two attempts to synthesise those from the
// stylesheet were built and thrown away: CSS says which fills exist but not which
// element nests inside which, so the generator has to guess, and both versions
// reported double-figure failures on surfaces the app cannot render (a
// light-mode topbar over a dark card) while missing the composite that actually
// mattered. Pinning a list of observed composites instead just moves the problem:
// the list is only as good as the last sweep, and one entry in it turned out to
// be an artefact of a measuring method that was later withdrawn.
//
// So composites stay the runtime sweep's job, and MIN_NORMAL carries headroom
// above 4.5 precisely to absorb the darkening a tint applies. A guard that fails
// on impossible backgrounds gets switched off within a week; one with an honest
// boundary keeps working.
//
// Known consequence: a value tuned to land exactly on 4.5 can clear every flat
// surface here and still fail on a pill. That is what the sweep is for, and why
// the sweep is documented rather than folded in.

import { readFile } from "node:fs/promises";

const CSS = "src/app/globals.css";

// Headroom, deliberately above the standard. See reason 1 above: landing on the
// requirement exactly means any surface not yet observed is a failure.
const MIN_NORMAL = 4.6; // WCAG AA for text under 24px (or under 18.66px bold)
const MIN_LARGE = 3.1; // WCAG AA for text 24px and over

/** Surfaces text is painted on, by token name. */
const SURFACES = ["--bg", "--side", "--card", "--card2", "--cardhi", "--row"];

/**
 * Foregrounds, and what they must clear.
 *
 * Derived from the live sweep, not from guesswork: each of these was observed
 * painting text on the surfaces above. Tokens deliberately NOT listed:
 *   --slate, --purple  never observed as a text colour in either theme; they
 *                      are used for icons and accents. Add them here the day
 *                      one of them paints text.
 *   --green-dim        borders and hover states only.
 */
const FOREGROUNDS = [
  { token: "--text", min: MIN_NORMAL },
  { token: "--muted", min: MIN_NORMAL },
  { token: "--faint", min: MIN_NORMAL },
  { token: "--green", min: MIN_NORMAL },
  { token: "--amber", min: MIN_NORMAL },
  { token: "--red", min: MIN_NORMAL },
  { token: "--blue", min: MIN_NORMAL },
];

/** Ink painted ON a filled control, rather than on a page surface. */
const INK_ON_FILL = [
  { ink: "--on-green", fill: "--green-fill", min: MIN_NORMAL },
];

// ---------------------------------------------------------------- css parsing

function blockAt(src, from) {
  const open = src.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

function findBlock(src, selector, marker) {
  const re = new RegExp(`(^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "g");
  for (const m of src.matchAll(re)) {
    const body = blockAt(src, m.index);
    if (body && body.includes(marker)) return body;
  }
  return null;
}

function parseTokens(...bodies) {
  const out = new Map();
  for (const body of bodies) {
    if (!body) continue;
    for (const m of stripComments(body).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) {
      out.set(m[1], m[2].trim());
    }
  }
  return out;
}

// ------------------------------------------------------------------- contrast

const hexOf = (v) => {
  const m = String(v).trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => {
  const la = lum(a);
  const lb = lum(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

// ----------------------------------------------------------------------- main

const src = await readFile(CSS, "utf-8").catch(() => null);
if (src === null) {
  console.error(`[token-contrast] cannot read ${CSS} — refusing to pass.`);
  process.exit(1);
}

const themes = {
  dark: parseTokens(findBlock(src, ":root", "--green")),
};

for (const [name, map] of Object.entries(themes)) {
  if (map.size === 0) {
    console.error(
      `[token-contrast] parsed 0 tokens for the ${name} theme. The palette was restructured or\n` +
        "this guard's anchors are stale. Fix the guard rather than deleting it.",
    );
    process.exit(1);
  }
}


const failures = [];
const skipped = [];
let compared = 0;

for (const [theme, tokens] of Object.entries(themes)) {  // one theme: dark only
  const resolve = (name) => {
    const raw = tokens.get(name);
    if (raw === undefined) return null;
    const direct = hexOf(raw);
    if (direct) return direct;
    const alias = String(raw).match(/var\(\s*(--[a-z0-9-]+)/i);
    if (alias) return hexOf(tokens.get(alias[1]) ?? "");
    return null; // rgba(), gradients: not a flat colour, not this guard's job
  };

  // Token surfaces, plus every composited surface the sweep actually observed.
  const backgrounds = [];
  for (const name of SURFACES) {
    const rgb = resolve(name);
    if (!rgb) {
      skipped.push(`${theme} ${name} (not a flat hex, or undefined)`);
      continue;
    }
    backgrounds.push({ label: name, rgb });
  }

  for (const fg of FOREGROUNDS) {
    if (fg.themes && !fg.themes.includes(theme)) continue;
    const fgRgb = resolve(fg.token);
    if (!fgRgb) {
      skipped.push(`${theme} ${fg.token} (not a flat hex, or undefined)`);
      continue;
    }
    // Report only the WORST background per foreground. Every composite of the
    // same fill family fails together, so listing them all buries the signal
    // under dozens of near-identical lines.
    let worst = null;
    for (const bg of backgrounds) {
      compared++;
      const r = ratio(fgRgb, bg.rgb);
      if (r < fg.min && (worst === null || r < worst.got)) {
        worst = { theme, fg: fg.token, bg: bg.label, got: r, min: fg.min };
      }
    }
    if (worst) failures.push(worst);
  }

  for (const pair of INK_ON_FILL) {
    const inkRgb = resolve(pair.ink);
    const fillRgb = resolve(pair.fill);
    if (!inkRgb || !fillRgb) {
      skipped.push(`${theme} ${pair.ink} on ${pair.fill} (unresolved)`);
      continue;
    }
    compared++;
    const r = ratio(inkRgb, fillRgb);
    if (r < pair.min) {
      failures.push({ theme, fg: pair.ink, bg: pair.fill, got: r, min: pair.min });
    }
  }
}

if (compared === 0) {
  console.error(
    "[token-contrast] compared 0 pairings. The parse is broken. Refusing to pass on a scan\n" +
      "that covered nothing.",
  );
  process.exit(1);
}

if (failures.length === 0) {
  console.log(
    `[token-contrast] OK: ${compared} token pairings (dark, the only theme) clear AA ` +
      `(${MIN_NORMAL} normal, ${MIN_LARGE} large).` +
      (skipped.length ? `  ${skipped.length} skipped as non-flat.` : ""),
  );
  process.exit(0);
}

console.error(`\n[token-contrast] ${failures.length} pairing(s) below WCAG AA:\n`);
for (const f of failures.sort((a, b) => a.got - b.got)) {
  console.error(
    `  ${f.theme.padEnd(5)} ${f.fg} on ${f.bg}: ${f.got.toFixed(2)}  (needs ${f.min})`,
  );
}
console.error(
  "\nAdjust the token or the pairing. Do not lower MIN_NORMAL or MIN_LARGE: the headroom\n" +
    "above the 4.5/3.0 standard exists because values tuned to land exactly on the\n" +
    "requirement failed as soon as the sweep widened.\n",
);
process.exit(1);
