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
import { fileURLToPath } from 'url';
import { authenticate }  from '../middleware/authenticate.js';
import { logger }        from '../utils/logger.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
const CV_PATH     = path.join(UPLOADS_DIR, 'cv.pdf');

// ── multer: memory storage so we can inspect before writing ──────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
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

  // Common patterns that shouldn't appear in a public CV
  const patterns = [
    { re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, label: 'possible card number' },
    { re: /\b\d{3}-\d{2}-\d{4}\b/,                        label: 'possible SSN' },
    { re: /\bpassword[:\s]/i,                              label: 'possible password' },
    { re: /\bsort\s*code[:\s]/i,                          label: 'possible sort code' },
    { re: /\bni\s*number[:\s]/i,                          label: 'possible NI number' },
    // Phone numbers — UK mobile, +44 international prefix, UK landline area codes
    { re: /\b07\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/,           label: 'possible UK mobile number' },
    { re: /\+44[\s.-]?\(?\d/,                             label: 'possible +44 phone number' },
    { re: /\b0[1-9]\d{2,4}[\s-]\d{4,7}\b/,               label: 'possible UK phone number' },
    // UK postcodes — standard format (e.g. SW1A 1AA, GY1 1AA)
    { re: /\b[A-Z]{1,2}\d[0-9A-Z]?\s?\d[A-Z]{2}\b/,      label: 'possible UK postcode / home address' },
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
router.post('/', authenticate, (req, res, next) => {
  upload.single('cv')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
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
router.delete('/', authenticate, (req, res) => {
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
