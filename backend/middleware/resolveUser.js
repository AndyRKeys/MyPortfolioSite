import jwt from 'jsonwebtoken';

// Resolves the caller's identity from Authorization: Bearer if present and sets
// req.user, then always calls next(). Does not gate access — requests with no
// token or an invalid token proceed normally and will still be subject to any
// rate limiter further down the chain.
// Place before a rate limiter so exemptIfTrusted can check req.user.
export function resolveUser(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET); // lgtm[js/missing-rate-limiting] -- cheap synchronous HMAC; invalid tokens fall through to the caller's rate limiter unauthenticated
    } catch {
      // invalid or expired token — treat as unauthenticated
    }
  }
  next();
}
