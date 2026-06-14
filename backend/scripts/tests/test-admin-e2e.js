#!/usr/bin/env node
/**
 * Admin E2E test suite.
 *
 * Covers two levels:
 *   Smoke       — admin page loads authenticated; each section is present and
 *                 free of JS console errors on load.
 *   Interaction — create/delete a blog post; create/delete a travel memory;
 *                 trigger a git fetch and verify streaming output.
 *
 * Auth: mints a short-lived JWT from JWT_SECRET (same technique as the
 * regression suite) and injects it into localStorage.adminToken — no passkey
 * ceremony needed. authenticate() in the backend only validates the signature,
 * so any valid JWT works.
 *
 * Test data uses an [E2E] prefix so entries are identifiable if cleanup fails.
 * Cleanup runs in a finally block even on crash.
 *
 * Exit code: 1 on any failure — failing admin E2E blocks the deploy because
 * the admin panel is required to manage site content.
 *
 * Runs inside the backend container post-deploy (Chromium ships in the image).
 * Uses NGINX_URL (docker-internal, e.g. https://nginx:3001).
 *
 * Usage:
 *   node test-admin-e2e.js <base-url>
 *   npm run test:admin-e2e -- https://nginx:3001
 *
 * Output (machine-parseable summary line):
 *   [admin-e2e] status=OK|FAIL smoke=N/N interactions=N/N
 */

import puppeteer from 'puppeteer';
import jwt       from 'jsonwebtoken';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node test-admin-e2e.js <base-url>');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[admin-e2e] JWT_SECRET not set — cannot mint test token');
  console.error('[admin-e2e] status=SKIP smoke=0/0 interactions=0/0');
  process.exit(0);
}

const TEST_PREFIX  = '[E2E]';
const TEST_TITLE   = `${TEST_PREFIX} Admin E2E test post`;
const TEST_TRAVEL  = `${TEST_PREFIX} Admin E2E test memory`;

const testToken = jwt.sign({ userId: 'e2e-test' }, JWT_SECRET, { expiresIn: '5m' });

// ── Counters ──────────────────────────────────────────────────────────────────

let smokePass = 0, smokeTotal = 0;
let interactPass = 0, interactTotal = 0;
const failures = [];

function pass(label) {
  console.log(`  ✅ ${label}`);
}

function fail(label, detail = '') {
  console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
  failures.push(label + (detail ? ': ' + detail : ''));
}

function smoke(label, ok, detail = '') {
  smokeTotal++;
  if (ok) { smokePass++; pass(label); }
  else    { fail(label, detail); }
}

function interact(label, ok, detail = '') {
  interactTotal++;
  if (ok) { interactPass++; pass(label); }
  else    { fail(label, detail); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Wait for an element matching selector to contain the given text (up to ms).
async function waitForText(page, selector, text, ms = 8000) {
  await page.waitForFunction(
    (sel, txt) => {
      const el = document.querySelector(sel);
      return el && el.textContent.includes(txt);
    },
    { timeout: ms },
    selector, text,
  );
}

// Find the delete button inside the list row whose title matches text.
async function findDeleteBtn(page, listSelector, titleText) {
  return page.evaluateHandle((listSel, title) => {
    const list = document.querySelector(listSel);
    if (!list) return null;
    const rows = list.querySelectorAll('.saved-memory-row');
    for (const row of rows) {
      const strong = row.querySelector('strong');
      if (strong && strong.textContent.trim() === title) {
        const btns = row.querySelectorAll('.btn-small.btn-danger');
        for (const btn of btns) {
          if (btn.textContent.trim() === 'Delete') return btn;
        }
      }
    }
    return null;
  }, listSelector, titleText);
}

// Returns true if the list contains a row with the given title text.
async function listContains(page, listSelector, titleText) {
  return page.evaluate((listSel, title) => {
    const list = document.querySelector(listSel);
    if (!list) return false;
    return Array.from(list.querySelectorAll('strong'))
      .some(el => el.textContent.trim() === title);
  }, listSelector, titleText);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🧪 Admin E2E test suite');
console.log(`📍 Base URL: ${baseUrl}\n`);

let browser;

try {
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors',
    ],
  });

  const page = await browser.newPage();

  // Suppress debug/errors POSTs so test runs don't pollute the client_errors table.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/debug/errors')) {
      req.respond({ status: 200, contentType: 'application/json', body: '{"received":true}' });
      return;
    }
    req.continue();
  });

  // Collect console errors and unhandled JS exceptions for smoke checks (#397).
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => {
    if (!err.message.includes('-extension://')) pageErrors.push(err.message);
  });

  // Auto-accept all confirm() dialogs (delete confirmations, etc.).
  page.on('dialog', async dialog => dialog.accept());

  // ── Authenticated page load ──────────────────────────────────────────────

  console.log('── Smoke tests ─────────────────────────────────────────────');

  // Load unauthenticated first so we can set localStorage on the origin.
  await page.goto(`${baseUrl}/admin/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.evaluate(token => localStorage.setItem('adminToken', token), testToken);

  // Discard errors from the unauthenticated first load (401s from init calls
  // that fired before the token was in localStorage — expected, not a bug).
  consoleErrors.length = 0;

  // Reload as authenticated.
  await page.goto(`${baseUrl}/admin/`, { waitUntil: 'networkidle0', timeout: 30000 });

  // S1: page loads authenticated (not redirected to login)
  const url = page.url();
  smoke('Page loads authenticated (no redirect to login)', url.includes('/admin/'), `landed at ${url}`);

  // S2: no console errors on load
  // Filter known noise (zlib warning from exifr is cosmetic and not a code error)
  const realErrors = consoleErrors.filter(e => !e.includes('zlib'));
  smoke('No JS console errors on page load', realErrors.length === 0, realErrors.join('; '));

  // S2b: no unhandled JS exceptions on load (#397)
  smoke('No unhandled JS exceptions on page load', pageErrors.length === 0, pageErrors.join('; '));
  const pageErrorsAtLoad = pageErrors.length; // snapshot — S-final only reports new errors from interactions

  // S3: admin sub-nav present and Dashboard is the active item (#378)
  const subnavExists = await page.$('.admin-subnav') !== null;
  smoke('Admin sub-nav present', subnavExists, '.admin-subnav not found');
  if (subnavExists) {
    const activeLabel = await page.$eval('.admin-subnav-item.active', el => el.textContent.trim()).catch(() => '');
    smoke('Dashboard active in sub-nav', activeLabel.includes('Dashboard'), `active item: "${activeLabel}"`);
  }

  // S4: all 7 dashboard navigation cards present (#378, +Activity card from #155)
  const cardCount = await page.$$eval('.admin-dashboard-card', els => els.length).catch(() => 0);
  smoke('Dashboard has 7 navigation cards', cardCount === 7, `found ${cardCount}`);

  // ── Interaction tests ────────────────────────────────────────────────────

  console.log('\n── Interaction tests ───────────────────────────────────────');

  // ── I1: create a blog post ───────────────────────────────────────────────
  console.log('\n📝 I1 — create blog post');
  await page.goto(`${baseUrl}/admin/posts.html`, { waitUntil: 'networkidle0', timeout: 20000 });
  try {
    await page.waitForSelector('#post-title', { timeout: 5000 });
    await page.$eval('#post-title', el => { el.value = ''; });
    await page.type('#post-title', TEST_TITLE);
    await page.$eval('#post-date', el => { el.value = '2026-01-01'; });
    await page.$eval('#post-body', el => { el.value = 'E2E test content — safe to delete.'; });

    await page.click('#post-save-btn');
    // Wait for the post to appear in the list — loadAll() runs after save.
    // Don't wait on #post-message: clearForm() calls setMessage('') synchronously
    // right after setMessage('Draft saved.'), so the text is never visible to poll.
    await page.waitForFunction(
      (title) => Array.from(document.querySelectorAll('#posts-admin-list strong'))
        .some(el => el.textContent.trim() === title),
      { timeout: 15000 },
      TEST_TITLE,
    );
    interact('Create blog post — appears in list', true);
  } catch (e) {
    interact('Create blog post', false, e.message);
  }

  // ── I2: delete the blog post ─────────────────────────────────────────────
  console.log('\n🗑️  I2 — delete blog post');
  try {
    const delBtn = await findDeleteBtn(page, '#posts-admin-list', TEST_TITLE);
    const isNull = await page.evaluate(el => el === null, delBtn);
    if (isNull) throw new Error('Delete button not found for test post');

    const deleteRes = page.waitForResponse(
      r => r.url().includes('/api/posts') && r.request().method() === 'DELETE',
      { timeout: 10000 },
    );
    await delBtn.click();
    await deleteRes;
    // List reloads after delete
    await page.waitForFunction(
      (title) => !Array.from(document.querySelectorAll('#posts-admin-list strong'))
        .some(el => el.textContent.trim() === title),
      { timeout: 5000 },
      TEST_TITLE,
    );
    interact('Delete blog post — removed from list', true);
  } catch (e) {
    interact('Delete blog post', false, e.message);
  }

  // ── I3: create a travel memory ───────────────────────────────────────────
  console.log('\n🌍 I3 — create travel memory');
  await page.goto(`${baseUrl}/admin/travel.html`, { waitUntil: 'networkidle0', timeout: 20000 });
  try {
    await page.waitForSelector('#travel-title', { timeout: 5000 });
    await page.$eval('#travel-title', el => { el.value = ''; });
    await page.type('#travel-title', TEST_TRAVEL);
    await page.$eval('#travel-date', el => { el.value = '2026-01-01'; });
    await page.$eval('#travel-notes', el => { el.value = 'E2E test memory — safe to delete.'; });

    await page.click('#travel-save-btn');
    // Same pattern as posts: wait for item in list, not the message.
    await page.waitForFunction(
      (title) => Array.from(document.querySelectorAll('#saved-memories-list strong'))
        .some(el => el.textContent.trim() === title),
      { timeout: 15000 },
      TEST_TRAVEL,
    );
    interact('Create travel memory — appears in list', true);
  } catch (e) {
    interact('Create travel memory', false, e.message);
  }

  // ── I4: delete the travel memory ─────────────────────────────────────────
  console.log('\n🗑️  I4 — delete travel memory');
  try {
    const delBtn = await findDeleteBtn(page, '#saved-memories-list', TEST_TRAVEL);
    const isNull = await page.evaluate(el => el === null, delBtn);
    if (isNull) throw new Error('Delete button not found for test memory');

    const deleteRes = page.waitForResponse(
      r => r.url().includes('/api/travel') && r.request().method() === 'DELETE',
      { timeout: 10000 },
    );
    await delBtn.click();
    await deleteRes;
    await page.waitForFunction(
      (title) => !Array.from(document.querySelectorAll('#saved-memories-list strong'))
        .some(el => el.textContent.trim() === title),
      { timeout: 5000 },
      TEST_TRAVEL,
    );
    interact('Delete travel memory — removed from list', true);
  } catch (e) {
    interact('Delete travel memory', false, e.message);
  }

  // ── I5: deploy fetch streams output ──────────────────────────────────────
  console.log('\n📡 I5 — deploy fetch (git fetch origin)');
  await page.goto(`${baseUrl}/admin/deploy.html`, { waitUntil: 'networkidle0', timeout: 20000 });
  try {
    await page.waitForSelector('#fetch-btn:not([disabled])', { timeout: 8000 });
    await page.click('#fetch-btn');
    // Wait for the output panel to appear and contain at least one character,
    // or for the completion message — whichever comes first.
    await page.waitForFunction(
      () => {
        const msg = document.getElementById('deploy-message');
        const out = document.getElementById('deploy-output');
        return (msg && msg.textContent.includes('Fetch')) ||
               (out && !out.classList.contains('hidden') && out.textContent.length > 0);
      },
      { timeout: 30000 },
    );
    interact('Deploy fetch — output appeared', true);
  } catch (e) {
    interact('Deploy fetch — output appeared', false, e.message);
  }

  // S-final: no unhandled JS exceptions fired during interactions (#397)
  // Uses pageErrorsAtLoad snapshot so errors already reported in S2b aren't double-counted.
  const interactionPageErrors = pageErrors.slice(pageErrorsAtLoad);
  smoke(
    'No unhandled JS exceptions during interactions',
    interactionPageErrors.length === 0,
    interactionPageErrors.join('; '),
  );

} catch (err) {
  console.error('\n💥 Test runner crashed:', err.message);
  failures.push('runner crash: ' + err.message);
} finally {
  // ── Cleanup: delete any [E2E] test data the tests didn't clean up ─────────
  // Uses the browser page (still open) to make authenticated API calls so the
  // browser's --ignore-certificate-errors covers the self-signed dev cert —
  // no rejectUnauthorized bypass in Node code. Best-effort: failures here
  // don't affect the test result.
  if (browser) {
    try {
      const cleanupPage = await browser.newPage();
      const authHeaders = { Authorization: `Bearer ${testToken}`, 'Content-Type': 'application/json' };

      const checkAndDelete = async (listUrl, deleteBase) => {
        try {
          const items = await cleanupPage.evaluate(async (url, headers) => {
            try {
              const r = await fetch(url, { headers });
              return r.ok ? r.json() : [];
            } catch { return []; }
          }, listUrl, authHeaders);
          for (const item of (items || [])) {
            if (item.title?.startsWith(TEST_PREFIX)) {
              await cleanupPage.evaluate(async (url, headers) => {
                try { await fetch(url, { method: 'DELETE', headers }); } catch {}
              }, `${deleteBase}/${item.id}`, authHeaders);
              console.log(`  cleaned up: ${item.title}`);
            }
          }
        } catch { /* best effort */ }
      };

      await checkAndDelete(`${baseUrl}/api/posts/all`, `${baseUrl}/api/posts`);
      await checkAndDelete(`${baseUrl}/api/travel/all`, `${baseUrl}/api/travel`);

      const pages = await browser.pages();
      for (const p of pages) {
        await p.evaluate(() => {
          try { localStorage.removeItem('adminToken'); } catch {}
        }).catch(() => {});
      }
      await cleanupPage.close();
    } catch {}
    await browser.close();
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const totalFailed = failures.length;
const status = totalFailed === 0 ? 'OK' : 'FAIL';

console.log('\n' + '='.repeat(60));
if (totalFailed === 0) {
  console.log(`✅ All tests passed — smoke ${smokePass}/${smokeTotal}, interactions ${interactPass}/${interactTotal}`);
} else {
  console.log(`❌ ${totalFailed} failure(s):`);
  failures.forEach(f => console.log(`   • ${f}`));
}
console.log('='.repeat(60));
console.log(
  `[admin-e2e] status=${status} smoke=${smokePass}/${smokeTotal} interactions=${interactPass}/${interactTotal}\n`,
);

process.exit(totalFailed > 0 ? 1 : 0);
