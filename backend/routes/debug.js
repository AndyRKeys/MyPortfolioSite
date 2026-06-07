import { Router } from 'express';
import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveUser } from '../middleware/resolveUser.js';
import { rateLimit } from 'express-rate-limit';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { isEmailConfigured, sendErrorAlertEmail } from '../utils/email.js';

const router = Router();

// ── Environment checks ────────────────────────────────────────────────────────
const IS_DEV = process.env.NODE_ENV !== 'production';

// ── Rate limiting ─────────────────────────────────────────────────────────────
const debugRateLimit = rateLimit({
  windowMs:        60 * 1000,
  limit:           50,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Rate limited' },
  standardHeaders: true,
  legacyHeaders:   false,
  store:           new PostgresStore({ windowMs: 60 * 1000, keyType: 'debug' }),
});

// ── Alert threshold ───────────────────────────────────────────────────────────
// Fire an email when this many errors arrive within the window. Cooldown
// prevents repeated alerts for sustained storms — one email per window max.
const ALERT_THRESHOLD = parseInt(process.env.ERROR_ALERT_THRESHOLD || '20');
const ALERT_WINDOW_MS = parseInt(process.env.ERROR_ALERT_WINDOW_MS  || String(15 * 60 * 1000));
const ALERT_WINDOW_MIN = Math.round(ALERT_WINDOW_MS / 60_000);
let _lastAlertAt = 0;

async function maybeAlert() {
  if (!isEmailConfigured()) return;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  // Cooldown: skip if we already alerted within this window
  if (Date.now() - _lastAlertAt < ALERT_WINDOW_MS) return;

  const windowStart = new Date(Date.now() - ALERT_WINDOW_MS).toISOString();
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM client_errors WHERE received_at > $1',
    [windowStart]
  );
  const count = result.rows[0].count;
  if (count < ALERT_THRESHOLD) return;

  // Fetch top error types/messages for the email body
  const top = await pool.query(
    `SELECT type, message, COUNT(*)::int AS count
       FROM client_errors
      WHERE received_at > $1
      GROUP BY type, message
      ORDER BY count DESC
      LIMIT 5`,
    [windowStart]
  );

  _lastAlertAt = Date.now();
  logger.warn({ count, windowMin: ALERT_WINDOW_MIN }, '[debug/errors] Alert threshold reached — sending email');
  await sendErrorAlertEmail({ count, windowMinutes: ALERT_WINDOW_MIN, topErrors: top.rows, adminEmail });
}

// ── Sanitize log output ───────────────────────────────────────────────────────
function sanitizeForLog(str, maxLen = 200) {
  if (typeof str !== 'string') return '[non-string]';
  return str.slice(0, maxLen).replace(/[\n\r]/g, '\\n');
}

function sanitizeForDb(str, maxLen) {
  if (typeof str !== 'string' && str !== null && str !== undefined) return null;
  if (!str) return null;
  return str.slice(0, maxLen);
}

function isValidUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * POST /debug/errors — Receive frontend errors from error-logger.js.
 * Persists to client_errors table and triggers threshold alerting (#333).
 */
router.post('/errors', debugRateLimit, resolveUser, async (req, res) => {
  const { type, message, timestamp, url, filename, lineno, colno, stack, sessionId, requestId } = req.body;

  if (!type || !message) {
    const bodySample = sanitizeForLog(JSON.stringify(req.body));
    logger.warn({ bodySample }, '[debug/errors] Malformed error report');
    return res.json({ received: false, error: 'Missing type or message' });
  }

  const typeLog      = sanitizeForLog(type, 50);
  const messageLog   = sanitizeForLog(message, 200);
  const urlLog       = sanitizeForLog(url, 300);
  const filenameLog  = filename  ? sanitizeForLog(filename, 100)  : null;
  const sessionIdLog = sessionId ? sanitizeForLog(sessionId, 40)  : null;
  const requestIdLog = requestId ? sanitizeForLog(requestId, 40)  : null;
  const stackLog     = stack
    ? sanitizeForLog(stack, 300).split('\\n').slice(0, 3).join(' | ')
    : undefined;

  logger.error(
    { type: typeLog, url: urlLog, file: filenameLog, lineno, colno,
      clientTimestamp: timestamp, stack: stackLog,
      sessionId: sessionIdLog, requestId: requestIdLog },
    `[debug/errors] Frontend error — ${messageLog}`
  );

  // Persist to DB — failures are non-fatal; reporting must never break the page
  try {
    await pool.query(
      `INSERT INTO client_errors
         (type, message, url, filename, lineno, colno, stack, session_id, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        sanitizeForDb(type, 50),
        sanitizeForDb(message, 1000),
        sanitizeForDb(url, 500),
        sanitizeForDb(filename, 300),
        Number.isInteger(lineno) ? lineno : null,
        Number.isInteger(colno)  ? colno  : null,
        sanitizeForDb(stack, 2000),
        isValidUuid(sessionId) ? sessionId : null,
        isValidUuid(requestId) ? requestId : null,
      ]
    );
    // Check alert threshold asynchronously — don't hold up the response
    maybeAlert().catch(err => logger.error({ err }, '[debug/errors] Alert check failed'));
  } catch (err) {
    logger.error({ err }, '[debug/errors] Failed to persist error to DB');
  }

  res.json({ received: true });
});

/**
 * POST /debug/csp-violations — Receive CSP policy violation reports.
 */
router.post('/csp-violations', debugRateLimit, resolveUser, async (req, res) => {
  const report = req.body['csp-report'] || req.body;
  const { 'document-uri': url, 'violated-directive': directive, 'blocked-uri': blocked, 'source-file': source } = report;

  logger.warn(
    {
      url:       sanitizeForLog(url, 200),
      directive: sanitizeForLog(directive, 100),
      blocked:   sanitizeForLog(blocked, 200),
      source:    source ? sanitizeForLog(source, 200) : 'unknown',
    },
    '[debug/csp-violations] CSP violation reported'
  );

  res.json({ received: true });
});

/**
 * GET /debug/errors — Return persisted frontend errors.
 * Dev: open. Prod: requires admin JWT.
 */
router.get('/errors', IS_DEV ? (_req, res, next) => next() : authenticate, async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50'), 200);
    const offset = Math.max(parseInt(req.query.offset || '0'),  0);
    const result = await pool.query(
      `SELECT id, type, message, url, filename, lineno, colno, stack,
              session_id, request_id, received_at
         FROM client_errors
        ORDER BY received_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM client_errors');
    res.json({ total: countResult.rows[0].total, errors: result.rows });
  } catch (err) {
    next(Object.assign(new Error('Database error'), { status: 500, cause: err }));
  }
});

/**
 * GET /debug/test-errors — Trigger test errors for verification (dev only).
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
  <script type="module" src="/resources/js/error-logger.js"></script>
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
 * POST /debug/test-complete — Signal that test errors have been logged (dev only).
 */
router.post('/test-complete', (req, res) => {
  if (!IS_DEV) {
    return res.status(403).json({ error: 'Debug endpoints not available in production' });
  }

  logger.info('[debug/test-complete] Error logger test complete');
  res.json({ status: 'test-complete' });
});

export default router;
