/**
 * Deterministic brand-color & brand-font extraction from raw HTML.
 *
 * Backs up the unreliable LLM-driven Firecrawl /extract path. Firecrawl's
 * /extract was returning empty `brand_colors` / `fonts` on the doc's test
 * fixtures (jimadler.com, junglelaw.com) despite the prompt explicitly
 * asking for them — the LLM has no reliable view of computed CSS values.
 *
 * This module operates ONLY on the raw HTML response from Firecrawl
 * /scrape with `formats: ['rawHtml']` and `onlyMainContent: false` so we
 * keep <head>, inline <style> blocks, and inline style attributes intact.
 *
 * Both exports are pure functions for easy unit testing — no fetches,
 * no DB, no side effects.
 */

export interface ExtractedColor {
  hex: string; // normalised lowercase #rrggbb
  source: 'theme-color' | 'css';
  /** Frequency in the source HTML (1 for meta-derived). */
  frequency: number;
  confidence: number;
}

export interface ExtractedFont {
  family: string; // canonical name as it appears in the source
  source: 'google-fonts' | 'bunny-fonts' | 'css';
  confidence: number;
}

// Confidence scores per the Stage 5 spec.
const CONF_THEME_COLOR = 0.95;
const CONF_GOOGLE_FONTS = 0.90;
const CONF_BUNNY_FONTS = 0.90;
const CONF_CSS_COLOR = 0.85;
const CONF_CSS_FONT = 0.80;

// Generic stacks per the Stage 5 spec — these are CSS keywords / system
// fallbacks, not real brand fonts.
const GENERIC_FONT_KEYWORDS = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'system-ui',
  '-apple-system',
  'cursive',
  'fantasy',
  'inherit',
  'initial',
  'unset',
  'revert',
  'blinkmacsystemfont',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
]);

// Default fonts per the Stage 5 spec — bundled on most OSes, almost never
// chosen as a deliberate brand font.
const COMMON_DEFAULT_FONTS = new Set([
  'arial',
  'helvetica',
  'helvetica neue',
  'times',
  'times new roman',
  'georgia',
  'verdana',
  // Plus a few more that frequently appear as system fallbacks:
  'segoe ui',
  'tahoma',
  'trebuchet ms',
  'courier',
  'courier new',
  'palatino',
  'garamond',
  'noto sans',
]);

// ============================================================================
// Color extraction
// ============================================================================

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.replace('#', '').toLowerCase();
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length === 8) h = h.slice(0, 6); // strip alpha
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** sRGB luminance in [0, 1]. */
function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Decide whether a color is "boring" — pure white/black, near-white/black,
 * or pure greyscale (|r-g|, |g-b|, |r-b| all < 8). These are almost never
 * the brand color a designer picked.
 */
function isBoringColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return true;
  const { r, g, b } = rgb;
  const lum = luminance(r, g, b);
  if (lum > 0.95 || lum < 0.05) return true;
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && Math.abs(r - b) < 8) return true;
  return false;
}

/**
 * Parse a single color token (hex, rgb(), rgba()). Returns lowercase
 * #rrggbb or null on parse failure / fully transparent.
 */
function parseColorToken(token: string): string | null {
  const t = token.trim().toLowerCase();

  if (t === 'transparent') return null;

  // Hex
  if (t.startsWith('#')) {
    const rgb = hexToRgb(t);
    if (!rgb) return null;
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  // rgba(R, G, B, A) — strip alpha=0 as transparent
  const rgbaMatch = t.match(/^rgba?\(\s*([0-9.+\-%\s,/]+)\s*\)$/);
  if (rgbaMatch) {
    const parts = rgbaMatch[1]
      .split(/[,/\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 3) return null;
    const parseChannel = (s: string): number => {
      if (s.endsWith('%')) return (parseFloat(s) / 100) * 255;
      return parseFloat(s);
    };
    const r = parseChannel(parts[0]);
    const g = parseChannel(parts[1]);
    const b = parseChannel(parts[2]);
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    // Alpha — if present and 0, treat as transparent.
    if (parts.length >= 4) {
      const a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if (!Number.isNaN(a) && a === 0) return null;
    }
    return rgbToHex(r, g, b);
  }

  return null;
}

/**
 * Extract brand-relevant colors from raw HTML.
 *
 * Pipeline:
 *   1. <meta name="theme-color" content="#xxx"> — deterministic, conf 0.95
 *   2. Frequency-count all colors in inline <style> blocks + style="..."
 *      attributes (color/background[-color]/border-color/fill/stroke), strip
 *      boring (white/black/greyscale/transparent), keep top 2 — conf 0.85
 *
 * Returns up to ~3 colors, theme-color first if present, then top-CSS sorted
 * by frequency descending. Stable, deterministic, no LLM involved.
 */
export function extractColorsFromHtml(html: string): ExtractedColor[] {
  const results: ExtractedColor[] = [];
  const seen = new Set<string>();

  // 1. <meta name="theme-color">
  const themeMatch = html.match(
    /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["'][^>]*>/i
  );
  if (themeMatch) {
    const hex = parseColorToken(themeMatch[1]);
    if (hex && !isBoringColor(hex)) {
      results.push({ hex, source: 'theme-color', frequency: 1, confidence: CONF_THEME_COLOR });
      seen.add(hex);
    }
  }

  // 2. CSS color tokens — inline <style> + style="…" attributes.
  // Collect all the CSS text first.
  const cssBlocks: string[] = [];
  const styleTagRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = styleTagRe.exec(html)) !== null) cssBlocks.push(m[1]);
  const styleAttrRe = /\sstyle\s*=\s*["']([^"']*)["']/gi;
  while ((m = styleAttrRe.exec(html)) !== null) cssBlocks.push(m[1]);

  const colorDeclRe =
    /(?:color|background|background-color|border-color|outline-color|fill|stroke)\s*:\s*([^;}\n]+)/gi;

  const freq = new Map<string, number>();
  for (const css of cssBlocks) {
    while ((m = colorDeclRe.exec(css)) !== null) {
      const rhs = m[1].trim();
      // A single declaration can contain multiple color tokens
      // (e.g. `background: #fff url(…) repeat`). Pull every color-shaped run.
      const tokenMatches = rhs.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/g);
      if (!tokenMatches) continue;
      for (const tok of tokenMatches) {
        const hex = parseColorToken(tok);
        if (!hex) continue;
        if (isBoringColor(hex)) continue;
        freq.set(hex, (freq.get(hex) ?? 0) + 1);
      }
    }
  }

  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  for (const [hex, count] of sorted) {
    if (seen.has(hex)) continue;
    results.push({ hex, source: 'css', frequency: count, confidence: CONF_CSS_COLOR });
    seen.add(hex);
    if (results.length >= 3) break; // theme + 2 css, or 3 css
  }

  // Trim to top 2 CSS results if theme-color is present, else top 2 overall.
  return results.slice(0, 2 + (results[0]?.source === 'theme-color' ? 1 : 0)).slice(0, 3);
}

// ============================================================================
// Font extraction
// ============================================================================

/**
 * URL-decode a Google/Bunny Fonts family token like `Open+Sans:wght@400;700`
 * back to a clean display name (`Open Sans`).
 */
function cleanFontFamilyParam(raw: string): string {
  // Strip everything after the first `:` (variant axes, weights, etc.)
  const beforeColon = raw.split(':')[0];
  return decodeURIComponent(beforeColon).replace(/\+/g, ' ').trim();
}

/** Strip quotes and normalise whitespace from a CSS font-family token. */
function cleanCssFontToken(raw: string): string {
  // Trim first so the quote anchors hit the actual first/last char.
  return raw
    .trim()
    .replace(/^["']/, '')
    .replace(/["']$/, '')
    .replace(/\s+/g, ' ');
}

function isUsefulFont(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (GENERIC_FONT_KEYWORDS.has(lower)) return false;
  if (COMMON_DEFAULT_FONTS.has(lower)) return false;
  // Single letters or numeric junk from minified CSS
  if (name.length < 2) return false;
  if (/^[0-9]+$/.test(name)) return false;
  // Skip CSS function tokens (var(--foo), calc(...), env(...), etc.) and
  // any token containing parentheses — almost certainly a CSS-var leak,
  // not a real font name.
  if (/[()]/.test(name)) return false;
  if (lower.startsWith('var(') || lower.startsWith('calc(') || lower.startsWith('env(')) return false;
  // CSS custom properties without parens (rare but seen): `--brand-font`.
  if (lower.startsWith('--')) return false;
  return true;
}

/**
 * Extract brand fonts from raw HTML.
 *
 * Pipeline:
 *   1. Google Fonts <link href="…fonts.googleapis.com/css?family=…"> — conf 0.90
 *   2. Bunny Fonts <link href="…fonts.bunny.net/css?family=…"> — conf 0.90
 *   3. Inline <style> + style="…" font-family declarations, take first
 *      non-generic non-default name in each comma list — conf 0.80
 *
 * De-duped (case-insensitive). Returns top 1-2 useful fonts.
 */
export function extractFontsFromHtml(html: string): ExtractedFont[] {
  const results: ExtractedFont[] = [];
  const seenLower = new Set<string>();

  const pushIfNew = (family: string, source: ExtractedFont['source'], confidence: number) => {
    if (!isUsefulFont(family)) return;
    const lower = family.toLowerCase();
    if (seenLower.has(lower)) return;
    seenLower.add(lower);
    results.push({ family, source, confidence });
  };

  // 1. Google Fonts <link>
  const googleLinkRe = /<link[^>]+href=["']([^"']*fonts\.googleapis\.com\/[^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = googleLinkRe.exec(html)) !== null) {
    const url = m[1];
    // Both v1 (`?family=A|B`) and v2 (`?family=A&family=B`) shapes.
    const familyMatches = [...url.matchAll(/[?&]family=([^&]+)/g)];
    for (const fm of familyMatches) {
      // v1 pipe-separated
      for (const part of fm[1].split('|')) {
        const family = cleanFontFamilyParam(part);
        pushIfNew(family, 'google-fonts', CONF_GOOGLE_FONTS);
      }
    }
  }

  // 2. Bunny Fonts <link>
  const bunnyLinkRe = /<link[^>]+href=["']([^"']*fonts\.bunny\.net\/[^"']+)["'][^>]*>/gi;
  while ((m = bunnyLinkRe.exec(html)) !== null) {
    const url = m[1];
    const familyMatches = [...url.matchAll(/[?&]family=([^&]+)/g)];
    for (const fm of familyMatches) {
      for (const part of fm[1].split('|')) {
        const family = cleanFontFamilyParam(part);
        pushIfNew(family, 'bunny-fonts', CONF_BUNNY_FONTS);
      }
    }
  }

  // 3. CSS font-family declarations
  const cssBlocks: string[] = [];
  const styleTagRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleTagRe.exec(html)) !== null) cssBlocks.push(m[1]);
  const styleAttrRe = /\sstyle\s*=\s*["']([^"']*)["']/gi;
  while ((m = styleAttrRe.exec(html)) !== null) cssBlocks.push(m[1]);

  const fontDeclRe = /font-family\s*:\s*([^;}\n]+)/gi;
  for (const css of cssBlocks) {
    while ((m = fontDeclRe.exec(css)) !== null) {
      const value = m[1];
      // Take the FIRST useful name in the comma list — that's the
      // brand-intended choice; later entries are fallbacks.
      for (const raw of value.split(',')) {
        const family = cleanCssFontToken(raw);
        if (isUsefulFont(family)) {
          pushIfNew(family, 'css', CONF_CSS_FONT);
          break;
        }
      }
    }
  }

  return results.slice(0, 2);
}
