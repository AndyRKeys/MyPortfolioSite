// Returns true when the request carries a valid X-Service-Key header matching
// the SERVICE_KEY env var. Used as the `skip` function in createRateLimiter to
// exempt authenticated service accounts (e.g. the regression test runner) from
// rate limiting — trusted callers are not in scope for user-facing quotas.
// Fails closed: if SERVICE_KEY is unset, no request is exempted.
// See: issue #406, future upgrade path: issue #275 (scoped service JWTs).
export const exemptIfServiceAccount = (req) => {
  const key = process.env.SERVICE_KEY;
  return !!key && req.headers['x-service-key'] === key;
};
