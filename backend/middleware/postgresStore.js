import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

// express-rate-limit v7+ Store interface backed by the rate_limits table.
// Each limiter instance gets its own keyType so counters are scoped per
// resource (posts, travel, auth…) — shared counters caused cross-route
// lockout (#445).
export class PostgresStore {
  constructor({ windowMs, keyType }) {
    this.windowMs = windowMs;
    this.keyType  = keyType;
    // Tell express-rate-limit to rely on this store for counts, not its own
    // in-memory mirror.
    this.localKeys = false;
  }

  async increment(key) {
    const now         = new Date();
    const windowStart = new Date(now.getTime() - this.windowMs);

    try {
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
         RETURNING count, window_start`,
        [key, this.keyType, now, windowStart]
      );

      const row       = result.rows[0];
      const resetTime = new Date(row.window_start.getTime() + this.windowMs);
      return { totalHits: row.count, resetTime };
    } catch (err) {
      logger.error({ err }, '[rateLimit] Store.increment DB error (failing open)');
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key) {
    try {
      await pool.query(
        `UPDATE rate_limits SET count = GREATEST(count - 1, 0)
         WHERE ip = $1 AND key_type = $2`,
        [key, this.keyType]
      );
    } catch (err) {
      logger.error({ err }, '[rateLimit] Store.decrement DB error');
    }
  }

  async resetKey(key) {
    try {
      await pool.query(
        `DELETE FROM rate_limits WHERE ip = $1 AND key_type = $2`,
        [key, this.keyType]
      );
    } catch (err) {
      logger.error({ err }, '[rateLimit] Store.resetKey DB error');
    }
  }
}
