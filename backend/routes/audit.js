/**
 * Audit log routes (#154, #155)
 *
 * GET /audit?limit=50&type=all  → recent audit log entries (auth required)
 */
import { Router }      from 'express';
import { pool }        from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { logger }      from '../utils/logger.js';

const router = Router();

// Admin: list recent audit log entries
// Supports ?limit=<n> (max 200, default 50) and ?type=<action-prefix|all>
router.get('/', authenticate, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const type  = req.query.type && req.query.type !== 'all' ? req.query.type : null;

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
