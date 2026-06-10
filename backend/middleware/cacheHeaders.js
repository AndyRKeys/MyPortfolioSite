/**
 * Cache-Control middleware helpers (#158).
 *
 * Apply these to route groups rather than individual handlers so the
 * policy is visible at the route registration level in server.js.
 *
 * Rules:
 *   publicCache(ttl) — public listing/detail endpoints; short TTL so stale
 *                      content does not outlast a publish/unpublish action.
 *   noStore          — auth, admin, mutating routes; prevents any caching.
 */

/**
 * Set Cache-Control: public, max-age=<seconds> on the response.
 * @param {number} seconds
 */
export function publicCache(seconds) {
  return (_req, res, next) => {
    res.set('Cache-Control', `public, max-age=${seconds}`);
    next();
  };
}

/**
 * Set Cache-Control: no-store on the response.
 * Use for auth, admin, and mutating endpoints.
 */
export function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}
