/**
 * Branding extractor unit tests.
 *
 * Run with: npx tsx src/__tests__/branding-extractor.test.ts
 *
 * Three synthetic fixtures per the Stage 5 spec:
 *   1. Easy   — Google Fonts link + theme-color + clean inline styles
 *   2. Medium — no Google Fonts; only inline CSS with font + color
 *   3. Empty  — only generic/default fallbacks, white/black/grey colors
 *
 * Plus a couple of edge cases worth pinning (rgba transparent skipped,
 * Bunny Fonts URL handled, Google Fonts v2 multi-family URL handled).
 */

import { extractColorsFromHtml, extractFontsFromHtml } from '../lib/siteIntelligence/branding-extractor';

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

// ============================================================================
// Fixture 1 — EASY case
// Google Fonts link + theme-color + a hero block with brand colors inline.
// ============================================================================
console.log('\n--- Fixture 1: easy case ---');
{
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta name="theme-color" content="#2D7A3E">
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Playfair+Display:wght@700" rel="stylesheet">
      <style>
        body { background: #ffffff; color: #1a1a1a; font-family: 'Inter', sans-serif; }
        .hero { background-color: #2D7A3E; color: #ffffff; }
        .accent { color: #F5C518; border-color: #F5C518; }
        h1 { font-family: 'Playfair Display', Georgia, serif; }
      </style>
    </head>
    <body>
      <div class="hero" style="background: #2D7A3E; color: #fff;">Hero</div>
    </body>
    </html>
  `;

  const fonts = extractFontsFromHtml(html);
  console.log('   fonts ->', JSON.stringify(fonts));
  assert(fonts.length >= 1, 'easy: at least one font extracted');
  assert(
    fonts.some((f) => f.family === 'Inter' && f.source === 'google-fonts' && f.confidence === 0.9),
    'easy: Inter from google-fonts at 0.90'
  );
  assert(
    fonts.some((f) => f.family === 'Playfair Display' && f.source === 'google-fonts'),
    'easy: Playfair Display picked up from google-fonts v2 URL'
  );

  const colors = extractColorsFromHtml(html);
  console.log('   colors ->', JSON.stringify(colors));
  assert(colors.length >= 2, 'easy: at least 2 colors extracted');
  assert(
    colors[0].hex === '#2d7a3e' && colors[0].source === 'theme-color' && colors[0].confidence === 0.95,
    'easy: theme-color #2D7A3E ranks first at 0.95'
  );
  assert(
    colors.some((c) => c.hex === '#f5c518' && c.source === 'css' && c.confidence === 0.85),
    'easy: accent #F5C518 picked up from CSS at 0.85'
  );
  assert(!colors.some((c) => c.hex === '#ffffff'), 'easy: pure white filtered');
  assert(!colors.some((c) => c.hex === '#1a1a1a'), 'easy: near-black filtered');
}

// ============================================================================
// Fixture 2 — MEDIUM case
// No Google/Bunny links; CSS has font + color we want.
// ============================================================================
console.log('\n--- Fixture 2: medium case (inline only) ---');
{
  const html = `
    <html><head>
    <style>
      :root { --brand: #7B2CBF; }
      body {
        font-family: "Cormorant Garamond", Georgia, serif;
        color: #2c2c2c;
        background-color: #ffffff;
      }
      .cta { background: rgb(123, 44, 191); color: white; }
      .badge { background-color: rgba(255, 199, 44, 1); }
      .hidden { background-color: rgba(0, 0, 0, 0); }
    </style>
    </head><body>
    <button style="background-color: #7b2cbf; color: rgb(255, 199, 44);">Click</button>
    </body></html>
  `;

  const fonts = extractFontsFromHtml(html);
  console.log('   fonts ->', JSON.stringify(fonts));
  assert(fonts.length === 1, 'medium: exactly one useful font');
  assert(
    fonts[0].family === 'Cormorant Garamond' && fonts[0].source === 'css' && fonts[0].confidence === 0.8,
    'medium: Cormorant Garamond picked from CSS at 0.80, Georgia skipped as default'
  );

  const colors = extractColorsFromHtml(html);
  console.log('   colors ->', JSON.stringify(colors));
  assert(colors.length >= 2, 'medium: at least 2 colors via frequency');
  assert(colors.some((c) => c.hex === '#7b2cbf'), 'medium: #7B2CBF from hex + rgb');
  assert(colors.some((c) => c.hex === '#ffc72c'), 'medium: #FFC72C from rgba()');
  assert(
    !colors.some((c) => c.hex === '#000000'),
    'medium: rgba(0,0,0,0) transparent skipped — no pure black emitted'
  );
}

// ============================================================================
// Fixture 3 — EMPTY case
// Everything's white/black/grey and only system fonts. Graceful fallback.
// ============================================================================
console.log('\n--- Fixture 3: empty case (defaults only) ---');
{
  const html = `
    <html><head>
    <style>
      body { background: #ffffff; color: #000000; font-family: Arial, Helvetica, sans-serif; }
      .panel { background-color: #fafafa; border-color: #cccccc; }
      h1 { font-family: "Times New Roman", Times, serif; }
    </style>
    </head><body>Plain</body></html>
  `;

  const fonts = extractFontsFromHtml(html);
  console.log('   fonts ->', JSON.stringify(fonts));
  assert(fonts.length === 0, 'empty: zero useful fonts — Arial / Times / sans-serif all filtered');

  const colors = extractColorsFromHtml(html);
  console.log('   colors ->', JSON.stringify(colors));
  assert(colors.length === 0, 'empty: zero useful colors — pure white/black/greyscale all filtered');
}

// ============================================================================
// Fixture 4 — Bunny Fonts edge case + dedupe across sources
// ============================================================================
console.log('\n--- Fixture 4: Bunny Fonts + dedupe ---');
{
  const html = `
    <html><head>
    <link href="https://fonts.bunny.net/css?family=poppins:400,700|inter:400" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css?family=Inter" rel="stylesheet">
    <style>body { font-family: 'Inter', sans-serif; }</style>
    </head><body></body></html>
  `;
  const fonts = extractFontsFromHtml(html);
  console.log('   fonts ->', JSON.stringify(fonts));
  assert(fonts.length === 2, 'bunny: exactly two distinct fonts after dedupe');
  // Google is parsed before Bunny in our pipeline; Inter appears in both
  // so the first-seen Google entry wins on dedupe, then Bunny adds Poppins.
  assert(
    fonts.some((f) => f.family.toLowerCase() === 'inter' && f.source === 'google-fonts'),
    'bunny: Inter de-duplicated, kept from first-pass google-fonts'
  );
  assert(
    fonts.some((f) => f.family.toLowerCase() === 'poppins' && f.source === 'bunny-fonts'),
    'bunny: Poppins surfaced from bunny-fonts link'
  );
}

// ============================================================================
// Fixture 5 — 3-digit hex shorthand + greyscale-distance boundary
// ============================================================================
console.log('\n--- Fixture 5: hex shorthand + greyscale edge ---');
{
  const html = `
    <style>
      .a { color: #f0a; }
      .b { background: #f0a; }
      .c { background: #f0a; }
      .d { color: #888; }      /* pure grey, must be filtered */
      .e { color: #112233; }   /* not greyscale, channel diffs > 8 */
    </style>
  `;
  const colors = extractColorsFromHtml(html);
  console.log('   colors ->', JSON.stringify(colors));
  assert(colors.some((c) => c.hex === '#ff00aa'), 'hex: #f0a expanded to #ff00aa');
  assert(!colors.some((c) => c.hex === '#888888'), 'hex: #888 filtered as greyscale');
  // #112233 -> r=17, g=34, b=51 -> diffs 17,17,34 -> NOT greyscale by |diff|<8
  assert(colors.some((c) => c.hex === '#112233'), 'hex: #112233 kept (not greyscale)');
}

// ============================================================================
// Fixture 6 — CSS custom property / var(--…) leak (regression for junglelaw)
// junglelaw.com had `font-family: var(--fnt-family-ba-title, 'Madefor',
// sans-serif);` and we were leaking the raw `var(--fnt-family-ba-title` as
// a "font name". Now must be filtered out.
// ============================================================================
console.log('\n--- Fixture 6: CSS custom-property leak (regression) ---');
{
  const html = `
    <style>
      body { font-family: var(--fnt-family-ba-title, 'Madefor', sans-serif); }
      h1 { font-family: --brand-font, 'Inter'; }
      h2 { font-family: calc(1rem + 2px) Lato; }
    </style>
  `;
  const fonts = extractFontsFromHtml(html);
  console.log('   fonts ->', JSON.stringify(fonts));
  assert(
    !fonts.some((f) => f.family.toLowerCase().startsWith('var(')),
    'var(--…) tokens are filtered out of font extraction'
  );
  assert(
    !fonts.some((f) => f.family.startsWith('--')),
    'raw --custom-property tokens are filtered'
  );
  assert(
    !fonts.some((f) => /[()]/.test(f.family)),
    'no leftover CSS function tokens leak into font results'
  );
  // Madefor (after the CSS var fallback comma) and Inter should win.
  assert(
    fonts.some((f) => f.family === 'Madefor'),
    'Madefor surfaces after var() is skipped (next non-generic token in list)'
  );
}

// ============================================================================
// Fixture 7 — CJK system fallbacks (regression for junglelaw.com)
// メイリオ (Meiryo), Yu Gothic, Hiragino, MS Gothic, SimSun all leaked
// through as "brand fonts" in Stage 5. Should be filtered like any other
// OS-bundled system font.
// ============================================================================
console.log('\n--- Fixture 7: CJK system-font filter (regression) ---');
{
  const html = `
    <style>
      body { font-family: "Madefor", メイリオ, "Yu Gothic", sans-serif; }
      .ja { font-family: "Hiragino Sans", "Hiragino Kaku Gothic Pro", sans-serif; }
      .ja2 { font-family: "MS Gothic", "MS PGothic", "SimSun", sans-serif; }
    </style>
  `;
  const fonts = extractFontsFromHtml(html);
  console.log('   fonts ->', JSON.stringify(fonts));
  assert(
    fonts.length === 1 && fonts[0].family === 'Madefor',
    'CJK fallbacks filtered: only Madefor surfaces'
  );
  assert(
    !fonts.some((f) => /メイリオ|meiryo|yu gothic|hiragino|ms gothic|simsun/i.test(f.family)),
    'no Meiryo / Yu Gothic / Hiragino / MS Gothic / SimSun in results'
  );
}

// ============================================================================
console.log(`\n=========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`=========================================`);
if (failed > 0) process.exit(1);
