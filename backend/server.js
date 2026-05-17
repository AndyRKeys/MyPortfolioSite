import 'dotenv/config';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';

if (!process.env.JWT_SECRET) {
  logger.fatal('[startup] JWT_SECRET environment variable is not set — refusing to start');
  process.exit(1);
}

const app  = createApp();
const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, `[startup] Backend listening on http://localhost:${PORT}`);
});

// Graceful shutdown on SIGTERM (Docker stop, Kubernetes termination, etc)
process.on('SIGTERM', () => {
  logger.info('[shutdown] SIGTERM received, closing connections');
  server.close(() => {
    logger.info('[shutdown] Server closed, exiting');
    process.exit(0);
  });
  // Force exit after 10s if connections don't close
  setTimeout(() => {
    logger.error('[shutdown] Forced exit after 10s — connections did not drain');
    process.exit(1);
  }, 10000);
});
