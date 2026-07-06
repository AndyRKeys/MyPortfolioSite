import 'dotenv/config';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { pool } from './db/pool.js';
import { isOAuth2Configured, getGraphAccessToken } from './utils/email.js';
import { validateEnvOrExit } from './utils/validateEnv.js';
import { pruneAuditLog } from './utils/auditLog.js';
import { runMigrations } from './db/migrate.js';
import { initBoss }            from './utils/boss.js';
import { registerMediaWorker } from './workers/mediaProcessor.js';
import { ensureUploadDirs }    from './utils/paths.js';

// Fail fast if any required env var is missing/empty — catches vars defined in
// .env but not bridged into the container's compose `environment` block (#357).
validateEnvOrExit(logger);

const app  = createApp();
const PORT = process.env.PORT || 3001;

// Run migrations before accepting traffic (#169). A migration failure is a
// hard boot failure — we log the error and exit(1) rather than starting with
// an inconsistent schema.
let server;
try {
  await runMigrations(pool);
} catch (err) {
  logger.fatal({ err: err.message }, '[startup] migration failed — aborting boot');
  process.exit(1);
}

// Ensure upload subdirectories exist before the server accepts traffic.
ensureUploadDirs();

// Start pg-boss and register the media processing worker (#174).
let boss;
try {
  boss = await initBoss();
  await registerMediaWorker(boss);
} catch (err) {
  logger.fatal({ err: err.message }, '[startup] pg-boss failed to start — aborting boot');
  process.exit(1);
}

server = app.listen(PORT, () => {
  logger.info({ port: PORT }, `[startup] Backend listening on http://localhost:${PORT}`);
  runStartupPreflight();
});

// Non-blocking preflight: check DB connectivity and Outlook OAuth2 token validity.
// Failures are logged as warnings — the server keeps running so transient outages
// (e.g. DB container still initialising) don't cause unnecessary restarts.
async function runStartupPreflight() {
  // DB check
  try {
    await pool.query('SELECT 1');
    logger.info('[startup:preflight] DB connection OK');
  } catch (err) {
    logger.warn({ err: err.message }, '[startup:preflight] DB connection failed — check DB service and credentials');
  }

  // Prune stale audit_log rows (GDPR/PII: IPs retained max 90 days — #467)
  try {
    await pruneAuditLog();
  } catch (err) {
    logger.warn({ err: err.message }, '[startup:preflight] audit_log prune failed — stale rows may accumulate');
  }

  // Outlook OAuth2 check (only if configured)
  if (isOAuth2Configured()) {
    try {
      await getGraphAccessToken();
      logger.info('[startup:preflight] Outlook OAuth2 token valid');
    } catch (err) {
      logger.warn(
        { error: err.message },
        '[startup:preflight] Outlook OAuth2 token invalid — contact form email will not work. ' +
        'Refresh the token in Azure portal and update OUTLOOK_REFRESH_TOKEN in .env.',
      );
    }
  } else {
    logger.info('[startup:preflight] Outlook OAuth2 not configured — skipping token check');
  }
}

// Graceful shutdown on SIGTERM (Docker stop, Kubernetes termination, etc)
process.on('SIGTERM', () => {
  logger.info('[shutdown] SIGTERM received, closing connections');
  server.close(async () => {
    logger.info('[shutdown] Server closed, exiting');
    if (boss) await boss.stop().catch(() => {});
    process.exit(0);
  });
  // Force exit after 10s if connections don't close
  setTimeout(() => {
    logger.error('[shutdown] Forced exit after 10s — connections did not drain');
    process.exit(1);
  }, 10000);
});
