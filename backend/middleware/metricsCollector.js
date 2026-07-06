import { recordRequest } from '../utils/metrics.js';

const HEALTH_PATHS = new Set(['/health', '/api/health']);

export function metricsCollector(req, res, next) {
  if (HEALTH_PATHS.has(req.path)) return next();
  const start = Date.now();
  res.on('finish', () => {
    recordRequest(res.statusCode, Date.now() - start);
  });
  next();
}
