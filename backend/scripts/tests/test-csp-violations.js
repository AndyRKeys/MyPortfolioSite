#!/usr/bin/env node
/**
 * CSP violation detection across all served pages (#341).
 *
 * Loads each public page in a real browser (Puppeteer) and listens for
 * `securitypolicyviolation` events. Filters out known ISP-injected noise
 * (inline scripts we don't control) and flags any first-party resource that is
 * blocked — indicating a missing or stale CSP allowlist entry.
 *
 * "First-party" means: the blocked URI is same-origin, or it is a CDN/API we
 * deliberately use but haven't added to the allowlist. ISP-injected inline
 * scripts appear as blockedURI='inline' with no documentURI match to our
 * resources — these are filtered.
 *
 * Runs inside the backend container post-deploy. Uses NGINX_URL (docker-internal
 * address, e.g. https://nginx:3001) so Puppeteer can reach nginx directly.
 * Warn-only: violations are surfaced but exit code 1 so the deploy flag can
 * decide whether to block.
 *
 * Usage:
 *   node test-csp-violations.js <base-url>
 *   npm run test:csp-violations -- https://nginx:3001
 *
 * Output (machine-parseable):
 *   [csp-violations] status=OK pages=6 violations=0
 *   [csp-violations] status=FAIL pages=6 violations=2
 */

import puppeteer from 'puppeteer';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node test-csp-violations.js <base-url>');
  process.exit(1);
}

// Pages to test — all routes served by nginx.
// Admin/setup/login pages load static resources without requiring auth.
const PAGES = ['/', '/blog/', '/travel/', '/login/', '/admin/', '/setup/'];

// ISP-injected inline scripts arrive as blockedURI='inline' but there is no
// reliable way to tell them from our own inline scripts beyond noting that our
// pages intentionally have no inline scripts at all (CSP is 'self' only).
// We flag ALL violations including inline so that if we accidentally add an
// inline script it's caught — ISP noise is expected and documented.
// To suppress known-noise ISP violations, maintainers should record the
// violatedDirective + sourceFile pattern here:
const KNOWN_NOISE = [
  // Example — uncomment and adjust if ISP injection becomes too noisy:
  // { blockedURI: 'inline', violatedDirective: 'script-src-elem', sourceFile: '' },
];

function isKnownNoise(v) {
  return KNOWN_NOISE.some(
    n =>
      n.blockedURI === v.blockedURI &&
      n.violatedDirective === v.violatedDirective &&
      (n.sourceFile === undefined || n.sourceFile === v.sourceFile),
  );
}

const allViolations = []; // { page, blockedURI, violatedDirective, sourceFile, lineNumber }
const pageResults = [];   // { page, count }

console.log('\n🔒 CSP violation detection (#341) — all pages');
console.log(`📍 Base URL: ${baseUrl}\n`);

let browser;
try {
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors', // self-signed dev certs
    ],
  });

  for (const path of PAGES) {
    const url = `${baseUrl}${path}`;
    const violations = [];

    const page = await browser.newPage();

    // Capture securitypolicyviolation events from the page context.
    await page.evaluateOnNewDocument(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
          blockedURI: e.blockedURI,
          violatedDirective: e.violatedDirective,
          effectiveDirective: e.effectiveDirective,
          sourceFile: e.sourceFile || '',
          lineNumber: e.lineNumber || 0,
          columnNumber: e.columnNumber || 0,
          sample: e.sample || '',
        });
      });
    });

    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
      // Brief extra wait: some violations fire slightly after networkidle.
      await new Promise(r => setTimeout(r, 500));

      const raw = await page.evaluate(() => window.__cspViolations || []);
      for (const v of raw) {
        if (!isKnownNoise(v)) violations.push(v);
      }
    } catch (err) {
      console.warn(`  ⚠️  ${path} — navigation error: ${err.message}`);
    } finally {
      await page.close();
    }

    const icon = violations.length === 0 ? '✅' : '❌';
    console.log(`  ${icon} ${path} — ${violations.length} violation(s)`);
    for (const v of violations) {
      console.log(`       blocked: ${v.blockedURI}`);
      console.log(`       directive: ${v.violatedDirective} (${v.effectiveDirective})`);
      if (v.sourceFile) console.log(`       source: ${v.sourceFile}:${v.lineNumber}`);
      if (v.sample) console.log(`       sample: ${v.sample.slice(0, 120)}`);
    }

    allViolations.push(...violations.map(v => ({ page: path, ...v })));
    pageResults.push({ page: path, count: violations.length });
  }
} catch (err) {
  console.error('\n💥 Test runner crashed:', err.message);
  allViolations.push({ page: 'runner', blockedURI: err.message, violatedDirective: 'crash' });
} finally {
  if (browser) await browser.close();
}

const totalViolations = allViolations.length;
const status = totalViolations === 0 ? 'OK' : 'FAIL';

console.log('\n' + '='.repeat(60));
if (totalViolations === 0) {
  console.log(`✅ No CSP violations detected across ${PAGES.length} pages`);
} else {
  console.log(`❌ ${totalViolations} CSP violation(s) detected across ${PAGES.length} pages`);
  console.log('\nSummary:');
  for (const r of pageResults.filter(r => r.count > 0)) {
    console.log(`  • ${r.page}: ${r.count} violation(s)`);
  }
  console.log('\nAction required: update scripts/config/nginx-security-headers.conf');
  console.log('  Add the blocked resource to the appropriate CSP directive.');
  console.log('  See docs/AI.md → Security for the CSP maintenance rule.');
}
console.log('='.repeat(60));
console.log(
  `[csp-violations] status=${status} pages=${PAGES.length} violations=${totalViolations}\n`,
);

process.exit(totalViolations > 0 ? 1 : 0);
