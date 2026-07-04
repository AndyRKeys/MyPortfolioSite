/**
 * Error webhook notifier (#156).
 *
 * Sends a POST request to ERROR_WEBHOOK_URL when the backend encounters an
 * unhandled 5xx error. Designed to work with Discord, Slack, or any generic
 * webhook consumer that accepts JSON.
 *
 * If ERROR_WEBHOOK_URL is not set, notifyError() is a no-op — the webhook is
 * completely optional and does not affect normal operation.
 *
 * The notifier never throws — failures are logged and swallowed so that the
 * alerting path cannot cause further errors or mask the original exception.
 */
import { logger } from './logger.js';

/**
 * POST a structured error payload to ERROR_WEBHOOK_URL.
 *
 * @param {Error}  err           - The unhandled error.
 * @param {object} [context={}]  - Optional extra context (e.g. { status, path }).
 * @returns {Promise<void>}
 */
export async function notifyError(err, context = {}) {
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;

  const payload = {
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV ?? 'unknown',
    message:   err?.message ?? String(err),
    stack:     err?.stack   ?? null,
    context,
  };

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    logger.info(`[error-webhook] notifying url=[redacted] status=${res.status}`);
  } catch (fetchErr) {
    logger.warn(`[error-webhook] POST failed err=${fetchErr.message}`);
  }
}
