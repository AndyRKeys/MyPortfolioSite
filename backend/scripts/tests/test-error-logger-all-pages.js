#!/usr/bin/env node
/**
 * Verify error-logger.js initialises without errors on every public page.
 *
 * Usage: node test-error-logger-all-pages.js <base-url>
 * Example: node test-error-logger-all-pages.js https://nginx:3001
 *
 * Exits 0 if all pages initialise the error logger successfully.
 * Exits 1 if any page fails to load or the logger fails to initialise.
 */

import puppeteer from 'puppeteer';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node test-error-logger-all-pages.js <base-url>');
  process.exit(1);
}

// Public pages that should all load error-logger.js.
const PAGES = ['/', '/blog/', '/travel/', '/login/'];

let browser;
const results = { passed: [], failed: [] };

async function testPage(page, path) {
  const url = `${baseUrl}${path}`;
  const loggerLogs = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    if (msg.text().includes('[error-logger]')) loggerLogs.push(msg.text());
  });
  page.on('pageerror', (err) => {
    // Ignore errors from browser extensions (moz-extension://, chrome-extension://)
    if (!err.message.includes('-extension://')) pageErrors.push(err.message);
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
  if (!response || (status >= 400 && status !== 401)) {
    results.failed.push(`${path} — HTTP ${status}`);
    console.log(`  ❌ ${path} — HTTP ${status}`);
    return;
  }

  // Give the page a moment to run inline scripts
  await new Promise((r) => setTimeout(r, 1000));

  const initialized = loggerLogs.some((m) => m.includes('Initializing'));
  if (initialized) {
    results.passed.push(`${path} — error logger initialised`);
    console.log(`  ✅ ${path}`);
  } else {
    results.failed.push(`${path} — error logger did not initialise (no [error-logger] Initializing log)`);
    console.log(`  ❌ ${path} — error logger did not initialise`);
    if (loggerLogs.length) console.log(`     logger logs: ${loggerLogs.join('; ')}`);
    if (pageErrors.length) console.log(`     page errors: ${pageErrors.slice(0, 3).join('; ')}`);
  }
}

async function run() {
  console.log(`\n🧪 Error Logger — All Pages Test`);
  console.log(`📍 Base URL: ${baseUrl}\n`);

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--ignore-certificate-errors', // needed for self-signed dev certs
      ],
    });

    for (const path of PAGES) {
      const page = await browser.newPage();
      await testPage(page, path);
      await page.close();
    }
  } catch (err) {
    results.failed.push(`Test runner crashed: ${err.message}`);
    console.error(`\n❌ Test runner crashed: ${err.message}`);
  } finally {
    if (browser) await browser.close();

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ Passed: ${results.passed.length} / ${PAGES.length}`);
    if (results.failed.length) {
      console.log(`❌ Failed: ${results.failed.length}`);
      results.failed.forEach((r) => console.log(`   • ${r}`));
    }
    console.log(`${'='.repeat(50)}\n`);
    process.exit(results.failed.length > 0 ? 1 : 0);
  }
}

run().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
