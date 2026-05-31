import jwt from 'jsonwebtoken';

// Verifies the JWT from Authorization: Bearer if present and sets req.user.
// Always calls next() — never rejects unauthenticated requests.
// Used before rate limiters on application routes so exemptIfTrusted can check req.user.
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
