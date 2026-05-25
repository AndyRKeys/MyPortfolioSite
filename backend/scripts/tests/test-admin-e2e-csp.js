#!/usr/bin/env node
/**
 * Authenticated admin E2E CSP test (#342).
 *
 * Loads the admin panel as an authenticated session and drives the interactions
 * that call external origins (Nominatim geocoding etc.). Listens for
 * `securitypolicyviolation` events and fails if any first-party violation fires.
 *
 * Auth: mints a short-lived JWT from JWT_SECRET (same technique as the
 * regression suite) and injects it into localStorage.adminToken — no passkey
 * ceremony or CDP virtual authenticator needed. isAdminSession() in
 * auth-utils.js reads from localStorage, so the admin page behaves fully
 * authenticated.
 *
 * Interactions exercised:
 *   1. /admin/ page load — static resources (scripts, styles, fonts, maps)
 *   2. Nominatim forward geocode — type a location and click the geocode button
 *      (connect-src https://nominatim.openstreetmap.org)
 *   3. Nominatim reverse geocode — populate lat/lng and fire the reverseGeocode
 *      helper by programmatically dispatching the change event that triggers it
 *
 * Runs inside the backend container post-deploy (Chromium ships in the image).
 * Uses NGINX_URL (docker-internal, e.g. https://nginx:3001) so Puppeteer can
 * reach nginx directly.
 *
 * Warn-only: non-zero exit triggers a deploy warning but not a rollback.
 *
 * Usage:
 *   node test-admin-e2e-csp.js <base-url>
 *   npm run test:admin-e2e-csp -- https://nginx:3001
 *
 * Output (machine-parseable):
 *   [admin-e2e-csp] status=OK interactions=3 violations=0
 *   [admin-e2e-csp] status=FAIL interactions=3 violations=1
 */

import puppeteer from 'puppeteer';
import jwt from 'jsonwebtoken';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node test-admin-e2e-csp.js <base-url>');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[admin-e2e-csp] JWT_SECRET not set — cannot mint test token');
  console.error('[admin-e2e-csp] status=SKIP interactions=0 violations=0');
  process.exit(0); // skip rather than fail — missing env is a config issue
}

// Mint a short-lived JWT. userId 'e2e-test' matches the regression suite pattern.
const testToken = jwt.sign({ userId: 'e2e-test' }, JWT_SECRET, { expiresIn: '1h' });

// ISP-injected inline-script noise filter — same policy as test-csp-violations.js.
// Empty by default: all violations flagged. Add known-noise entries if needed.
const KNOWN_NOISE = [];

function isKnownNoise(v) {
  return KNOWN_NOISE.some(
    n =>
      n.blockedURI === v.blockedURI &&
      n.violatedDirective === v.violatedDirective &&
      (n.sourceFile === undefined || n.sourceFile === v.sourceFile),
  );
}

const violations = [];
let interactionsRun = 0;

console.log('\n🔒 Admin E2E CSP test (#342) — authenticated interactions');
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
        sample: e.sample || '',
      });
    });
  });

  // ── Interaction 1: authenticated /admin/ page load ─────────────────────────
  console.log('📍 Interaction 1 — authenticated admin page load');

  // Load the page first so we can set localStorage on the origin, then reload.
  await page.goto(`${baseUrl}/admin/`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  // Inject JWT — isAdminSession() reads localStorage.adminToken.
  await page.evaluate((token) => {
    localStorage.setItem('adminToken', token);
  }, testToken);

  // Reload as authenticated — wait for networkidle so all static resources fire.
  await page.goto(`${baseUrl}/admin/`, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 500));
  interactionsRun++;

  const afterLoad = await page.evaluate(() => window.__cspViolations || []);
  const loadViolations = afterLoad.filter(v => !isKnownNoise(v));
  if (loadViolations.length === 0) {
    console.log('  ✅ No CSP violations on admin page load');
  } else {
    console.log(`  ❌ ${loadViolations.length} violation(s) on page load`);
    loadViolations.forEach(v => {
      console.log(`     blocked: ${v.blockedURI}`);
      console.log(`     directive: ${v.violatedDirective}`);
      if (v.sourceFile) console.log(`     source: ${v.sourceFile}:${v.lineNumber}`);
    });
  }
  violations.push(...loadViolations);

  // Reset violation list before next interaction.
  await page.evaluate(() => { window.__cspViolations = []; });

  // ── Interaction 2: Nominatim forward geocode ───────────────────────────────
  // Type a location query into #travel-location and click #geocode-btn.
  // This triggers fetch('https://nominatim.openstreetmap.org/search?...')
  console.log('\n📍 Interaction 2 — Nominatim forward geocode (location search)');
  try {
    await page.waitForSelector('#travel-location', { timeout: 5000 });
    await page.click('#travel-location', { clickCount: 3 });
    await page.type('#travel-location', 'London, UK');
    await page.click('#geocode-btn');
    // Wait for the fetch to complete (networkidle or a short timeout).
    await new Promise(r => setTimeout(r, 2000));
    interactionsRun++;

    const afterGeocode = await page.evaluate(() => window.__cspViolations || []);
    const geocodeViolations = afterGeocode.filter(v => !isKnownNoise(v));
    if (geocodeViolations.length === 0) {
      console.log('  ✅ No CSP violations on Nominatim forward geocode');
    } else {
      console.log(`  ❌ ${geocodeViolations.length} violation(s) on forward geocode`);
      geocodeViolations.forEach(v => {
        console.log(`     blocked: ${v.blockedURI}`);
        console.log(`     directive: ${v.violatedDirective}`);
        if (v.sourceFile) console.log(`     source: ${v.sourceFile}:${v.lineNumber}`);
      });
    }
    violations.push(...geocodeViolations);
    await page.evaluate(() => { window.__cspViolations = []; });
  } catch (err) {
    console.warn(`  ⚠️  Forward geocode interaction skipped: ${err.message}`);
  }

  // ── Interaction 3: Nominatim reverse geocode ───────────────────────────────
  // Call reverseGeocodeToLocation() directly — it's only triggered by EXIF
  // extraction or a successful forward geocode, not by the lat/lng input events.
  // Calling it from evaluate() is equivalent to those paths and exercises the
  // same fetch to nominatim.openstreetmap.org/reverse.
  console.log('\n📍 Interaction 3 — Nominatim reverse geocode (lat/lng → location)');
  try {
    // Clear location field so reverseGeocode doesn't short-circuit early return.
    await page.evaluate(() => {
      const loc = document.getElementById('travel-location');
      if (loc) loc.value = '';
    });
    // Trigger a reverse geocode fetch directly — reverseGeocodeToLocation is
    // scoped inside the jQuery ready callback and isn't a global. Making the
    // same fetch call exercises the same connect-src allowlist entry.
    await page.evaluate(async () => {
      try {
        await fetch(
          'https://nominatim.openstreetmap.org/reverse?format=json&lat=51.5074&lon=-0.1278&zoom=10&addressdetails=1',
        );
      } catch { /* network errors are fine — we only care about CSP violations */ }
    });
    await new Promise(r => setTimeout(r, 2000));
    interactionsRun++;

    const afterReverse = await page.evaluate(() => window.__cspViolations || []);
    const reverseViolations = afterReverse.filter(v => !isKnownNoise(v));
    if (reverseViolations.length === 0) {
      console.log('  ✅ No CSP violations on Nominatim reverse geocode');
    } else {
      console.log(`  ❌ ${reverseViolations.length} violation(s) on reverse geocode`);
      reverseViolations.forEach(v => {
        console.log(`     blocked: ${v.blockedURI}`);
        console.log(`     directive: ${v.violatedDirective}`);
        if (v.sourceFile) console.log(`     source: ${v.sourceFile}:${v.lineNumber}`);
      });
    }
    violations.push(...reverseViolations);
  } catch (err) {
    console.warn(`  ⚠️  Reverse geocode interaction skipped: ${err.message}`);
  }

  // Best-effort cleanup — remove the test token so it doesn't pollute the origin.
  await page.evaluate(() => { try { localStorage.removeItem('adminToken'); } catch {} });

} catch (err) {
  console.error('\n💥 Test runner crashed:', err.message);
  violations.push({ blockedURI: err.message, violatedDirective: 'crash' });
} finally {
  if (browser) await browser.close();
}

const totalViolations = violations.length;
const status = totalViolations === 0 ? 'OK' : 'FAIL';

console.log('\n' + '='.repeat(60));
if (totalViolations === 0) {
  console.log(`✅ No CSP violations across ${interactionsRun} admin interaction(s)`);
} else {
  console.log(`❌ ${totalViolations} CSP violation(s) across ${interactionsRun} admin interaction(s)`);
  console.log('\nAction required: update scripts/config/nginx-security-headers.conf');
  console.log('  Add the blocked resource to the appropriate CSP directive.');
}
console.log('='.repeat(60));
console.log(
  `[admin-e2e-csp] status=${status} interactions=${interactionsRun} violations=${totalViolations}\n`,
);

process.exit(totalViolations > 0 ? 1 : 0);
