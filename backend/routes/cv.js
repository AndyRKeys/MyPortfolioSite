/**
 * CV management routes
 *
 * GET  /cv/exists  → { exists: bool }          public
 * GET  /cv         → streams uploads/cv.pdf    public
 * POST /cv         → upload a new CV (PDF)     auth required
 * DELETE /cv       → remove the CV file        auth required
 */
import { Router }   from 'express';
import multer       from 'multer';
import path         from 'path';
import fs           from 'fs';
import { rateLimit }      from 'express-rate-limit';
import { authenticate }  from '../middleware/authenticate.js';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { logger }        from '../utils/logger.js';
import { UPLOADS_DIR }   from '../utils/paths.js';
import { wrapMulter }    from '../utils/wrapMulter.js';
import { CV_RATE_WINDOW_MS, CV_RATE_LIMIT, CV_MAX_FILE_SIZE } from '../utils/constants.js';

const router  = Router();

// Per-IP backstop on CV write operations. The limiter precedes authenticate
// so CodeQL's js/missing-rate-limiting detector sees it before auth.
const cvRateLimit = rateLimit({
  windowMs:        CV_RATE_WINDOW_MS,
  limit:           CV_RATE_LIMIT,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  store:           new PostgresStore({ windowMs: CV_RATE_WINDOW_MS, keyType: 'cv' }),
});
const CV_PATH = path.join(UPLOADS_DIR, 'cv.pdf');

// ── multer: memory storage so we can inspect before writing ──────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CV_MAX_FILE_SIZE },
  fileFilter(_req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only PDF files are accepted'), { status: 400 }));
    }
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function cvExists() {
  return fs.existsSync(CV_PATH);
}

/**
 * Lightly scan the PDF buffer for strings that look like private info.
 * We use a simple regex pass over the raw bytes — no heavy parse needed
 * for this heuristic check. Returns an array of warning strings.
 */
function scanForPrivateInfo(buffer) {
  const text = buffer.toString('latin1');
  const warnings = [];

  // Common patterns that shouldn't appear in a public CV.
  // Patterns are heuristic — broad enough to catch common formats while
  // avoiding false positives on innocuous text (#111).
  const patterns = [
    { re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, label: 'possible card number' },
    { re: /\b\d{3}-\d{2}-\d{4}\b/,                        label: 'possible SSN' },
    { re: /\bpassword[:\s]/i,                              label: 'possible password' },
    { re: /\bsort\s*code[:\s]/i,                          label: 'possible sort code' },
    { re: /\bni\s*number[:\s]/i,                          label: 'possible NI number' },

    // Phone numbers — UK mobile (07xxx), UK landline, international +xx prefix,
    // and Guernsey/Channel Islands numbers (01481).
    { re: /\b07\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/,           label: 'possible UK mobile number' },
    { re: /\b0[1-9]\d{3}[\s-]?\d{6}\b/,                  label: 'possible UK landline number' },
    { re: /\+\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{3,}/,   label: 'possible international phone number' },

    // UK and Guernsey postcodes (e.g. SW1A 1AA, GY1 1AA).
    { re: /\b(GY\d[\s-]?\d[A-Z]{2}|[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2})\b/i,
                                                           label: 'possible UK/Guernsey postcode' },

    // Street address heuristic — a line containing a house number followed by
    // a road/street/avenue/close/lane/way keyword. Avoids matching short refs.
    { re: /\b\d+\s+\w+\s+(street|st|road|rd|avenue|ave|close|cl|lane|ln|way|drive|dr|crescent|place|pl|row)\b/i,
                                                           label: 'possible street address' },
  ];

  patterns.forEach(({ re, label }) => {
    if (re.test(text)) warnings.push(label);
  });

  return warnings;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Public: check whether a CV is currently uploaded
router.get('/exists', (_req, res) => {
  res.json({ exists: cvExists() });
});

// Public: download the CV
router.get('/', (req, res) => {
  if (!cvExists()) return res.status(404).json({ error: 'No CV uploaded yet' });
  res.download(CV_PATH, 'Andy_Keys_CV.pdf', (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Failed to send CV' });
    }
  });
});

// Admin: upload / replace CV
router.post('/', cvRateLimit, authenticate, wrapMulter(upload.single('cv')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const warnings = scanForPrivateInfo(req.file.buffer);

  try {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(CV_PATH, req.file.buffer);
    res.status(200).json({ uploaded: true, warnings });
  } catch (err) {
    logger.error({ err }, '[cv] CV upload failed');
    res.status(500).json({ error: 'Failed to save CV' });
  }
});

// Admin: delete the CV
router.delete('/', cvRateLimit, authenticate, (req, res) => {
  if (!cvExists()) return res.status(404).json({ error: 'No CV to delete' });
  try {
    fs.unlinkSync(CV_PATH);
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, '[cv] CV delete failed');
    res.status(500).json({ error: 'Failed to delete CV' });
  }
});

export default router;
