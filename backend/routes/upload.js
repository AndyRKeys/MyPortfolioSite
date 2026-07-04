import { Router }   from 'express';
import multer       from 'multer';
import path         from 'path';
import { rateLimit } from 'express-rate-limit';
import { authenticate }   from '../middleware/authenticate.js';
import { PostgresStore }  from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { pool }           from '../db/pool.js';
import { getBoss }        from '../utils/boss.js';
import { logger }         from '../utils/logger.js';
import { UPLOADS_ORIGINAL_DIR } from '../utils/paths.js';
import { wrapMulter }           from '../utils/wrapMulter.js';
import {
  UPLOAD_RATE_WINDOW_MS, UPLOAD_RATE_LIMIT,
  MEDIA_MAX_FILE_SIZE, MEDIA_ALLOWED_MIME,
  MEDIA_JOB_NAME,
} from '../utils/constants.js';

// Per-IP backstop on media uploads. Limiter precedes authenticate so
// CodeQL's js/missing-rate-limiting detector sees it before auth.
const uploadRateLimit = rateLimit({
  windowMs:        UPLOAD_RATE_WINDOW_MS,
  limit:           UPLOAD_RATE_LIMIT,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { positiveHits: false },
  store:           new PostgresStore({ windowMs: UPLOAD_RATE_WINDOW_MS, keyType: 'upload' }),
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_ORIGINAL_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits:     { fileSize: MEDIA_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    MEDIA_ALLOWED_MIME.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error('File type not allowed'));
  },
});

const router = Router();

// ── POST / ────────────────────────────────────────────────────────────────────

router.post('/', uploadRateLimit, authenticate, wrapMulter(upload.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const url = `/uploads/original/${req.file.filename}`;

  try {
    const boss = getBoss();
    if (boss) {
      await boss.send(MEDIA_JOB_NAME, { filePath: req.file.path, mimeType: req.file.mimetype }, { retryLimit: 3, retryDelay: 0, retryBackoff: true });
      logger.info({ file: req.file.filename, mime: req.file.mimetype }, '[upload] job enqueued');
    } else {
      logger.warn({ file: req.file.filename }, '[upload] boss not ready — skipping job enqueue');
    }
  } catch (err) {
    // Non-fatal: file is saved; job enqueue failure is logged but upload still succeeds.
    logger.error({ err: err.message, file: req.file.filename }, '[upload] failed to enqueue job');
  }

  res.json({ url, type: req.file.mimetype, status: 'pending' });
});

// ── GET /status ───────────────────────────────────────────────────────────────

router.get('/status', authenticate, async (req, res) => {
  const { file } = req.query;
  if (!file) return res.status(400).json({ error: 'file query param required' });

  const mediaUrl = `/uploads/original/${file}`;
  const result = await pool.query(
    'SELECT media_status, full_url, thumb_url FROM post_media WHERE media_url = $1 LIMIT 1',
    [mediaUrl],
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  const row = result.rows[0];
  res.json({ status: row.media_status, full_url: row.full_url, thumb_url: row.thumb_url });
});

// ── GET /jobs ─────────────────────────────────────────────────────────────────

router.get('/jobs', authenticate, async (req, res) => {
  const result = await pool.query(
    `SELECT media_url, media_type, media_status, full_url, thumb_url, created_at
     FROM post_media
     WHERE media_status IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 50`,
  );
  res.json(result.rows);
});

// ── POST /retry ───────────────────────────────────────────────────────────────

router.post('/retry', authenticate, async (req, res) => {
  const { file, mimeType } = req.body;
  if (!file) return res.status(400).json({ error: 'file is required' });

  const mediaUrl  = `/uploads/original/${file}`;
  const filePath  = path.join(UPLOADS_ORIGINAL_DIR, file);

  await pool.query(
    'UPDATE posts      SET media_status = $1 WHERE media_url = $2',
    ['pending', mediaUrl],
  );
  await pool.query(
    'UPDATE post_media SET media_status = $1 WHERE media_url = $2',
    ['pending', mediaUrl],
  );

  try {
    const boss = getBoss();
    if (boss) {
      await boss.send(MEDIA_JOB_NAME, { filePath, mimeType: mimeType || 'application/octet-stream' }, { retryLimit: 3, retryDelay: 0, retryBackoff: true });
      logger.info({ file }, '[upload/retry] job re-enqueued');
    }
  } catch (err) {
    logger.error({ err: err.message, file }, '[upload/retry] failed to re-enqueue job');
  }

  res.json({ ok: true });
});

export default router;
