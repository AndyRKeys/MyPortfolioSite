import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../middleware/authenticate.js';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { UPLOADS_DIR } from '../utils/paths.js';
import { wrapMulter }  from '../utils/wrapMulter.js';

// Per-IP backstop on media uploads. Limiter precedes authenticate so
// CodeQL's js/missing-rate-limiting detector sees it before auth.
const uploadRateLimit = rateLimit({
  windowMs:        60 * 1000,
  limit:           30,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  store:           new PostgresStore({ windowMs: 60 * 1000, keyType: 'upload' }),
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    ALLOWED_MIME.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error('File type not allowed'));
  },
});

const router = Router();

router.post('/', uploadRateLimit, authenticate, wrapMulter(upload.single('file')), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({ url: `/uploads/${req.file.filename}`, type: req.file.mimetype });
});

export default router;
