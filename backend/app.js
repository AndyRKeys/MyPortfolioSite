/**
 * Express app factory — separated from server.js so tests can import
 * the app without starting a live server or requiring a real DB connection.
 *
 * server.js imports this and calls app.listen().
 * Tests import this directly and pass it to supertest().
 */
import express  from 'express';
import cors     from 'cors';
import crypto   from 'crypto';
import pinoHttp from 'pino-http';
import { rateLimit } from 'express-rate-limit';

import { logger }     from './utils/logger.js';
import { UPLOADS_DIR } from './utils/paths.js';
import { PostgresStore } from './middleware/postgresStore.js';
import { HEALTH_RATE_WINDOW_MS, HEALTH_RATE_LIMIT } from './utils/constants.js';

import authRoutes    from './routes/auth.js';
import travelRoutes  from './routes/travel.js';
import contactRoutes from './routes/contact.js';
import uploadRoutes  from './routes/upload.js';
import postsRoutes   from './routes/posts.js';
import statsRoutes   from './routes/stats.js';
import cvRoutes      from './routes/cv.js';
import deployRoutes  from './routes/deploy.js';
import debugRoutes   from './routes/debug.js';
import auditRoutes   from './routes/audit.js';
import searchRoutes  from './routes/search.js';
import githubRoutes  from './routes/github.js';
import aiBlogRoutes  from './routes/ai-blog.js';
import { healthHandler } from './routes/health.js';
import { errorHandler }     from './middleware/errorHandler.js';
import { metricsCollector } from './middleware/metricsCollector.js';

export function createApp() {
  const app = express();

  // HTTP request logging + per-request child logger (req.log) — must be
  // first so even CORS-rejected requests are recorded with method/path/
  // status/latency. Secret redaction is configured in utils/logger.js.
  // Health check polls every 10s — demote to trace so they don't flood
  // info-level logs; visible only when LOG_LEVEL=trace.
  // Assign a UUID to every request (#336). pino-http exposes it as req.id
  // in the log line; the middleware below echoes it as X-Request-Id so the
  // frontend can include it in error reports for correlation.
  app.use(pinoHttp({
    logger,
    genReqId: () => crypto.randomUUID(),
    customLogLevel: (req, res) =>
      req.url === '/health' ? 'trace' : res.statusCode >= 500 ? 'error' : 'info',
  }));

  // Expose the request ID to the frontend so error-logger.js can include it
  // in /debug/errors reports, correlating client errors with backend log lines.
  app.use((req, res, next) => {
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  app.use(metricsCollector);

  const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5500';
  // SITE_HOST covers requests where the browser omits the non-standard port
  // (e.g. origin=https://dev.andykeys.me when FRONTEND_URL=https://dev.andykeys.me:3001)
  const SITE_HOST = process.env.SITE_HOST || '';

  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || origin === ALLOWED_ORIGIN ||
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
          // Docker internal: allow nginx service name for dev/test
          /^https?:\/\/nginx(:\d+)?$/.test(origin) ||
          // SITE_HOST: allow any port on the configured hostname (handles port-less origins)
          (SITE_HOST && origin && (() => { try { return new URL(origin).hostname === SITE_HOST; } catch { return false; } })())) {
        cb(null, true);
      } else {
        cb(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  app.use(express.json({ limit: '10mb' }));

  app.use('/uploads', express.static(UPLOADS_DIR));

  app.use('/auth',    authRoutes);
  app.use('/travel',  travelRoutes);
  app.use('/contact', contactRoutes);
  app.use('/upload',  uploadRoutes);
  app.use('/posts',   postsRoutes);
  app.use('/stats',   statsRoutes);
  app.use('/cv',      cvRoutes);
  app.use('/deploy',  deployRoutes);
  app.use('/debug',   debugRoutes);
  app.use('/audit',   auditRoutes);
  app.use('/search',  searchRoutes);
  app.use('/github',  githubRoutes);
  app.use('/ai-blog', aiBlogRoutes);

  // Health check — internal only (direct backend port); not proxied by nginx.
  // Still hits the DB, so still needs a rate limiter to satisfy CodeQL's
  // js/missing-rate-limiting detector (#522 follow-up).
  const healthRateLimit = rateLimit({
    windowMs:        HEALTH_RATE_WINDOW_MS,
    limit:           HEALTH_RATE_LIMIT,
    keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
    message:         { error: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders:   false,
    validate:        { positiveHits: false },
    store:           new PostgresStore({ windowMs: HEALTH_RATE_WINDOW_MS, keyType: 'health' }),
  });
  app.get('/health', healthRateLimit, healthHandler);
  app.get('/api/health', healthRateLimit, healthHandler);

  // Centralised error handler — must be last
  app.use(errorHandler);

  return app;
}
