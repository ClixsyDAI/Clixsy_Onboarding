// =============================================================
// Unit tests — extraction sanitisers (p4-1b)
// =============================================================
//
// Run: npm run test:sanitisers
//
// Console-based runner matching the submit route test's convention
// (no test framework dependency; exit 1 on any failure).
//
// The headline fixture is the verbatim business_summary a production
// scan of the4x4store.co.za (Shopify) shipped on 2026-06-11 — a
// product-grid badge strip in escaped markdown. It must be rejected by
// BOTH the phrase list (contains "save up to" / "sold out" / "in
// stock") and the structural prose-shape check (28% letterless
// tokens), so neither layer is load-bearing alone.

import {
  passesProseShape,
  passesSummaryHygiene,
  passesServiceHygiene,
  sanitiseServices,
  sanitiseBusinessSummary,
  stripHtmlTags,
  containsResidualMarkup,
} from './extraction-sanitisers';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}`);
  }
}

// The 2026-06-11 production junk, verbatim (markdown-escaped badges).
const BADGE_STRIP =
  '\\- \\| / Save up to % Save % Save up to Save Sale Sold out In stock';

console.log('--- prose shape ---');
check('badge strip fails prose shape', !passesProseShape(BADGE_STRIP));
check(
  'real summary passes prose shape',
  passesProseShape('BelRed is a heating, cooling and plumbing company serving the Seattle area.'),
);
check(
  'short label (4 words) fails prose shape',
  !passesProseShape('Personal injury law firm'),
);
check(
  'symbol-heavy spec line fails prose shape',
  !passesProseShape('R 1,299 | 35" tyres / 4x4 - 2.8L - diesel | % financing'),
);
check(
  'repetitious strip fails prose shape',
  !passesProseShape('Save now Save now Save now Save now Save now Save now'),
);

// The 2026-06-11 E2E run's junk, verbatim (Shopify cart drawer). This
// one is prose-SHAPED — it must be caught by the phrase layer alone.
const CART_DRAWER =
  'R 0.00Subtotal - Tax included. Shipping calculated at checkout.';

console.log('--- summary hygiene ---');
check('badge strip fails summary hygiene', !passesSummaryHygiene(BADGE_STRIP));
check('cart drawer fails summary hygiene (E2E F1 fixture)', !passesSummaryHygiene(CART_DRAWER));
check(
  'cart drawer IS prose-shaped (documents why the phrase layer is load-bearing here)',
  passesProseShape(CART_DRAWER),
);
check(
  'sanitiseBusinessSummary falls back to generic on cart drawer',
  sanitiseBusinessSummary(CART_DRAWER, 'The 4x4 Store') === 'The 4x4 Store is a local business.',
);
check(
  'badge phrases caught even in prose shape ("save up to")',
  !passesSummaryHygiene('This week you can save up to fifty percent on all suspension kits available.'),
);
check(
  'real summary still passes hygiene',
  passesSummaryHygiene('Midwest Express Clinic provides urgent care services across the Chicagoland area.'),
);
check(
  'consent boilerplate still rejected (regression)',
  !passesSummaryHygiene('By checking this box you consent to receive marketing and promotional texts.'),
);
check(
  'coupon disclaimer still rejected (regression)',
  !passesSummaryHygiene('Cannot be combined with other offers or memberships. Some exclusions may apply today.'),
);
check(
  'sanitiseBusinessSummary falls back to generic on badge strip',
  sanitiseBusinessSummary(BADGE_STRIP, 'The 4x4 Store') === 'The 4x4 Store is a local business.',
);

// Synthetic reproduction of the video-hero markup bug: a WordPress hero
// <video> embed that Firecrawl decoded from entity-encoded page markup and
// shipped as business_summary. The bare-structure HTML5 embed below carries
// no client HTML or URL — only the pattern that broke the WHAT WE FOUND panel.
console.log('--- markup stripping (video-embed bug) ---');
const VIDEO_EMBED =
  '<video playsinline="" controls="" autoplay="" class="video"><source src=" type="video/mp4"></video>';
check('raw video embed fails summary hygiene', !passesSummaryHygiene(VIDEO_EMBED));
check('containsResidualMarkup flags the video embed', containsResidualMarkup(VIDEO_EMBED));
check(
  'stripHtmlTags removes the video embed entirely',
  stripHtmlTags(VIDEO_EMBED).replace(/\s/g, '').length === 0,
);
check(
  'entity-encoded embed decodes then strips to nothing',
  stripHtmlTags('&lt;video class="video"&gt;&lt;source type="video/mp4"&gt;&lt;/video&gt;')
    .replace(/\s/g, '').length === 0,
);
check(
  'sanitiseBusinessSummary falls back to generic on a video embed',
  sanitiseBusinessSummary(VIDEO_EMBED, 'Acme Law', 'law_firm') === 'Acme Law is a law firm.',
);
check(
  'mixed prose+markup keeps the prose after stripping',
  stripHtmlTags('Acme Law helps injured people. <video class="video"></video>').trim() ===
    'Acme Law helps injured people.',
);
check(
  'clean summary carries no residual markup (regression)',
  !containsResidualMarkup('Midwest Express Clinic provides urgent care services across the Chicagoland area.'),
);

console.log('--- service hygiene ---');
check('real service passes', passesServiceHygiene('Personal Injury Law'));
check('product category passes (store)', passesServiceHygiene('4x4 Suspension Kits'));
check('3-char service passes', passesServiceHygiene('SEO'));
check('stock label rejected', !passesServiceHygiene('Sold out'));
check('percentage rejected', !passesServiceHygiene('Save 20%'));
check('rand price rejected', !passesServiceHygiene('R599 Special'));
check('dollar price rejected', !passesServiceHygiene('$99 Tune-Up'));
check('bare symbol rejected', !passesServiceHygiene('-'));
check('nav furniture rejected', !passesServiceHygiene('Shop now'));
check(
  'word-bounded: "Short Sale Negotiation" survives (sale not blocklisted alone)',
  passesServiceHygiene('Short Sale Negotiation'),
);
check(
  'sanitiseServices filters per item, keeps the rest',
  JSON.stringify(
    sanitiseServices(['4x4 Suspension Kits', 'Sold out', 'Save 20%', 'Roof Racks', '-'])
  ) === JSON.stringify(['4x4 Suspension Kits', 'Roof Racks']),
);

console.log('=========================================');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('=========================================');
if (failed > 0) process.exit(1);
