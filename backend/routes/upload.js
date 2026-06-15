import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../middleware/authenticate.js';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { UPLOADS_DIR } from '../utils/paths.js';
import { wrapMulter }  from '../utils/wrapMulter.js';
import {
  UPLOAD_RATE_WINDOW_MS, UPLOAD_RATE_LIMIT,
  MEDIA_MAX_FILE_SIZE, MEDIA_ALLOWED_MIME,
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
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MEDIA_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    MEDIA_ALLOWED_MIME.has(file.mimetype)
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
