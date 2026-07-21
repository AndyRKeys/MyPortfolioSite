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
 *
 * 5xx errors trigger an optional webhook notification (#156). Set
 * ERROR_WEBHOOK_URL in the environment to enable. 4xx errors are client
 * mistakes, not bugs — they are never forwarded to the webhook.
 */
import { logger } from '../utils/logger.js';
import { notifyError } from '../utils/errorWebhook.js';

export function errorHandler(err, req, res, next) {
  // Once headers are sent the response is already committed; per Express
  // convention delegate to the default handler so the connection is torn
  // down rather than the error being silently swallowed.
  if (res.headersSent) return next(err);

  const status  = err.status ?? err.statusCode ?? 500;
  const message = err.message || 'Internal server error';

  if (process.env.NODE_ENV !== 'test') {
    logger.error({ err, status }, `[errorHandler] ${message}`);
  }

  // Notify webhook for server-side bugs only (5xx). 4xx are client errors.
  if (status >= 500) {
    const context = {
      status,
      method: req?.method,
      path:   req?.path,
    };
    notifyError(err, context).catch(() => {});
  }

  // For 5xx errors send a generic client message; err.message stays in logs only.
  // Prevents raw DB error details (table names, constraints) leaking to clients.
  const clientMessage = status >= 500 ? 'Internal server error' : message;
  res.status(status).json({ error: clientMessage });
}
