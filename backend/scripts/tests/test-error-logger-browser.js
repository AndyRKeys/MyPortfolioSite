#!/usr/bin/env node
/**
 * Error-logger contract tests against the LIVE deployed site.
 *
 * Loads real pages from the running nginx and uses Puppeteer request
 * interception to capture POSTs to /api/debug/errors and simulate the backend
 * being up or down — so the buffering/drain behaviour can be exercised without
 * actually taking the backend down. Verifies the actually-deployed
 * error-logger.js, and runs inside the backend container post-deploy (Chromium
 * ships in the image).
 *
 * Contracts verified:
 *   1. Resource-load failures captured (#332) — capture-phase listener
 *   2. Runtime errors logged exactly once (no duplication from capture listener)
 *   3. Reports buffered in localStorage when backend unreachable (#334)
 *   4. Buffer drained and emptied after backend returns (#334)
 *   5. No browser hang under error storm against failing backend (#331)
 *
 * Usage:
 *   node test-error-logger-browser.js <base-url>
 *   npm run test:error-logger:browser -- https://nginx:3001
 */

import puppeteer from 'puppeteer';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node test-error-logger-browser.js <base-url>');
  process.exit(1);
}

const passed = [];
const failed = [];
const check = (name, cond) => {
  if (cond) { console.log(`  ✅ ${name}`); passed.push(name); }
  else { console.log(`  ❌ ${name}`); failed.push(name); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('\n🧪 error-logger contract tests (against live site)');
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

  // Intercept /api/debug/errors: capture payloads and simulate up/down.
  let backendUp = true;
  let delivered = 0;     // count of reports we accepted with 200
  const captured = [];   // parsed POST bodies seen

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/debug/errors')) {
      const data = req.postData();
      if (data) { try { captured.push(JSON.parse(data)); } catch { captured.push({ raw: data }); } }
      if (backendUp) {
        delivered++;
        req.respond({ status: 200, contentType: 'application/json', body: '{"received":true}' });
      } else {
        req.respond({ status: 503, contentType: 'application/json', body: '{"error":"down"}' });
      }
      return;
    }
    req.continue();
  });

  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle0', timeout: 20000 });
  // Clear any buffer left from a previous run on this origin.
  await page.evaluate(() => { try { localStorage.removeItem('errlog:buffer'); } catch {} });

  // ── Test 1: resource-load capture ──────────────────────────────────────────
  console.log('📍 Test 1 — resource-load failure captured (#332)');
  captured.length = 0;
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.src = '/resources/js/does-not-exist-' + Date.now() + '.js'; // genuine 404
    document.head.appendChild(s);
  });
  await sleep(600);
  const rc = captured.find(r => r.type === 'resource-error');
  check('resource-error report captured', !!rc);
  check('message names the failed load', /Failed to load <script>/i.test(rc?.message || ''));

  // ── Test 2: runtime error not duplicated by capture listener ───────────────
  // NB: Puppeteer's evaluate sandbox masks the thrown message as "Script error.",
  // so we assert on count/type, not message text — the point is that the new
  // capture-phase listener must not duplicate the bubble-phase runtime report.
  console.log('\n📍 Test 2 — runtime error reported exactly once (#332)');
  captured.length = 0;
  await page.evaluate(() => setTimeout(() => { throw new Error('pr331-runtime'); }, 0));
  await sleep(600);
  const rt = captured.filter(r => r.type === 'uncaught-error');
  check('runtime error reported exactly once (no duplication)', rt.length === 1);

  // ── Test 3: buffered when backend down ─────────────────────────────────────
  console.log('\n📍 Test 3 — reports buffered when backend unreachable (#334)');
  captured.length = 0;
  const deliveredBefore = delivered;
  backendUp = false;
  const offlineMarker = 'offline-' + Date.now();
  await page.evaluate((m) => console.error(m), offlineMarker);
  await sleep(600);
  check('not delivered to backend while down', delivered === deliveredBefore);
  const bufLen = await page.evaluate(
    () => JSON.parse(localStorage.getItem('errlog:buffer') || '[]').length,
  );
  check('report persisted in localStorage buffer', bufLen >= 1);

  // ── Test 4: buffer drains after backend returns ────────────────────────────
  console.log('\n📍 Test 4 — buffer drains when backend returns (#334)');
  backendUp = true;
  captured.length = 0;
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await sleep(800);
  const flushed = captured.find(r => String(r.message || '').includes(offlineMarker));
  check('buffered report delivered after reload', !!flushed);
  const bufAfter = await page.evaluate(
    () => JSON.parse(localStorage.getItem('errlog:buffer') || '[]').length,
  );
  check('localStorage buffer emptied after flush', bufAfter === 0);

  // ── Test 5: no hang under error storm against failing backend ──────────────
  console.log('\n📍 Test 5 — no browser hang on error storm while down (#331)');
  backendUp = false;
  const done = await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) console.error('storm-' + i);
    await new Promise(r => setTimeout(r, 400));
    return 'done';
  });
  check('page remains responsive after 5-error storm', done === 'done');

  // Best-effort cleanup so we don't leave buffered junk on the origin.
  await page.evaluate(() => { try { localStorage.removeItem('errlog:buffer'); } catch {} });

} catch (err) {
  console.error('\n💥 Test runner crashed:', err.message);
  failed.push(`Runner crashed: ${err.message}`);
} finally {
  if (browser) await browser.close();
}

const total = passed.length + failed.length;
console.log('\n' + '='.repeat(60));
console.log(`✅ Passed : ${passed.length} / ${total}`);
if (failed.length) {
  console.log(`❌ Failed : ${failed.length}`);
  failed.forEach(n => console.log(`   • ${n}`));
}
console.log('='.repeat(60));
const status = failed.length === 0 ? 'OK' : 'FAIL';
console.log(`[error-logger-browser] status=${status} passed=${passed.length} failed=${failed.length}\n`);

process.exit(failed.length ? 1 : 0);
