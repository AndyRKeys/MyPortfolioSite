import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { getMetrics } from '../utils/metrics.js';

const router = Router();

const statsRateLimit = rateLimit({
  windowMs:        60 * 1000,
  limit:           60,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { positiveHits: false },
  store:           new PostgresStore({ windowMs: 60 * 1000, keyType: 'stats' }),
});

// Page names are whitelisted to prevent arbitrary values being written to the DB
const ALLOWED_PAGES = new Set(['home', 'blog', 'travel', 'ai-blog']);

// ── Routes

// Public: increment visit count for a page and return the new total.
// Rate-limited per-IP — the only unauthenticated write endpoint, so it must be
// throttled like the admin GETs (#522 M8).
router.post('/visit', statsRateLimit, async (req, res, next) => {
  const page = req.query.page;
  if (!page || !ALLOWED_PAGES.has(page)) {
    return res.status(400).json({ error: 'Invalid page' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO page_visits (page, count, last_visited_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (page) DO UPDATE
         SET count = page_visits.count + 1,
             last_visited_at = NOW()
       RETURNING count`,
      [page]
    );
    res.json({ page, count: Number(result.rows[0].count) });
  } catch (err) {
    next(Object.assign(new Error('Database error'), { status: 500, cause: err }));
  }
});

// Admin: return all page visit counts
router.get('/visits', statsRateLimit, authenticate, async (_req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT page, count, last_visited_at FROM page_visits ORDER BY count DESC'
    );
    res.json(result.rows.map(r => ({ ...r, count: Number(r.count) })));
  } catch (err) {
    next(Object.assign(new Error('Database error'), { status: 500, cause: err }));
  }
});

// Admin: return rolling per-minute metrics for the last hour
router.get('/metrics', statsRateLimit, authenticate, (_req, res) => {
  res.json(getMetrics());
});

export default router;
