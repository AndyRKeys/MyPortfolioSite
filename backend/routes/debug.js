import { Router } from 'express';

const router = Router();

/**
 * POST /debug/errors — Receive frontend errors from error-logger.js
 * Logs them server-side for debugging
 * No auth required — needs to work for public site errors
 */
router.post('/errors', (req, res) => {
  // Log receipt of any request (for diagnostics if request is malformed)
  console.log(`[error-logger] Received POST to /debug/errors`);

  const { type, message, timestamp, url, filename, lineno, colno, stack } = req.body;

  if (!type || !message) {
    console.warn(`[error-logger] Malformed error report: missing type or message. Received: ${JSON.stringify(req.body)}`);
    return res.json({ received: false, error: 'Missing type or message' });
  }

  // Log to server console with context
  const context = `[${type}] ${url} ${filename ? `@ ${filename}:${lineno}:${colno}` : ''}`;
  console.error(`\n🔴 FRONTEND ERROR: ${context}\n  Message: ${message}\n  Time: ${timestamp}`);
  if (stack) {
    console.error(`  Stack: ${stack.split('\n').slice(0, 3).join('\n    ')}`);
  }

  res.json({ received: true });
});

/**
 * POST /debug/csp-violations — Receive CSP policy violation reports
 * Browser sends these when a resource violates Content-Security-Policy
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy-Report-Only
 */
router.post('/csp-violations', (req, res) => {
  const report = req.body['csp-report'] || req.body;
  const { 'document-uri': url, 'violated-directive': directive, 'blocked-uri': blocked, 'source-file': source } = report;

  console.warn(`\n⚠️  CSP VIOLATION: ${url}\n  Directive: ${directive}\n  Blocked: ${blocked}\n  Source: ${source}`);

  res.json({ received: true });
});

/**
 * GET /debug/errors — View logged errors (dev only)
 * Later: could add admin dashboard to view these
 */
router.get('/errors', (req, res) => {
  res.json({
    message: 'Frontend error logging is active. Check server console for errors.',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /debug/test-errors — Trigger test errors for verification
 * Used by post-deployment tests to verify error logging is working
 * Returns HTML that triggers multiple error types
 */
router.get('/test-errors', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Error Logger Test</title>
  <!-- Load error logger first so it captures all errors -->
  <script type="module" src="/resources/java/error-logger.js"></script>
  <script type="module">
    import { API_BASE } from '/resources/java/config.js';

    // Wait for error logger to load, then trigger test errors
    setTimeout(() => {
      console.log('Testing error logger...');

      // Test 1: console.error
      console.error('Test error #1: console.error triggered');

      // Test 2: console.warn
      console.warn('Test error #2: console.warn triggered');

      // Test 3: uncaught error
      setTimeout(() => {
        throw new Error('Test error #3: uncaught JavaScript error');
      }, 100);

      // Test 4: unhandled rejection
      setTimeout(() => {
        Promise.reject(new Error('Test error #4: unhandled promise rejection'));
      }, 200);

      // Report back after errors are logged
      setTimeout(() => {
        fetch(\`\${API_BASE}/debug/test-complete\`, { method: 'POST' }).catch(() => {});
      }, 1000);
    }, 500);
  </script>
</head>
<body>
  <h1>Error Logger Test in Progress</h1>
  <p>Check server logs for 4 test errors...</p>
</body>
</html>
  `);
});

/**
 * POST /debug/test-complete — Signal that test errors have been logged
 * Used by deployment script to verify logging completed
 */
router.post('/test-complete', (req, res) => {
  console.log('✅ Error logger test complete');
  res.json({ status: 'test-complete' });
});

export default router;
