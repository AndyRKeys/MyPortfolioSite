#!/usr/bin/env node
/**
 * Comprehensive error logger test — validates error-logger.js is loaded on ALL pages
 * Tests that error logging works site-wide, not just on test endpoints
 *
 * Usage: node test-error-logger-all-pages.js <base-url>
 * Example: node test-error-logger-all-pages.js https://localhost:3001
 */

import fs from 'fs';
import puppeteer from 'puppeteer';

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node test-error-logger-all-pages.js <base-url>');
  console.error('Example: node test-error-logger-all-pages.js https://localhost:3001');
  process.exit(1);
}

// All pages to test (relative to root)
const pages = [
  '/',
  '/index.html',
  '/blog.html',
  '/blog-post.html',
  '/travel.html',
  '/travel-post.html',
  '/admin.html',
  '/login.html',
  '/setup.html',
];

// Detect Docker for internal service names
let isInsideDocker = false;
try {
  isInsideDocker = fs.existsSync('/.dockerenv');
  if (!isInsideDocker) {
    const cgroup = fs.readFileSync('/proc/cgroup', 'utf8');
    isInsideDocker = cgroup.includes('docker') || cgroup.includes('/docker');
  }
} catch (e) {
  isInsideDocker = false;
}

// Inside Docker, reach nginx by its compose service name; show the original URL to the user
const testBaseUrl = isInsideDocker ? baseUrl.replace(/https?:\/\/[^:/]+/, 'https://nginx-dev') : baseUrl;
const displayUrl = baseUrl;

let browser;
const results = {
  passed: [],
  failed: [],
  pages: {},
};

async function runTest() {
  try {
    console.log(`\n🧪 Error Logger Site-Wide Test`);
    console.log(`📍 Testing all pages on: ${displayUrl}\n`);

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
    await page.setDefaultNavigationTimeout(30000);
    await page.setDefaultTimeout(30000);

    // Test each page
    for (const pagePath of pages) {
      await testPage(page, pagePath);
    }

    // Print results
    printResults();

  } catch (error) {
    results.failed.push(`Test crashed: ${error.message}`);
    console.error(`\n❌ Test failed: ${error.message}`);
    printResults();
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function testPage(page, pagePath) {
  const pageUrl = `${testBaseUrl}${pagePath}`;
  const pageKey = pagePath === '/' ? 'index' : pagePath.replace(/\.html$/, '').replace(/\//g, '');

  console.log(`⏳ Testing ${pagePath}...`);

  results.pages[pageKey] = {
    path: pagePath,
    url: pageUrl,
    status: null,
    errorLoggerLoaded: false,
    consoleErrors: [],
    errorsSent: 0,
  };

  try {
    const consoleMessages = [];
    const networkRequests = [];

    // Capture console messages
    page.on('console', (msg) => {
      consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
      });
    });

    // Capture network requests to error endpoint
    page.on('request', (request) => {
      if (request.url().includes('/debug/errors')) {
        networkRequests.push(request.url());
      }
    });

    // Navigate to page
    const response = await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    if (!response || !response.ok()) {
      results.pages[pageKey].status = response?.status() || 'unknown';
      results.failed.push(`${pagePath}: HTTP ${response?.status()}`);
      console.log(`  ❌ Page returned HTTP ${response?.status()}`);
      return;
    }

    results.pages[pageKey].status = response.status();

    // Check if error-logger is loaded
    const errorLoggerLoaded = consoleMessages.some(
      (msg) => msg.text.includes('[error-logger]') && msg.text.includes('Initializing')
    );

    results.pages[pageKey].errorLoggerLoaded = errorLoggerLoaded;
    results.pages[pageKey].consoleErrors = consoleMessages.filter((m) => m.type === 'error').length;
    results.pages[pageKey].errorsSent = networkRequests.length;

    if (errorLoggerLoaded) {
      console.log(`  ✅ Error logger loaded`);
      results.passed.push(`${pagePath}: error-logger loaded`);
    } else {
      console.log(`  ⚠️ Error logger NOT loaded`);
      results.failed.push(`${pagePath}: error-logger not detected`);
    }

    if (consoleMessages.some((m) => m.type === 'error')) {
      console.log(`  ⚠️ Console errors detected: ${consoleMessages.filter((m) => m.type === 'error').length}`);
    }

  } catch (error) {
    results.pages[pageKey].status = `error: ${error.message}`;
    results.failed.push(`${pagePath}: ${error.message}`);
    console.log(`  ❌ Navigation failed: ${error.message}`);
  }
}

const DIVIDER = '═'.repeat(70);
const THIN    = '─'.repeat(70);

function printResults() {
  const pageEntries = Object.entries(results.pages);
  const loadedCount = pageEntries.filter(([, r]) => r.errorLoggerLoaded).length;
  const totalPages = pageEntries.length;
  const allPassed = results.failed.length === 0;

  console.log(`\n${DIVIDER}`);
  console.log(`📊 RESULTS — Error Logger Coverage Across All Pages`);
  console.log(`${DIVIDER}\n`);

  console.log(`Coverage: ${loadedCount}/${totalPages} pages have error-logger loaded\n`);

  console.log(`${'Page'.padEnd(20)} ${'Status'.padEnd(8)} ${'Logger'.padEnd(10)} ${'Errors'.padEnd(8)} ${'Sent'}`);
  console.log(THIN);

  for (const [, result] of pageEntries) {
    const statusStr = result.status === 200 ? '✓ 200' : `✗ ${result.status}`;
    const loggerStr = result.errorLoggerLoaded ? '✓ Yes' : '✗ No';
    const errorsStr = String(result.consoleErrors > 0 ? result.consoleErrors : '—');
    const sentStr   = String(result.errorsSent > 0 ? result.errorsSent : '—');

    console.log(
      `${result.path.padEnd(20)} ${statusStr.padEnd(8)} ${loggerStr.padEnd(10)} ${errorsStr.padEnd(8)} ${sentStr}`
    );
  }

  console.log(`\n${DIVIDER}`);

  if (allPassed) {
    console.log(`✅ All checks passed: ${results.passed.length}`);
    console.log(`${DIVIDER}\n`);
    process.exit(0);
  } else {
    console.log(`❌ Failed: ${results.failed.length}`);
    results.failed.forEach((r) => console.log(`   • ${r}`));
    console.log(`${DIVIDER}\n`);
    process.exit(1);
  }
}

runTest().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
