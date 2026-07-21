/**
 * Verify error-logger.js initialises without errors on every public page.
 *
 * Migrated from scripts/tests/test-error-logger-all-pages.js (Puppeteer → Playwright).
 * Runs on Chromium and Firefox via playwright.config.js.
 *
 * IMPORTANT: intercepts POST /api/debug/errors so headless-browser internal
 * noise ("Couldn't load fs/zlib" etc.) does not write to the live client_errors
 * table and trigger false alert emails. This test only checks that the logger
 * initialises; it does not need real network delivery.
 *
 * Machine-readable summary line (preserved for deploy pipeline compat):
 *   [error-logger-all-pages] status=OK|FAIL passed=N failed=N total=N
 */

import { test, expect } from '@playwright/test';

// Public pages that should all load error-logger.js.
const PAGES = ['/', '/blog/', '/travel/', '/login/'];

// ── Shared results accumulator ────────────────────────────────────────────────

// Counts are accumulated across all test() calls in this file.
// afterAll prints the machine-readable summary for the deploy pipeline.
const results = { passed: 0, failed: 0 };

test.afterAll(() => {
  const total = results.passed + results.failed;
  const status = results.failed === 0 ? 'OK' : 'FAIL';
  // Machine-readable summary — parsed by the deploy report (matches the
  // [error-logger-browser]/[regression] line shape for consistent output).
  console.log(`[error-logger-all-pages] status=${status} passed=${results.passed} failed=${results.failed} total=${total}`);
});

// ── Per-page checks ───────────────────────────────────────────────────────────

test('error-logger initialises on all public pages', async ({ page, baseURL }) => {
  // Block POST /api/debug/errors — prevents headless-browser noise from
  // polluting the live client_errors table and triggering false alert emails.
  await page.route('**/api/debug/errors', (route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"received":true}' });
    } else {
      route.continue();
    }
  });

  let allPassed = true;

  for (const path of PAGES) {
    const url = `${baseURL}${path}`;
    const loggerLogs = [];
    const pageErrors = [];

    const onConsole = (msg) => {
      if (msg.text().includes('[error-logger]')) loggerLogs.push(msg.text());
    };
    const onPageError = (err) => {
      // Ignore errors from browser extensions (moz-extension://, chrome-extension://)
      if (!err.message.includes('-extension://')) pageErrors.push(err.message);
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (err) {
      results.failed++;
      allPassed = false;
      console.log(`  [error-logger-all-pages] FAIL ${path} — navigation failed: ${err.message}`);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      continue;
    }

    const status = response ? response.status() : 0;
    if (!response || (status >= 400 && status !== 401)) {
      results.failed++;
      allPassed = false;
      console.log(`  [error-logger-all-pages] FAIL ${path} — HTTP ${status}`);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      continue;
    }

    // Give the page a moment to run inline scripts
    await page.waitForTimeout(1000);

    page.off('console', onConsole);
    page.off('pageerror', onPageError);

    const initialized = loggerLogs.some((m) => m.includes('Initializing'));
    if (initialized) {
      results.passed++;
      console.log(`  [error-logger-all-pages] PASS ${path} — error logger initialised`);
    } else {
      results.failed++;
      allPassed = false;
      console.log(`  [error-logger-all-pages] FAIL ${path} — error logger did not initialise (no [error-logger] Initializing log)`);
      if (loggerLogs.length) console.log(`     logger logs: ${loggerLogs.join('; ')}`);
      if (pageErrors.length) console.log(`     page errors: ${pageErrors.slice(0, 3).join('; ')}`);
    }
  }

  // Playwright assertion — makes the test red in the runner if any page failed
  expect(allPassed, 'One or more pages did not initialise error-logger — see console output above').toBe(true);
});
