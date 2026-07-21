/**
 * Full-text search route (#157)
 *
 * GET /search?q=<term>&type=blog|travel|all&limit=10
 *
 * Uses PostgreSQL tsvector/tsquery with ts_rank for relevance ordering.
 * Published posts only — no draft leakage.
 */
import { Router }        from 'express';
import { rateLimit }     from 'express-rate-limit';
import { rateLimiterOptions } from '../middleware/rateLimiter.js';
import { pool }          from '../db/pool.js';
import { logger }        from '../utils/logger.js';
import { publicCache }   from '../middleware/cacheHeaders.js';

const router = Router();

const searchRateLimit = rateLimit(rateLimiterOptions({
  windowMs: 60 * 1000,
  limit:    60,
  keyType:  'search',
}));

// GET /search?q=term&type=all|blog|travel&limit=10
router.get('/', searchRateLimit, publicCache(60), async (req, res, next) => {
  try {
    const q     = (req.query.q || '').trim();
    const type  = req.query.type && ['blog', 'travel'].includes(req.query.type)
                  ? req.query.type : null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }
    if (q.length > 500) {
      return res.status(400).json({ error: 'Search query too long (max 500 characters).' });
    }

    logger.info({ q, type, limit }, '[search] Full-text search request');

    const result = await pool.query(
      `SELECT
         id,
         title,
         slug,
         post_type,
         location,
         published_at,
         post_date,
         left(body_markdown, 300) AS excerpt,
         ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
       FROM posts
       WHERE search_vector @@ plainto_tsquery('english', $1)
         AND published_at IS NOT NULL
         AND ($2::text IS NULL OR post_type = $2)
       ORDER BY rank DESC, published_at DESC
       LIMIT $3`,
      [q, type, limit]
    );

    res.json({ query: q, total: result.rows.length, results: result.rows });
  } catch (err) {
    logger.error({ err }, '[search] Search request failed');
    next(err);
  }
});

export default router;
