/**
 * Audit log utilities (#154, #467)
 *
 * logAudit(req, action, entityType, entityId, detail)
 *   → writes one row to audit_log asynchronously (non-blocking)
 *
 * pruneAuditLog()
 *   → deletes audit_log rows older than 90 days at server startup.
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

  // Service tokens carry no numeric user_id; record their identity via sub so
  // deploy actions are traceable even when user_id is null.
  const actor = req.user?.sub ?? null;
  const enrichedDetail = actor
    ? JSON.stringify({ actor, ...(detail ?? {}) })
    : (detail ? JSON.stringify(detail) : null);

  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, action, entityType, entityId ? String(entityId) : null,
       enrichedDetail, ip]
    );
  } catch (err) {
    // Audit failures are non-fatal — log and continue
    logger.warn({ err, action, entityType, entityId }, '[audit] Failed to write audit log row');
  }
}

/**
 * Delete audit_log rows older than 90 days (#467).
 * IPs from unauthenticated events (e.g. auth.login_failed) are PII and must
 * not be retained indefinitely. This mirrors the email_tokens expiry pattern.
 * Called once at server startup — non-blocking from the caller's perspective
 * but awaited inside runStartupPreflight so failures surface in logs.
 */
export async function pruneAuditLog() {
  const result = await pool.query(
    `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'`
  );
  logger.info({ deleted: result.rowCount }, '[audit] Pruned stale audit_log rows');
}
