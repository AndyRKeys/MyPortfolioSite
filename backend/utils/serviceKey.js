// Returns true when the request carries a valid X-Service-Key header matching
// the SERVICE_KEY env var. Used as the `skip` function in createRateLimiter so
// the regression test service account bypasses rate limits without consuming
// user-facing quota. Fails closed: if SERVICE_KEY is unset no request is skipped.
// See: issue #406, future upgrade path: issue #275 (scoped service JWTs).
export const skipIfServiceKey = (req) => {
  const key = process.env.SERVICE_KEY;
  return !!key && req.headers['x-service-key'] === key;
};
