import { rateLimit } from 'express-rate-limit';
import { PostgresStore } from './postgresStore.js';

// createRateLimiter wraps express-rate-limit (natively recognised by CodeQL's
// js/missing-rate-limiting detector) with a Postgres-backed store so that
// counts survive process restarts and scale across workers.
//
// Call sites (posts, travel, auth, contact, debug) pass the same options shape
// they already used — this wrapper is a drop-in replacement for the old
// hand-rolled middleware.
export function createRateLimiter(options = {}) {
  const {
    limit        = 10,
    windowMs     = 60 * 1000,
    keyType      = 'default',
    keyGenerator = (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
    message      = 'Too many requests. Please try again later.',
    skip         = () => false,
  } = options;

  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    skip,
    message:         { error: message },
    standardHeaders: true,
    legacyHeaders:   false,
    store:           new PostgresStore({ windowMs, keyType }),
  });
}
