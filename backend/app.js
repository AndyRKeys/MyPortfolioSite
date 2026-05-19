/**
 * Express app factory — separated from server.js so tests can import
 * the app without starting a live server or requiring a real DB connection.
 *
 * server.js imports this and calls app.listen().
 * Tests import this directly and pass it to supertest().
 */
import express  from 'express';
import cors     from 'cors';
import path     from 'path';
import { fileURLToPath } from 'url';
import pinoHttp from 'pino-http';

import { logger } from './utils/logger.js';

import authRoutes    from './routes/auth.js';
import travelRoutes  from './routes/travel.js';
import contactRoutes from './routes/contact.js';
import uploadRoutes  from './routes/upload.js';
import postsRoutes   from './routes/posts.js';
import statsRoutes   from './routes/stats.js';
import cvRoutes      from './routes/cv.js';
import deployRoutes  from './routes/deploy.js';
import debugRoutes   from './routes/debug.js';
import { healthRouter } from './routes/health.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  // HTTP request logging + per-request child logger (req.log) — must be
  // first so even CORS-rejected requests are recorded with method/path/
  // status/latency. Secret redaction is configured in utils/logger.js.
  // Health check polls every 10s — demote to trace so they don't flood
  // info-level logs; visible only when LOG_LEVEL=trace.
  app.use(pinoHttp({
    logger,
    customLogLevel: (req, res) =>
      req.url === '/health' ? 'trace' : res.statusCode >= 500 ? 'error' : 'info',
  }));

  const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5500';

  // Extract host+port from ALLOWED_ORIGIN for flexible protocol matching
  const allowedOriginHostPort = ALLOWED_ORIGIN.replace(/^https?:\/\//, '');

  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || origin === ALLOWED_ORIGIN ||
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
          // Docker internal: allow nginx service names for dev/test (nginx-dev, nginx-local, etc.)
          /^https?:\/\/nginx-(dev|local)(:\d+)?$/.test(origin)) {
        cb(null, true);
      } else {
        cb(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  app.use(express.json({ limit: '10mb' }));

  const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
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

  // Health check — internal only (direct backend port); not proxied by nginx
  app.get('/health', healthRouter);
  app.get('/api/health', healthRouter);

  // Centralised error handler — must be last
  app.use(errorHandler);

  return app;
}
