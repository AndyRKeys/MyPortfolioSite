/**
 * Shared structured logger (pino) — #153.
 *
 * Severity-levelled JSON logs with secret redaction. Level is controlled
 * by LOG_LEVEL (default 'info'). In non-production, logs are pretty-printed
 * for readability; in production they stay as JSON for ingestion.
 *
 * Redaction is deliberate and reviewable (SECURITY.md): auth headers,
 * tokens, passwords, and refresh tokens are never written to logs even if
 * they appear in a logged object. Never hand raw secrets to the logger
 * outside the redacted paths below.
 */
import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.token',
  '*.refresh_token',
  '*.refreshToken',
  '*.password',
  '*.jwt',
  'token',
  'password',
  'refresh_token',
  'authorization',
];

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: redactPaths, censor: '[redacted]' },
  ...(isProd
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }),
});
