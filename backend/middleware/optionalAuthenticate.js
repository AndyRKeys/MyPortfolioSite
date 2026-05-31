import jwt from 'jsonwebtoken';

// Verifies the JWT from Authorization: Bearer if present and sets req.user, then
// always calls next(). Does not gate access — unauthenticated requests proceed
// normally and will still be subject to any rate limiter further down the chain.
// Place before a rate limiter so exemptIfTrusted can check req.user.
export function optionalAuthenticate(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // invalid or expired token — treat as unauthenticated
    }
  }
  next();
}
