/**
 * Audit logging utility (#154)
 *
 * logAudit(req, action, entityType, entityId, detail)
 *   → writes one row to audit_log asynchronously (non-blocking)
 *
 * Sensitive fields (tokens, passwords, hashes) must NEVER appear in `detail`.
 * The caller is responsible for scrubbing any such fields before passing them.
 */
import { pool } from '../db/pool.js';
import { logger } from './logger.js';

/**
 * @param {import('express').Request}              req        - Express request (for user_id and IP)
 * @param {string}                                 action      - Dot-namespaced action, e.g. 'post.publish'
 * @param {string|null}                            entityType  - e.g. 'post', 'travel', 'cv', 'deploy'
 * @param {string|null}                            entityId    - ID of the affected record
 * @param {object|null}                            detail      - Structured context (no secrets)
 * @param {{ userId?: string|number|null }}        [opts]      - Optional overrides (e.g. userId for login routes that lack req.user)
 */
export async function logAudit(req, action, entityType = null, entityId = null, detail = null, opts = {}) {
  const userId = opts.userId ?? req.user?.userId ?? req.user?.id ?? null;
  const ip     = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
              ?? req.socket?.remoteAddress
              ?? null;

  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, action, entityType, entityId ? String(entityId) : null,
       detail ? JSON.stringify(detail) : null, ip]
    );
  } catch (err) {
    // Audit failures are non-fatal — log and continue
    logger.warn({ err, action, entityType, entityId }, '[audit] Failed to write audit log row');
  }
}
