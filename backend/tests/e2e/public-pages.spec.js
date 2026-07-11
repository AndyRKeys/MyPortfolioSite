/**
 * Load each public page in a real browser and fail if any unhandled JS
 * exceptions occur. Catches the class of errors (null dereferences, failed
 * imports) that curl-based smoke tests cannot see.
 *
 * Migrated from scripts/tests/test-public-pages.js (Puppeteer → Playwright).
 * Runs on Chromium and Firefox via playwright.config.js.
 *
 * Discovered during #389 (jQuery removal): blog and travel pages had JS errors
 * that the HTTP smoke suite did not flag. Only visible once a browser ran the
 * page JS.
 *
 * IMPORTANT: intercepts POST /api/debug/errors so headless-browser internal
 * noise ("Couldn't load fs/zlib" etc.) does not write to the live client_errors
 * table and trigger false alert emails.
 *
 * Machine-readable summary line (preserved for deploy pipeline compat):
 *   [public-pages] status=OK|FAIL passed=N failed=N total=N
 */

import { test, expect, chromium } from '@playwright/test';

// ── Static pages ──────────────────────────────────────────────────────────────

// Static pages always included — individual content pages added dynamically below.
const STATIC_PAGES = [
  '/', '/blog/', '/travel/', '/login/', '/setup/',
  // Admin sub-pages (#378) — unauthenticated load still runs all page JS before the auth redirect
  '/admin/', '/admin/posts.html', '/admin/travel.html', '/admin/deploy.html',
  '/admin/media.html', '/admin/stats.html', '/admin/settings.html',
];

// ── Dynamic slug discovery ────────────────────────────────────────────────────

// Fetch the first item from an API endpoint and return the value of `field`.
// Uses a browser page so ignoreHTTPSErrors covers the self-signed dev cert.
// Returns null if the request fails or no item is found.
async function fetchFirstField(page, baseURL, apiPath, field) {
  try {
    const items = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        return res.ok ? res.json() : null;
      } catch { return null; }
    }, `${baseURL}${apiPath}`);
    const found = Array.isArray(items) ? items.find((i) => i[field]) : null;
    return found ? found[field] : null;
  } catch {
    return null;
  }
}

// ── Shared results accumulator ────────────────────────────────────────────────

// Counts are accumulated across all test() calls in this file.
// afterAll prints the machine-readable summary for the deploy pipeline.
const results = { passed: 0, failed: 0 };

test.afterAll(() => {
  const total = results.passed + results.failed;
  const status = results.failed === 0 ? 'OK' : 'FAIL';
  console.log(`[public-pages] status=${status} passed=${results.passed} failed=${results.failed} total=${total}`);
});

// ── Page list builder ─────────────────────────────────────────────────────────

// Build the full page list once (including dynamic slugs) before the test loop.
// Playwright doesn't support dynamic test generation inside beforeAll easily, so
// we use a single test that drives all pages, mirroring the original script's
// sequential approach.

test('all public pages load without unhandled JS errors', async ({ page, baseURL }) => {
  // Block POST /api/debug/errors — prevents headless-browser noise from
  // polluting the live client_errors table and triggering false alert emails.
  await page.route('**/api/debug/errors', (route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"received":true}' });
    } else {
      route.continue();
    }
  });

  // Discover live content slugs so post-detail pages are exercised too (#397).
  const [blogSlug, travelId] = await Promise.all([
    fetchFirstField(page, baseURL, '/api/posts', 'slug'),
    fetchFirstField(page, baseURL, '/api/travel', 'id'),
  ]);

  const pages = [...STATIC_PAGES];

  if (blogSlug) {
    pages.push(`/blog/post/?slug=${encodeURIComponent(blogSlug)}`);
    console.log(`  [public-pages] blog post discovered: /blog/post/?slug=${blogSlug}`);
  } else {
    console.log('  [public-pages] no published blog post found — /blog/post/ skipped');
  }

  if (travelId) {
    pages.push(`/travel/post/?id=${encodeURIComponent(travelId)}`);
    console.log(`  [public-pages] travel post discovered: /travel/post/?id=${travelId}`);
  } else {
    console.log('  [public-pages] no travel memory found — /travel/post/ skipped');
  }

  // ── Per-page checks ───────────────────────────────────────────────────────

  let allPassed = true;

  for (const path of pages) {
    const url = `${baseURL}${path}`;
    const pageErrors = [];

    // Collect unhandled JS exceptions — extension-sourced errors are ignored
    // (same filter as the original Puppeteer script).
    const onPageError = (err) => {
      if (!err.message.includes('-extension://')) {
        pageErrors.push(err.message);
      }
    };
    page.on('pageerror', onPageError);

    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (err) {
      results.failed++;
      allPassed = false;
      console.log(`  [public-pages] FAIL ${path} — navigation failed: ${err.message}`);
      page.off('pageerror', onPageError);
      continue;
    }

    const status = response ? response.status() : 0;
    // 401 is expected for pages that redirect unauthenticated users — still load the page JS
    if (!response || (status >= 400 && status !== 401)) {
      results.failed++;
      allPassed = false;
      console.log(`  [public-pages] FAIL ${path} — HTTP ${status}`);
      page.off('pageerror', onPageError);
      continue;
    }

    // Allow deferred module imports and inline scripts to finish executing
    await page.waitForTimeout(1500);

    page.off('pageerror', onPageError);

    if (pageErrors.length === 0) {
      results.passed++;
      console.log(`  [public-pages] PASS ${path}`);
    } else {
      results.failed++;
      allPassed = false;
      console.log(`  [public-pages] FAIL ${path} — ${pageErrors.length} unhandled JS error(s):`);
      pageErrors.forEach((e) => console.log(`     • ${e}`));
    }
  }

  // Playwright assertion — makes the test red in the runner if any page failed
  expect(allPassed, 'One or more pages had JS errors or HTTP failures — see console output above').toBe(true);
});
