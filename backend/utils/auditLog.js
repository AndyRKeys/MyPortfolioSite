/**
 * Audit log maintenance utilities (#467)
 *
 * pruneAuditLog()
 *   → deletes audit_log rows older than 90 days at server startup.
 *   IPs from unauthenticated events (e.g. auth.login_failed) are PII and must
 *   not be retained indefinitely. This mirrors the email_tokens expiry pattern.
 */
import { pool } from '../db/pool.js';
import { logger } from './logger.js';

/**
 * Delete audit_log rows older than 90 days.
 * Called once at server startup — non-blocking from the caller's perspective
 * but awaited inside runStartupPreflight so failures surface in logs.
 */
export async function pruneAuditLog() {
  const result = await pool.query(
    `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'`
  );
  logger.info({ deleted: result.rowCount }, '[audit] Pruned stale audit_log rows');
}
