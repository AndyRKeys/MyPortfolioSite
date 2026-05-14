import { Router } from 'express';

const router = Router();

/**
 * POST /debug/errors — Receive frontend errors from error-logger.js
 * Logs them server-side for debugging
 * No auth required — needs to work for public site errors
 */
router.post('/errors', (req, res) => {
  const { type, message, timestamp, url, filename, lineno, colno, stack } = req.body;

  // Log to server console with context
  const context = `[${type}] ${url} ${filename ? `@ ${filename}:${lineno}:${colno}` : ''}`;
  console.error(`\n🔴 FRONTEND ERROR: ${context}\n  Message: ${message}\n  Time: ${timestamp}`);
  if (stack) {
    console.error(`  Stack: ${stack.split('\n').slice(0, 3).join('\n    ')}`);
  }

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

export default router;
