#!/usr/bin/env node
/**
 * Automated error logger test using headless browser (Puppeteer)
 * Tests that error-logger.js properly captures and sends errors to backend
 *
 * Usage: node test-error-logger.js <url>
 * Example: node test-error-logger.js https://192.168.1.100:3001
 */

import fs from 'fs';
import puppeteer from 'puppeteer';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node test-error-logger.js <base-url>');
  console.error('Example: node test-error-logger.js https://192.168.1.100:3001');
  process.exit(1);
}

// When running inside a Docker container, use the internal service hostname
// Check for Docker by looking for /.dockerenv or docker in cgroup
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

const baseUrl = isInsideDocker ? 'https://nginx-dev:3001' : url;
const testUrl = `${baseUrl}/api/debug/test-errors`;

// Debug: show URL selection
console.error(`[DEBUG] isInsideDocker=${isInsideDocker}, baseUrl=${baseUrl}`);

let browser;
let results = {
  passed: [],
  failed: [],
};

async function runTest() {
  try {
    console.log(`\n🧪 Error Logger Automated Test`);
    console.log(`📍 Target: ${testUrl}\n`);

    // Launch headless browser
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
    const consoleMessages = [];
    const networkRequests = [];

    // Capture console messages from the page
    page.on('console', (msg) => {
      const text = `[${msg.type().toUpperCase()}] ${msg.text()}`;
      consoleMessages.push(text);
      if (msg.type() === 'error' || msg.type() === 'log') {
        console.log(`  Console: ${text}`);
      }
    });

    // Capture network requests (looking for fetch to /debug/errors)
    page.on('request', (request) => {
      if (request.url().includes('/debug/errors') || request.url().includes('/debug/test-complete')) {
        networkRequests.push({
          method: request.method(),
          url: request.url(),
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Allow insecure connections for self-signed certificates
    await page.setDefaultNavigationTimeout(30000);
    await page.setDefaultTimeout(30000);

    console.log(`⏳ Navigating to test page...`);
    const response = await page.goto(testUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    if (!response || !response.ok()) {
      results.failed.push(`HTTP ${response?.status() || 'unknown'} - Failed to load test page`);
      console.log(`  ❌ Test page returned HTTP ${response?.status()}`);
      return;
    }
    console.log(`  ✅ Test page loaded (HTTP ${response.status()})`);
    results.passed.push('Test page loaded successfully');

    // Wait for errors to be triggered and sent (test script waits 500ms + delays for errors)
    console.log(`⏳ Waiting for test errors to be triggered and sent...`);
    await page.waitForTimeout(3000);

    // Check what was logged
    console.log(`\n📋 Console Log Analysis:`);
    const errorLoggerLogs = consoleMessages.filter((msg) =>
      msg.includes('[error-logger]') || msg.includes('Testing error logger')
    );

    if (errorLoggerLogs.length > 0) {
      console.log(`  Found ${errorLoggerLogs.length} error-logger related messages:`);
      errorLoggerLogs.forEach((log) => console.log(`    ${log}`));
      results.passed.push(`Error logger initialized (${errorLoggerLogs.length} log messages)`);
    } else {
      results.failed.push('No error-logger initialization logs found');
      console.log(`  ❌ No error-logger logs found in console`);
    }

    console.log(`\n🌐 Network Requests:`);
    if (networkRequests.length > 0) {
      console.log(`  Found ${networkRequests.length} requests to debug endpoints:`);
      networkRequests.forEach((req) => console.log(`    ${req.method} ${req.url}`));
      results.passed.push(`Error reports sent (${networkRequests.length} requests)`);

      // Check for POST to /debug/errors (error reports)
      const errorReports = networkRequests.filter((r) => r.method === 'POST' && r.url.includes('/debug/errors'));
      if (errorReports.length > 0) {
        console.log(`\n  ✅ Error reports POST requests found: ${errorReports.length}`);
      } else {
        console.log(`\n  ⚠️ No POST requests to /debug/errors found`);
        results.failed.push('No error report POST requests detected');
      }

      // Check for POST to /debug/test-complete (test completion signal)
      const testComplete = networkRequests.filter((r) => r.method === 'POST' && r.url.includes('/debug/test-complete'));
      if (testComplete.length > 0) {
        console.log(`  ✅ Test completion signal sent`);
        results.passed.push('Test completion signal received');
      }
    } else {
      results.failed.push('No network requests to debug endpoints detected');
      console.log(`  ❌ No network requests detected`);
    }

    // Check for test errors in console (should see Test error #1, #2, #3, #4)
    const testErrors = consoleMessages.filter((msg) => msg.includes('Test error'));
    console.log(`\n🚨 Test Errors Triggered:`);
    if (testErrors.length > 0) {
      console.log(`  Found ${testErrors.length} test error messages:`);
      testErrors.forEach((err) => console.log(`    ${err}`));
      results.passed.push(`Test errors triggered (${testErrors.length} detected)`);
    } else {
      results.failed.push('Test errors not found in console');
      console.log(`  ❌ Test error messages not found`);
    }

    // Verify error-logger is working by checking for specific markers
    const sendingErrors = consoleMessages.filter((msg) => msg.includes('[error-logger] Sending'));
    console.log(`\n📤 Error Logger Sending Attempts:`);
    if (sendingErrors.length > 0) {
      console.log(`  ✅ Error logger attempted to send ${sendingErrors.length} errors`);
      sendingErrors.forEach((msg) => console.log(`    ${msg}`));
      results.passed.push(`Error logger sent ${sendingErrors.length} reports`);
    } else {
      console.log(`  ⚠️ No error sending attempts logged`);
    }

  } catch (error) {
    results.failed.push(`Test crashed: ${error.message}`);
    console.error(`\n❌ Test failed: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }

    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Passed: ${results.passed.length}`);
    results.passed.forEach((r) => console.log(`   • ${r}`));

    if (results.failed.length > 0) {
      console.log(`\n❌ Failed: ${results.failed.length}`);
      results.failed.forEach((r) => console.log(`   • ${r}`));
      console.log(`${'='.repeat(60)}\n`);
      process.exit(1);
    } else {
      console.log(`${'='.repeat(60)}\n`);
      process.exit(0);
    }
  }
}

runTest().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
