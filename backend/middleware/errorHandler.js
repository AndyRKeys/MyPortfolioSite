/**
 * Centralised Express error handler.
 * Must be registered LAST in server.js, after all routes.
 *
 * Standardises all unhandled error responses to: { error: '<message>' }
 * Uses err.status / err.statusCode if set, otherwise 500.
 *
 * Async route handlers that throw will reach this handler automatically
 * in Express 5. For Express 4, wrap handlers with asyncHandler() or
 * use .catch(next) explicitly.
 */
import { logger } from '../utils/logger.js';

export function errorHandler(err, _req, res, _next) {
  if (res.headersSent) return;

  const status  = err.status ?? err.statusCode ?? 500;
  const message = err.message || 'Internal server error';

  if (process.env.NODE_ENV !== 'test') {
    logger.error({ err, status }, `[errorHandler] ${message}`);
  }

  // For 5xx errors send a generic client message; err.message stays in logs only.
  // Prevents raw DB error details (table names, constraints) leaking to clients.
  const clientMessage = status >= 500 ? 'Internal server error' : message;
  res.status(status).json({ error: clientMessage });
}
