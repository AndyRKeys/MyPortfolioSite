import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

// Page names are whitelisted to prevent arbitrary values being written to the DB
const ALLOWED_PAGES = new Set(['home', 'blog', 'travel']);

// ── Routes

// Public: increment visit count for a page and return the new total
router.post('/visit', async (req, res, next) => {
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
router.get('/visits', authenticate, async (_req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT page, count, last_visited_at FROM page_visits ORDER BY count DESC'
    );
    res.json(result.rows.map(r => ({ ...r, count: Number(r.count) })));
  } catch (err) {
    next(Object.assign(new Error('Database error'), { status: 500, cause: err }));
  }
});

export default router;
