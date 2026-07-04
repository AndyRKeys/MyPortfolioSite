/**
 * Lightweight SQL migration runner (#169).
 *
 * Reads *.sql files from db/migrations/ sorted numerically and applies any
 * that are not already recorded in the schema_migrations table. Each migration
 * runs inside a transaction — a failure rolls back that migration only and
 * re-throws, causing the server to boot-fail loud rather than silently skip.
 *
 * Safe to call on a DB that already has the full schema: already-applied
 * migrations are skipped. No external packages required.
 */

import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

// ── Schema migrations table ───────────────────────────────────────────────────

async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL      PRIMARY KEY,
      filename    TEXT        UNIQUE NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ── Apply a single migration in a transaction ─────────────────────────────────

async function applyMigration(pool, filename) {
  const filePath = join(MIGRATIONS_DIR, filename);
  const sql = await readFile(filePath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [filename],
    );
    await client.query('COMMIT');
    logger.info({ filename }, '[migrate] applied migration');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(
      { filename, err: err.message },
      '[migrate] migration failed — rolled back; fix the SQL before restarting',
    );
    throw err;
  } finally {
    client.release();
  }
}

// ── runMigrations ─────────────────────────────────────────────────────────────

/**
 * Apply all pending migrations in db/migrations/ to the connected pool.
 *
 * @param {import('pg').Pool} pool — shared pg Pool instance
 */
export async function runMigrations(pool) {
  logger.info('[migrate] starting migration check');

  await ensureMigrationsTable(pool);

  // Discover migration files — sort numerically by leading digits so 010 > 002.
  const allFiles = await readdir(MIGRATIONS_DIR);
  const migrationFiles = allFiles
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (migrationFiles.length === 0) {
    logger.warn('[migrate] no migration files found in db/migrations/');
    return;
  }

  // Fetch already-applied filenames in one query.
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const pending = migrationFiles.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    logger.info(
      { total: migrationFiles.length },
      '[migrate] all migrations already applied — nothing to do',
    );
    return;
  }

  logger.info(
    { pending: pending.length, skipped: applied.size },
    '[migrate] migrations to apply',
  );

  for (const filename of pending) {
    logger.info({ filename }, '[migrate] applying migration');
    await applyMigration(pool, filename);
  }

  logger.info(
    { applied: pending.length, skipped: applied.size },
    '[migrate] done',
  );
}
