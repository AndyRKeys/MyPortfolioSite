import { describe, it, expect, beforeEach } from 'vitest';
import { pool } from '../../db/pool.js';
import { pruneAuditLog } from '../../utils/auditLog.js';

// ── pruneAuditLog ─────────────────────────────────────────────────────────────

describe('pruneAuditLog', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM audit_log');
    // One row older than 90 days (should be pruned), one recent (should survive)
    await pool.query(`
      INSERT INTO audit_log (action, ip, created_at)
      VALUES
        ('test.old', '1.2.3.4', NOW() - INTERVAL '91 days'),
        ('test.new', '5.6.7.8', NOW())
    `);
  });

  it('deletes rows older than 90 days', async () => {
    await pruneAuditLog();
    const { rows } = await pool.query('SELECT ip FROM audit_log ORDER BY ip');
    expect(rows).toHaveLength(1);
    expect(rows[0].ip).toBe('5.6.7.8');
  });

  it('is idempotent when nothing is stale', async () => {
    await pool.query("DELETE FROM audit_log WHERE ip = '1.2.3.4'");
    await expect(pruneAuditLog()).resolves.not.toThrow();
  });

  it('reports zero deletions when nothing is stale', async () => {
    await pool.query("DELETE FROM audit_log WHERE ip = '1.2.3.4'");
    await pruneAuditLog();
    const { rows } = await pool.query('SELECT ip FROM audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0].ip).toBe('5.6.7.8');
  });
});
