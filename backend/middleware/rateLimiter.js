import { PostgresStore } from './postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';

// ── Shared rate-limiter options (#522 M2)
// Single source of truth for the ~10-line options block previously duplicated
// across every route file. Only windowMs / limit / keyType (and occasionally
// skip / message) vary per route; everything else is identical by design.
//
// This is deliberately an OPTIONS BUILDER, not a factory that calls
// rateLimit() itself: CodeQL's js/missing-rate-limiting detector loses the
// dataflow trace at a function boundary and would flag every route as
// unprotected (#453). Call sites must keep the inline shape:
//
//   const fooRateLimit = rateLimit(rateLimiterOptions({
//     windowMs: FOO_RATE_WINDOW_MS,
//     limit:    FOO_RATE_LIMIT,
//     keyType:  'foo',
//   }));
//
// and place the limiter before resolveUser / authenticate in the chain.
//
// Defaults:
// - skip: exemptIfTrusted (owner exemption via inline JWT verify). Auth
//   ceremony routes (email/passkey) must override with exemptIfServiceAccount
//   only — a stolen JWT must not bypass those limits (#415).
// - message: generic "Too many requests" body; pass a string to override.
export function rateLimiterOptions({
  windowMs,
  limit,
  keyType,
  skip = exemptIfTrusted,
  message = 'Too many requests. Please try again later.',
}) {
  return {
    windowMs,
    limit,
    keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
    skip,
    message:         { error: message },
    standardHeaders: true,
    legacyHeaders:   false,
    validate:        { positiveHits: false },
    store:           new PostgresStore({ windowMs, keyType }),
  };
}
