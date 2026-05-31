#!/usr/bin/env node
/**
 * Load each public page in a real browser and fail if any unhandled JS
 * exceptions occur. Catches the class of errors (null dereferences, failed
 * imports) that curl-based smoke tests cannot see.
 *
 * Discovered during #389 (jQuery removal): blog and travel pages had JS errors
 * that the HTTP smoke suite did not flag. Only visible once a browser ran the
 * page JS.
 *
 * Usage: node test-public-pages.js <base-url>
 * Example: node test-public-pages.js https://nginx:3001
 *
 * Exits 0 if all pages load without unhandled JS errors.
 * Exits 1 if any page throws an unhandled exception.
 *
 * IMPORTANT: intercepts POST /api/debug/errors so headless-Chromium internal
 * noise ("Couldn't load fs/zlib" etc.) does not write to the live client_errors
 * table and trigger false alert emails.
 */

import puppeteer from 'puppeteer';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node test-public-pages.js <base-url>');
  process.exit(1);
}

// Static pages always included — individual content pages added dynamically below.
const STATIC_PAGES = [
    '/', '/blog/', '/travel/', '/login/', '/setup/',
    // Admin sub-pages (#378) — unauthenticated load still runs all page JS before the auth redirect
    '/admin/', '/admin/posts.html', '/admin/travel.html', '/admin/deploy.html',
    '/admin/media.html', '/admin/stats.html', '/admin/settings.html',
];

// ── Dynamic slug discovery ────────────────────────────────────────────────────

// Fetch the first item from an API endpoint and return the value of `field`.
// Uses a puppeteer page so the browser's --ignore-certificate-errors flag
// handles the self-signed dev cert — no Node-level TLS bypass needed.
// Returns null if the request fails or no item is found.
async function fetchFirstField(browser, apiPath, field) {
  const page = await browser.newPage();
  try {
    const items = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        return res.ok ? res.json() : null;
      } catch { return null; }
    }, `${baseUrl}${apiPath}`);
    const found = Array.isArray(items) ? items.find((i) => i[field]) : null;
    return found ? found[field] : null;
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

// ── Test runner ───────────────────────────────────────────────────────────────

let browser;
const results = { passed: [], failed: [] };

async function testPage(page, path) {
  const url = `${baseUrl}${path}`;
  const pageErrors = [];

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/debug/errors')) {
      req.respond({ status: 200, contentType: 'application/json', body: '{"received":true}' });
      return;
    }
    req.continue();
  });

  page.on('pageerror', (err) => {
    if (!err.message.includes('-extension://')) {
      pageErrors.push(err.message);
    }
  });

  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (err) {
    results.failed.push(`${path} — navigation failed: ${err.message}`);
    console.log(`  ❌ ${path} — navigation failed: ${err.message}`);
    return;
  }

  const status = response ? response.status() : 0;
  // 401 is expected for pages that redirect unauthenticated users — still load the page JS
  if (!response || (status >= 400 && status !== 401)) {
    results.failed.push(`${path} — HTTP ${status}`);
    console.log(`  ❌ ${path} — HTTP ${status}`);
    return;
  }

  // Allow deferred module imports and inline scripts to finish executing
  await new Promise((r) => setTimeout(r, 1500));

  if (pageErrors.length === 0) {
    results.passed.push(path);
    console.log(`  ✅ ${path}`);
  } else {
    results.failed.push(`${path} — ${pageErrors.length} JS error(s): ${pageErrors[0]}`);
    console.log(`  ❌ ${path} — ${pageErrors.length} unhandled JS error(s):`);
    pageErrors.forEach((e) => console.log(`     • ${e}`));
  }
}

async function run() {
  console.log(`\n🧪 Public Pages — JS Runtime Error Check`);
  console.log(`📍 Base URL: ${baseUrl}\n`);

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

    // Discover live content slugs/ids so post pages are exercised too (#397).
    // Done via a browser page so --ignore-certificate-errors covers the self-signed
    // dev cert — no rejectUnauthorized bypass in Node code.
    const [blogSlug, travelId] = await Promise.all([
      fetchFirstField(browser, '/api/posts', 'slug'),
      fetchFirstField(browser, '/api/travel', 'id'),
    ]);

    const pages = [...STATIC_PAGES];

    if (blogSlug) {
      pages.push(`/blog/post/?slug=${encodeURIComponent(blogSlug)}`);
      console.log(`  ℹ️  blog post discovered: /blog/post/?slug=${blogSlug}`);
    } else {
      console.log('  ⚠️  no published blog post found — /blog/post/ skipped');
    }

    if (travelId) {
      pages.push(`/travel/post/?id=${encodeURIComponent(travelId)}`);
      console.log(`  ℹ️  travel post discovered: /travel/post/?id=${travelId}`);
    } else {
      console.log('  ⚠️  no travel memory found — /travel/post/ skipped');
    }

    console.log('');

    for (const path of pages) {
      const page = await browser.newPage();
      await testPage(page, path);
      await page.close();
    }
  } catch (err) {
    results.failed.push(`Test runner crashed: ${err.message}`);
    console.error(`\n❌ Test runner crashed: ${err.message}`);
  } finally {
    if (browser) await browser.close();

    const total = results.passed.length + results.failed.length;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ Passed: ${results.passed.length} / ${total}`);
    if (results.failed.length) {
      console.log(`❌ Failed: ${results.failed.length}`);
      results.failed.forEach((r) => console.log(`   • ${r}`));
    }
    console.log(`${'='.repeat(50)}`);
    const status = results.failed.length > 0 ? 'FAIL' : 'OK';
    console.log(
      `[public-pages] status=${status} passed=${results.passed.length} ` +
        `failed=${results.failed.length} total=${total}\n`,
    );
    process.exit(results.failed.length > 0 ? 1 : 0);
  }
}

run().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
