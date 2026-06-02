import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

export function createRateLimiter(options = {}) {
  const {
    limit = 10,
    windowMs = 60 * 1000, // 1 minute
    keyType = 'default',
    keyGenerator = (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
    message = 'Too many requests. Please try again later.',
    skip = () => false,
  } = options;

  return async (req, res, next) => {
    if (skip(req)) return next();

    const key = keyGenerator(req);
    if (!key) {
      return next();
    }

    try {
      const now = new Date();
      const windowStart = new Date(now.getTime() - windowMs);

      const result = await pool.query(
        `INSERT INTO rate_limits (ip, key_type, count, window_start)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (ip, key_type) DO UPDATE
           SET
             count = CASE
               WHEN rate_limits.window_start < $4 THEN 1
               ELSE rate_limits.count + 1
             END,
             window_start = CASE
               WHEN rate_limits.window_start < $4 THEN $3
               ELSE rate_limits.window_start
             END
         RETURNING count`,
        [key, keyType, now, windowStart]
      );

      const count = result.rows[0].count;
      if (count > limit) {
        return res.status(429).json({ error: message });
      }

      next();
    } catch (err) {
      logger.error({ err }, '[rateLimit] DB error (failing open)');
      next();
    }
  };
}
