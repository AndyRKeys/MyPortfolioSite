import jwt from 'jsonwebtoken';

// ── authenticateDeploy ────────────────────────────────────────────────────────
// Accepts either an admin JWT (JWT_SECRET) or a scoped service JWT
// (SERVICE_JWT_SECRET). Service tokens must carry role:'service' and
// service:'deploy-webhook' — any other scope returns 403 so a token
// issued for a different purpose cannot be replayed against deploy routes.
export function authenticateDeploy(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const token = authHeader.slice(7);

  // Try admin JWT first
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    // A service-shaped payload signed with JWT_SECRET must be rejected — the
    // admin path has no scope enforcement and must not accidentally accept it.
    if (payload.role === 'service') {
      return res.status(403).json({ error: 'Invalid service token scope' });
    }
    req.user = payload;
    return next();
  } catch {}

  // Service token path: disabled when SERVICE_JWT_SECRET is missing or equals
  // JWT_SECRET — equal secrets collapse the isolation the two paths provide.
  const serviceSecret = process.env.SERVICE_JWT_SECRET;
  if (!serviceSecret || serviceSecret === process.env.JWT_SECRET) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  try {
    const payload = jwt.verify(token, serviceSecret, { algorithms: ['HS256'] });
    // exp is required — tokens without a finite lifetime are not accepted.
    if (!payload.exp) {
      return res.status(403).json({ error: 'Service token must have an expiry' });
    }
    if (payload.role !== 'service') {
      return res.status(403).json({ error: 'Invalid service token scope' });
    }
    if (payload.service !== 'deploy-webhook') {
      return res.status(403).json({ error: 'Invalid service token scope' });
    }
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}
