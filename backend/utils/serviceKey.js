import jwt from 'jsonwebtoken';

// Returns true when the request carries a valid X-Service-Key header matching
// the SERVICE_KEY env var. Used as the `skip` function in rateLimit() to
// exempt authenticated service accounts (e.g. the regression test runner) from
// rate limiting — trusted callers are not in scope for user-facing quotas.
// Fails closed: if SERVICE_KEY is unset, no request is exempted.
// See: issue #406, future upgrade path: issue #275 (scoped service JWTs).
export const exemptIfServiceAccount = (req) => {
  const key = process.env.SERVICE_KEY;
  return !!key && req.headers['x-service-key'] === key;
};

// Returns true when the request is from a trusted caller: a verified JWT bearer
// or a valid service account key. JWT verification is done inline (not via
// req.user) so this can be used as a `skip` on a rate limiter placed before
// resolveUser in the middleware chain — CodeQL's js/missing-rate-limiting
// detector requires the limiter to precede any authorization step.
// Auth endpoints with email/passkey ceremonies must keep exemptIfServiceAccount
// instead — JWT exemption is inappropriate there (a stolen JWT must not bypass
// magic-link or passkey rate limits). See: issues #415, #453.
export const exemptIfTrusted = (req) => {
  if (exemptIfServiceAccount(req)) return true;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return false;
  try {
    jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    return true;
  } catch {
    return false;
  }
};
