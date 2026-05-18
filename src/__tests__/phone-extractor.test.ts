/**
 * Phone-extractor unit tests.
 *
 * Run with: npx tsx src/__tests__/phone-extractor.test.ts
 *
 * Synthetic HTML fixtures cover the precedence layers spelled out in the
 * Stage 6 spec — header / hero / tel-link / footer — plus the regression
 * we ship the new extractor to fix: when both a "Contact (877) 517-2990"
 * top-bar AND a back-office number live in the footer, the header
 * number wins.
 */

import { extractPhoneFromHtml } from '../lib/siteIntelligence/phone-extractor';

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
// Fixture 1 — header phone beats footer phone (the regression case)
// ============================================================================
console.log('\n--- Fixture 1: header beats footer ---');
{
  const html = `
    <html>
      <body>
        <header>
          <div class="top-bar">Contact (877) 517-2990 — Free Consultation</div>
        </header>
        <main>
          <p>Welcome. Our service area is Houston.</p>
        </main>
        <footer>
          <p>Back office: 832-555-0100</p>
          <p>Fax: (832) 555-0199</p>
        </footer>
      </body>
    </html>
  `;
  const results = extractPhoneFromHtml(html);
  console.log('   results ->', JSON.stringify(results));
  assert(results.length === 1, 'only the header phone is surfaced');
  assert(results[0].source === 'header', 'top result source = header');
  assert(results[0].phone === '(877) 517-2990', 'top result normalised display');
  assert(results[0].confidence === 0.95, 'header confidence = 0.95');
}

// ============================================================================
// Fixture 2 — only footer phone (no header / no hero / no tel)
// ============================================================================
console.log('\n--- Fixture 2: footer only ---');
{
  const html = `
    <html><body>
      <main><p>Content with no phone.</p></main>
      <footer><span>Call us at 512-555-0100</span></footer>
    </body></html>
  `;
  const results = extractPhoneFromHtml(html);
  console.log('   results ->', JSON.stringify(results));
  assert(results.length === 1, 'fallback to footer when nothing else');
  assert(results[0].source === 'footer' && results[0].confidence === 0.7, 'footer source @ 0.70');
  assert(results[0].phone === '(512) 555-0100', 'normalised display');
}

// ============================================================================
// Fixture 3 — no phone at all
// ============================================================================
console.log('\n--- Fixture 3: no phone ---');
{
  const html = `<html><body><main>No contact info anywhere.</main></body></html>`;
  const results = extractPhoneFromHtml(html);
  console.log('   results ->', JSON.stringify(results));
  assert(results.length === 0, 'empty result, no crash');
}

// ============================================================================
// Fixture 4 — multiple header phones, dedupe + ordering
// ============================================================================
console.log('\n--- Fixture 4: multiple header phones ---');
{
  const html = `
    <html><body>
      <header>
        <a class="call-cta" href="tel:+18775172990">Call (877) 517-2990</a>
        <span class="phone-also">Also reachable at 877.517.2990</span>
        <span>Spanish line: (832) 555-0111</span>
      </header>
    </body></html>
  `;
  const results = extractPhoneFromHtml(html);
  console.log('   results ->', JSON.stringify(results));
  assert(results.length === 2, 'two distinct header numbers after dedupe');
  assert(
    results.every((r) => r.source === 'header'),
    'both come from header layer'
  );
  assert(
    results[0].phone === '(877) 517-2990' && results[1].phone === '(832) 555-0111',
    'preserved document order'
  );
}

// ============================================================================
// Fixture 5 — hero / above-fold when no header exists
// ============================================================================
console.log('\n--- Fixture 5: hero / above-fold ---');
{
  const html = `
    <html><body>
      <section class="hero-banner">
        <h1>Get a free case review</h1>
        <a href="tel:8005551234">800-555-1234</a>
      </section>
      <footer>Back office 832-555-0100</footer>
    </body></html>
  `;
  const results = extractPhoneFromHtml(html);
  console.log('   results ->', JSON.stringify(results));
  assert(results[0].source === 'hero', 'hero layer beats footer');
  assert(results[0].phone === '(800) 555-1234', 'normalised display');
  assert(results[0].confidence === 0.85, 'hero confidence = 0.85');
  assert(!results.some((r) => r.digits === '8325550100'), 'footer not surfaced when hero hits');
}

// ============================================================================
// Fixture 6 — tel: link BELOW the fold (no header, no hero, deep tel)
// The hero approximation is "first ~3000 chars of body". Push the tel link
// past that window with filler so it only matches via Layer 3.
// ============================================================================
console.log('\n--- Fixture 6: tel: link below the fold ---');
{
  const filler = '<p>' + 'lorem '.repeat(800) + '</p>';
  const html = `
    <html><body>
      <main>
        <p>Read more <a href="/about">here</a>.</p>
        ${filler}
        <p>Or <a href="tel:+1-512-555-0100">give us a call</a>.</p>
      </main>
    </body></html>
  `;
  const results = extractPhoneFromHtml(html);
  console.log('   results ->', JSON.stringify(results));
  assert(results.length === 1, 'one tel-link match');
  assert(results[0].source === 'tel-link' && results[0].confidence === 0.8, 'tel-link source @ 0.80');
  assert(results[0].phone === '(512) 555-0100', 'normalised display');
}

// ============================================================================
// Fixture 7 — non-phone digit runs filtered
// ============================================================================
console.log('\n--- Fixture 7: false-positive filter ---');
{
  const html = `
    <html><body>
      <header>
        <div>Suite 0123 in tower 4567-89012</div>
        <div>Address: 123 Main St, Houston TX 77002</div>
        <div>Phone: 832-555-0100</div>
      </header>
    </body></html>
  `;
  const results = extractPhoneFromHtml(html);
  console.log('   results ->', JSON.stringify(results));
  assert(results.length === 1, 'only the real phone surfaces');
  assert(results[0].phone === '(832) 555-0100', 'address numbers filtered');
}

// ============================================================================
// Fixture 8 — header phone wins over a tel: link in body
// ============================================================================
console.log('\n--- Fixture 8: header beats tel-link in body ---');
{
  const html = `
    <html><body>
      <header>(214) 555-7777</header>
      <main>
        <a href="tel:+12145559999">Click to call</a>
      </main>
    </body></html>
  `;
  const results = extractPhoneFromHtml(html);
  console.log('   results ->', JSON.stringify(results));
  assert(results[0].source === 'header', 'header layer fires before tel-link');
  assert(results[0].phone === '(214) 555-7777', 'header phone is the one returned');
  assert(results.length === 1, 'lower-precedence layers skipped once header hits');
}

// ============================================================================
// Fixture 9 — Wix-style obfuscated digit runs (regression for junglelaw.com)
// The site's <header> is full of generated CSS class names and data-*
// attributes whose digit runs happen to match a 10-digit phone regex.
// A real tel: link in the same header should win over those digit runs.
// ============================================================================
console.log('\n--- Fixture 9: tel-link in header beats Wix obfuscated digits ---');
{
  const html = `
    <html><body>
      <header>
        <div class="uZIV9d" data-mesh-id="9656044511">
          <div id="bgLayers_SITE_HEADER" data-coords="9656044511">obfuscated 9656044511 garbage</div>
        </div>
        <a href="tel:1-833-458-6453" class="cta">Call (833) 458-6453</a>
      </header>
    </body></html>
  `;
  const results = extractPhoneFromHtml(html);
  console.log('   results ->', JSON.stringify(results));
  assert(
    results.some((r) => r.phone === '(833) 458-6453' && r.source === 'header'),
    'real tel: link surfaces from header'
  );
  assert(
    !results.some((r) => r.phone === '(965) 604-4511'),
    'pure-digit run 9656044511 is filtered as not phone-shaped'
  );
  assert(results[0].phone === '(833) 458-6453', 'tel link is the top result');
}

// ============================================================================
console.log(`\n=========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`=========================================`);
if (failed > 0) process.exit(1);
