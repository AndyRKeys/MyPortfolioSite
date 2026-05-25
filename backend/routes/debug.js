import { Router } from 'express';
import { logger } from '../utils/logger.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const router = Router();

// ── Environment checks ────────────────────────────────────────────────────────
const IS_DEV = process.env.NODE_ENV !== 'production';

// ── Rate limiting ─────────────────────────────────────────────────────────────
// DB-backed rate limiter — survives container restarts, shared across replicas.
// Same middleware used by the contact route (#337).
const debugRateLimit = createRateLimiter({
  limit: 50,
  windowMs: 60 * 1000,
  message: 'Rate limited',
});

// ── Sanitize log output ───────────────────────────────────────────────────────
// Prevent log injection by truncating/escaping user input before logging.
function sanitizeForLog(str, maxLen = 200) {
  if (typeof str !== 'string') return '[non-string]';
  return str.slice(0, maxLen).replace(/[\n\r]/g, '\\n');
}

/**
 * POST /debug/errors — Receive frontend errors from error-logger.js
 * Logs them server-side for debugging
 * Rate-limited to prevent log flooding; available on dev and production
 */
router.post('/errors', debugRateLimit, (req, res) => {
  logger.debug('[debug/errors] Received frontend error report');

  const { type, message, timestamp, url, filename, lineno, colno, stack } = req.body;

  if (!type || !message) {
    // Sanitize the body before logging to prevent injection
    const bodySample = sanitizeForLog(JSON.stringify(req.body));
    logger.warn({ bodySample }, '[debug/errors] Malformed error report');
    return res.json({ received: false, error: 'Missing type or message' });
  }

  // Sanitize all fields before logging
  const typeLog = sanitizeForLog(type, 50);
  const messageLog = sanitizeForLog(message, 200);
  const urlLog = sanitizeForLog(url, 300);
  const filenameLog = filename ? sanitizeForLog(filename, 100) : null;

  const stackLog = stack
    ? sanitizeForLog(stack, 300).split('\\n').slice(0, 3).join(' | ')
    : undefined;
  logger.error(
    {
      type: typeLog,
      url: urlLog,
      file: filenameLog,
      lineno,
      colno,
      clientTimestamp: timestamp,
      stack: stackLog,
    },
    `[debug/errors] Frontend error — ${messageLog}`
  );

  res.json({ received: true });
});

/**
 * POST /debug/csp-violations — Receive CSP policy violation reports
 * Browser sends these when a resource violates Content-Security-Policy
 * Rate-limited to prevent log flooding; available on dev and production
 */
router.post('/csp-violations', debugRateLimit, (req, res) => {
  const report = req.body['csp-report'] || req.body;
  const { 'document-uri': url, 'violated-directive': directive, 'blocked-uri': blocked, 'source-file': source } = report;

  // Sanitize before logging
  const urlLog = sanitizeForLog(url, 200);
  const directiveLog = sanitizeForLog(directive, 100);
  const blockedLog = sanitizeForLog(blocked, 200);
  const sourceLog = source ? sanitizeForLog(source, 200) : 'unknown';

  logger.warn(
    { url: urlLog, directive: directiveLog, blocked: blockedLog, source: sourceLog },
    '[debug/csp-violations] CSP violation reported'
  );

  res.json({ received: true });
});

/**
 * GET /debug/errors — View logged errors (dev only)
 * Later: could add admin dashboard to view these
 */
router.get('/errors', (req, res) => {
  if (!IS_DEV) {
    return res.status(403).json({ error: 'Debug endpoints not available in production' });
  }

  res.json({
    message: 'Frontend error logging is active. Check server console for errors.',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /debug/test-errors — Trigger test errors for verification (dev only)
 * Used by post-deployment tests to verify error logging is working
 * Returns HTML that triggers multiple error types
 */
router.get('/test-errors', (req, res) => {
  if (!IS_DEV) {
    return res.status(403).json({ error: 'Debug endpoints not available in production' });
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Error Logger Test</title>
  <!-- Load error logger first so it captures all errors -->
  <script type="module" src="/resources/js/error-logger.js"></script>
  <!-- Load test script from external file to comply with CSP (no inline scripts) -->
  <script type="module" src="/resources/js/test-errors.js"></script>
</head>
<body>
  <h1>Error Logger Test in Progress</h1>
  <p>Check server logs for 4 test errors...</p>
</body>
</html>
  `);
});

/**
 * POST /debug/test-complete — Signal that test errors have been logged (dev only)
 * Used by deployment script to verify logging completed
 */
router.post('/test-complete', (req, res) => {
  if (!IS_DEV) {
    return res.status(403).json({ error: 'Debug endpoints not available in production' });
  }

  logger.info('[debug/test-complete] Error logger test complete');
  res.json({ status: 'test-complete' });
});

export default router;
