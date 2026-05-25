#!/usr/bin/env node
/**
 * Self-contained browser test for resources/js/error-logger.js.
 *
 * Spins up a lightweight HTTP server serving the real module files plus a mock
 * /api/debug/errors endpoint, then drives headless Chromium to verify the key
 * behavioural contracts of the error logger:
 *
 *   1. Resource-load failures captured (#332) — the capture-phase listener
 *   2. Runtime errors logged exactly once (no duplication from capture listener)
 *   3. Reports buffered in localStorage when backend unreachable (#334)
 *   4. Buffer drained and emptied after backend returns
 *   5. No browser hang under error storm against failing backend (#331)
 *
 * Does NOT require a running dev server, Docker, or Postgres. Node + Chromium only.
 *
 * Usage:
 *   node backend/scripts/tests/test-error-logger-browser.js
 *   npm run test:error-logger:browser   (from backend/)
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ── Mock server ───────────────────────────────────────────────────────────────

const received = [];   // payloads accepted by the mock /api/debug/errors
let backendUp = true;  // toggle to simulate backend unavailability

const server = http.createServer(async (req, res) => {
  // Mock ingestion endpoint
  if (req.url === '/api/debug/errors' && req.method === 'POST') {
    if (!backendUp) {
      res.writeHead(503).end('{"error":"down"}');
      return;
    }
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { received.push(JSON.parse(body)); } catch { received.push({ parseError: body }); }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"received":true}');
    });
    return;
  }

  // Test page
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`
<!DOCTYPE html><html><head>
<script type="module" src="/resources/js/error-logger.js"></script>
</head><body><h1>error-logger test harness</h1></body></html>`);
    return;
  }

  // Serve JS modules from the repo (config.js, error-logger.js, etc.)
  if (req.url.startsWith('/resources/js/')) {
    try {
      const filePath = path.join(REPO_ROOT, req.url.split('?')[0]);
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(data);
    } catch {
      res.writeHead(404).end('not found'); // intentional 404 for resource-error test
    }
    return;
  }

  res.writeHead(404).end('not found');
});

// ── Test helpers ──────────────────────────────────────────────────────────────

const passed = [];
const failed = [];

function check(name, condition) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed.push(name);
  } else {
    console.log(`  ❌ ${name}`);
    failed.push(name);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🧪 error-logger browser tests (self-contained)\n');

await new Promise(r => server.listen(0, r));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
console.log(`🌐 Mock server listening on ${base}\n`);

let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'networkidle0' });

  // ── Test 1: resource-load failure captured ────────────────────────────────
  console.log('📍 Test 1 — resource-load failures captured (#332)');
  received.length = 0;
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.src = '/resources/js/does-not-exist.js';
    document.head.appendChild(s);
  });
  await sleep(400);
  const resourceReport = received.find(r => r.type === 'resource-error');
  check('resource-error report received', !!resourceReport);
  check('message field describes the failure',
    /Failed to load <script>/i.test(resourceReport?.message || ''));
  check('filename field contains the failing URL',
    /does-not-exist\.js/.test(resourceReport?.filename || ''));

  // ── Test 2: runtime error logged exactly once (no duplication) ────────────
  console.log('\n📍 Test 2 — runtime errors not duplicated by capture listener (#332)');
  received.length = 0;
  await page.evaluate(() => setTimeout(() => { throw new Error('runtime-test'); }, 0));
  await sleep(400);
  // Puppeteer evaluate context masks thrown messages as "Script error." (cross-origin
  // sandbox) — check count/type rather than message text.
  const runtimeReports = received.filter(r => r.type === 'uncaught-error');
  check('runtime error reported exactly once', runtimeReports.length === 1);

  // ── Test 3: reports buffered when backend down ────────────────────────────
  console.log('\n📍 Test 3 — reports buffered in localStorage when backend unreachable (#334)');
  received.length = 0;
  backendUp = false;
  await page.evaluate(() => console.error('offline-marker'));
  await sleep(400);
  check('nothing delivered to backend while down', received.length === 0);
  const bufLen = await page.evaluate(
    () => JSON.parse(localStorage.getItem('errlog:buffer') || '[]').length,
  );
  check('report persisted in localStorage buffer', bufLen >= 1);

  // ── Test 4: buffer drained after backend returns ──────────────────────────
  console.log('\n📍 Test 4 — buffer drains when backend returns (#334)');
  backendUp = true;
  received.length = 0;
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(600);
  const flushed = received.find(r => /offline-marker/.test(r.message || ''));
  check('buffered report delivered after reload', !!flushed);
  const bufAfter = await page.evaluate(
    () => JSON.parse(localStorage.getItem('errlog:buffer') || '[]').length,
  );
  check('localStorage buffer emptied after flush', bufAfter === 0);

  // ── Test 5: no hang under error storm against failing backend ─────────────
  console.log('\n📍 Test 5 — no browser hang on error storm while backend is down (#331)');
  backendUp = false;
  const completed = await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) console.error('storm-' + i);
    await new Promise(r => setTimeout(r, 400));
    return 'done';
  });
  check('page remains responsive after 5-error storm', completed === 'done');

} catch (err) {
  console.error('\n💥 Test runner crashed:', err.message);
  failed.push(`Runner crashed: ${err.message}`);
} finally {
  if (browser) await browser.close();
  server.close();
}

// ── Summary ───────────────────────────────────────────────────────────────────

const total = passed.length + failed.length;
console.log('\n' + '='.repeat(60));
console.log(`✅ Passed : ${passed.length} / ${total}`);
if (failed.length) {
  console.log(`❌ Failed : ${failed.length}`);
  failed.forEach(n => console.log(`   • ${n}`));
}
console.log('='.repeat(60));

// Machine-parseable summary for deploy scripts / CI
const status = failed.length === 0 ? 'OK' : 'FAIL';
console.log(`[error-logger-browser] status=${status} passed=${passed.length} failed=${failed.length}`);
console.log('');

process.exit(failed.length ? 1 : 0);
