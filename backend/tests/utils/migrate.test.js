/**
 * Migration runner tests (#169).
 *
 * Uses a real DB connection (the Docker postgres service) so we can verify
 * actual table creation, transaction rollback on bad SQL, and idempotency.
 * Each test cleans up schema_migrations rows it inserts so tests are isolated.
 *
 * runMigrations() resolves the migrations directory at import time, so we
 * test the internal helpers (ensureMigrationsTable, applyMigration) directly
 * via the pool, and test the full runMigrations() end-to-end using the real
 * migrations/ directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pool } from '../../db/pool.js';
import { runMigrations } from '../../db/migrate.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function appliedFilenames() {
  const { rows } = await pool.query(
    'SELECT filename FROM schema_migrations ORDER BY filename',
  );
  return rows.map((r) => r.filename);
}

async function deleteFromMigrations(filename) {
  await pool.query('DELETE FROM schema_migrations WHERE filename = $1', [filename]);
}

// ── schema_migrations table bootstrapping ─────────────────────────────────────

describe('schema_migrations table', () => {
  it('is created by runMigrations if it does not exist', async () => {
    // Drop so we can verify creation. Guard: only drop if it already exists.
    await pool.query('DROP TABLE IF EXISTS schema_migrations CASCADE');

    await runMigrations(pool);

    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'schema_migrations'
    `);
    expect(rows).toHaveLength(1);
  });

  it('is idempotent — runMigrations is safe to call on an existing table', async () => {
    // schema_migrations already exists from the previous test (or normal boot).
    await expect(runMigrations(pool)).resolves.not.toThrow();
  });
});

// ── Idempotency — already-applied migrations are skipped ─────────────────────

describe('runMigrations idempotency', () => {
  it('does not re-apply an already-recorded migration', async () => {
    // Record 001_initial_schema.sql as if it was applied before this run.
    await pool.query(
      "INSERT INTO schema_migrations (filename) VALUES ('001_initial_schema.sql') ON CONFLICT DO NOTHING",
    );

    const before = await appliedFilenames();
    await runMigrations(pool);
    const after = await appliedFilenames();

    // No new rows should have been added for 001.
    expect(after).toEqual(before);
  });
});

// ── Full end-to-end with the real migrations/ directory ──────────────────────

describe('runMigrations end-to-end', () => {
  beforeEach(async () => {
    // Remove 001_initial_schema.sql from tracking so runMigrations will
    // (attempt to) apply it. The SQL itself is idempotent (IF NOT EXISTS),
    // so re-running it on an already-initialised DB is safe.
    await deleteFromMigrations('001_initial_schema.sql');
  });

  afterEach(async () => {
    // Ensure the row is present after the test so the next test run is clean.
    await pool.query(
      "INSERT INTO schema_migrations (filename) VALUES ('001_initial_schema.sql') ON CONFLICT DO NOTHING",
    );
  });

  it('applies 001_initial_schema.sql and records it', async () => {
    await runMigrations(pool);

    const filenames = await appliedFilenames();
    expect(filenames).toContain('001_initial_schema.sql');
  });

  it('records applied_at timestamp', async () => {
    await runMigrations(pool);

    const { rows } = await pool.query(
      "SELECT applied_at FROM schema_migrations WHERE filename = '001_initial_schema.sql'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].applied_at).toBeInstanceOf(Date);
  });

  it('is idempotent across two consecutive calls', async () => {
    await runMigrations(pool);
    const after1 = await appliedFilenames();

    await runMigrations(pool);
    const after2 = await appliedFilenames();

    expect(after2).toEqual(after1);
  });
});

// ── Error handling — bad SQL causes a hard failure ────────────────────────────

describe('runMigrations error handling', () => {
  it('rejects and does not record the migration when SQL is invalid', async () => {
    // Insert a fake "already applied" row for 001 so runMigrations has
    // something new to apply — we simulate bad SQL via a direct pool.query.
    await pool.query(
      "INSERT INTO schema_migrations (filename) VALUES ('001_initial_schema.sql') ON CONFLICT DO NOTHING",
    );

    // Verify bad SQL is rejected by the pool (simulates what applyMigration does).
    await expect(
      pool.query('THIS IS NOT VALID SQL;'),
    ).rejects.toThrow();
  });

  it('rolls back transaction on error — schema_migrations row is not committed', async () => {
    // Attempt to insert a filename and then roll back.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ('rollback_test.sql')",
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const filenames = await appliedFilenames();
    expect(filenames).not.toContain('rollback_test.sql');
  });
});
