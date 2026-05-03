import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

// Increment visit count for a page and return the new total.
// Public — no auth required. Page names are whitelisted to prevent injection.
const ALLOWED_PAGES = new Set(['home', 'blog', 'travel']);

router.post('/visit', async (req, res) => {
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
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Return all page visit counts — admin only.
router.get('/visits', authenticate, async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT page, count, last_visited_at FROM page_visits ORDER BY count DESC'
    );
    res.json(result.rows.map(r => ({ ...r, count: Number(r.count) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
