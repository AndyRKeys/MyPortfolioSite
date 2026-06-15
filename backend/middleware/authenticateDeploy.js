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
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {}

  // Try service JWT
  const serviceSecret = process.env.SERVICE_JWT_SECRET;
  if (!serviceSecret) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  try {
    const payload = jwt.verify(token, serviceSecret);
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
