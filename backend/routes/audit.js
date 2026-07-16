/**
 * Audit log routes (#154, #155)
 *
 * GET /audit?limit=50&type=all  → recent audit log entries (auth required)
 */
import { Router }        from 'express';
import { rateLimit }     from 'express-rate-limit';
import { pool }          from '../db/pool.js';
import { authenticate }  from '../middleware/authenticate.js';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { logger }        from '../utils/logger.js';
import { AUDIT_RATE_WINDOW_MS, AUDIT_RATE_LIMIT } from '../utils/constants.js';

const router = Router();

const auditRateLimit = rateLimit({
  windowMs:        AUDIT_RATE_WINDOW_MS,
  limit:           AUDIT_RATE_LIMIT,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { positiveHits: false },
  store:           new PostgresStore({ windowMs: AUDIT_RATE_WINDOW_MS, keyType: 'audit' }),
});

// Admin: list recent audit log entries
// Supports ?limit=<n> (max 200, default 50) and ?type=<action-prefix|all>
router.get('/', auditRateLimit, authenticate, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rawType = req.query.type && req.query.type !== 'all' ? req.query.type : null;
    const type    = rawType && /^[a-z_]+(\.[a-z_]+)?$/.test(rawType) ? rawType : null;

    const result = await pool.query(
      `SELECT
         al.id,
         al.action,
         al.entity_type,
         al.entity_id,
         al.detail,
         al.ip,
         al.created_at,
         u.username
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE ($1::text IS NULL OR al.action LIKE ($1 || '%'))
       ORDER BY al.created_at DESC
       LIMIT $2`,
      [type, limit]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, '[audit] GET /audit failed');
    next(err);
  }
});

export default router;
