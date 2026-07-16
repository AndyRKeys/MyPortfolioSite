/**
 * CV management routes (#109)
 *
 * Public (unchanged contract):
 *   GET  /cv/exists   → { exists: bool }
 *   GET  /cv          → streams the current CV as Andy_Keys_CV.pdf
 *
 * Admin (version history):
 *   POST /cv                  → upload new version (becomes current); prunes to 5 max
 *   GET  /cv/history          → list all stored versions (newest first)
 *   PUT  /cv/:id/set-current  → make a previous version current
 *   DELETE /cv/:id            → delete a specific version
 */
import { Router }        from 'express';
import multer            from 'multer';
import path              from 'path';
import fs                from 'fs';
import { randomBytes }   from 'crypto';
import { rateLimit }     from 'express-rate-limit';
import { rateLimiterOptions } from '../middleware/rateLimiter.js';
import { authenticate }  from '../middleware/authenticate.js';
import { logger }        from '../utils/logger.js';
import { logAudit }      from '../utils/audit.js';
import { UPLOADS_DIR }   from '../utils/paths.js';
import { wrapMulter }    from '../utils/wrapMulter.js';
import { CV_RATE_WINDOW_MS, CV_RATE_LIMIT, CV_MAX_FILE_SIZE } from '../utils/constants.js';
import { pool }          from '../db/pool.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-IP backstop on CV write operations.
const cvRateLimit = rateLimit(rateLimiterOptions({
  windowMs: CV_RATE_WINDOW_MS,
  limit:    CV_RATE_LIMIT,
  keyType:  'cv',
}));

// Maximum stored versions before oldest is pruned
const MAX_CV_VERSIONS = 5;

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

/** Build the filesystem path for a versioned CV file */
function cvPath(filename) {
  return path.join(UPLOADS_DIR, filename);
}

/** Generate a timestamped CV filename with a random suffix to prevent same-second collisions */
function timestampedFilename() {
  const now  = new Date();
  const ts   = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = randomBytes(3).toString('hex');
  return `cv-${ts}-${rand}.pdf`;
}

/**
 * Lightly scan the PDF buffer for strings that look like private info.
 * Returns an array of warning strings.
 */
function scanForPrivateInfo(buffer) {
  const text     = buffer.toString('latin1');
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

/** Get the current CV row from DB, or null */
async function currentCvRow() {
  const res = await pool.query(
    `SELECT id, filename, uploaded_at FROM cvs WHERE is_current = TRUE LIMIT 1`
  );
  return res.rows[0] || null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Public: check whether a current CV exists
router.get('/exists', cvRateLimit, async (_req, res, next) => {
  try {
    const row = await currentCvRow();
    const exists = row ? fs.existsSync(cvPath(row.filename)) : false;
    res.json({ exists });
  } catch (err) {
    next(err);
  }
});

// Public: download the current CV
router.get('/', cvRateLimit, async (req, res, next) => {
  try {
    const row = await currentCvRow();
    if (!row) return res.status(404).json({ error: 'No CV uploaded yet' });
    const filePath = cvPath(row.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No CV uploaded yet' });
    res.download(filePath, 'Andy_Keys_CV.pdf', (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: 'Failed to send CV' });
      }
    });
  } catch (err) {
    next(err);
  }
});

// Admin: list all stored CV versions (newest first)
router.get('/history', cvRateLimit, authenticate, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, filename, uploaded_at, is_current FROM cvs ORDER BY uploaded_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, '[cv] GET /history failed');
    next(err);
  }
});

// Admin: upload a new CV version — auto-publishes only when no privacy warnings
router.post('/', cvRateLimit, authenticate, wrapMulter(upload.single('cv')), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const warnings  = scanForPrivateInfo(req.file.buffer);
  const filename  = timestampedFilename();
  const filePath  = cvPath(filename);
  const isCurrent = warnings.length === 0;

  const client = await pool.connect();
  try {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(filePath, req.file.buffer);

    await client.query('BEGIN');

    if (isCurrent) {
      await client.query(`UPDATE cvs SET is_current = FALSE WHERE is_current = TRUE`);
    }

    const { rows } = await client.query(
      `INSERT INTO cvs (filename, is_current) VALUES ($1, $2) RETURNING id`,
      [filename, isCurrent]
    );
    const newId = rows[0].id;

    if (isCurrent) {
      const all = await client.query(
        `SELECT id, filename FROM cvs ORDER BY uploaded_at DESC OFFSET $1`,
        [MAX_CV_VERSIONS]
      );
      for (const old of all.rows) {
        try { fs.unlinkSync(cvPath(old.filename)); } catch { /* already gone */ }
        await client.query(`DELETE FROM cvs WHERE id = $1`, [old.id]);
      }
    }

    await client.query('COMMIT');

    await logAudit(req, 'cv.upload', 'cv', newId, { filename, size: req.file.size, pending: !isCurrent });
    logger.info({ filename, id: newId, isCurrent }, '[cv] CV version uploaded');

    if (isCurrent) {
      res.status(200).json({ uploaded: true, id: newId, filename, warnings: [] });
    } else {
      res.status(200).json({ pending: true, id: newId, filename, warnings });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    logger.error({ err }, '[cv] CV upload failed');
    next(err);
  } finally {
    client.release();
  }
});

// Admin: set a specific version as current
router.put('/:id/set-current', cvRateLimit, authenticate, async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'CV version not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(`SELECT id, filename FROM cvs WHERE id = $1`, [req.params.id]);
    if (!check.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'CV version not found' });
    }
    const { filename } = check.rows[0];
    if (!fs.existsSync(cvPath(filename))) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'CV file missing from disk' });
    }

    await client.query(`UPDATE cvs SET is_current = FALSE WHERE is_current = TRUE`);
    await client.query(`UPDATE cvs SET is_current = TRUE WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');

    await logAudit(req, 'cv.set_current', 'cv', req.params.id, { filename });
    logger.info({ id: req.params.id, filename }, '[cv] CV version set as current');
    res.json({ updated: true, id: req.params.id, filename });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[cv] set-current failed');
    next(err);
  } finally {
    client.release();
  }
});

// Admin: confirm a staged (pending) CV version — sets it as current
router.post('/:id/confirm', cvRateLimit, authenticate, async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'CV version not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(`SELECT id, filename FROM cvs WHERE id = $1`, [req.params.id]);
    if (!check.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'CV version not found' });
    }
    const { filename } = check.rows[0];

    await client.query(`UPDATE cvs SET is_current = FALSE WHERE is_current = TRUE`);
    await client.query(`UPDATE cvs SET is_current = TRUE WHERE id = $1`, [req.params.id]);

    const all = await client.query(
      `SELECT id, filename FROM cvs ORDER BY uploaded_at DESC OFFSET $1`,
      [MAX_CV_VERSIONS]
    );
    for (const old of all.rows) {
      try { fs.unlinkSync(cvPath(old.filename)); } catch { /* already gone */ }
      await client.query(`DELETE FROM cvs WHERE id = $1`, [old.id]);
    }

    await client.query('COMMIT');

    await logAudit(req, 'cv.confirm', 'cv', req.params.id, { filename });
    logger.info({ id: req.params.id, filename }, '[cv] Staged CV version confirmed as current');
    res.json({ confirmed: true, id: req.params.id, filename });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[cv] CV confirm failed');
    next(err);
  } finally {
    client.release();
  }
});

// Admin: delete a specific CV version
router.delete('/:id', cvRateLimit, authenticate, async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'CV version not found' });
  try {
    const check = await pool.query(`SELECT id, filename, is_current FROM cvs WHERE id = $1`, [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'CV version not found' });

    const { filename, is_current } = check.rows[0];
    if (is_current) {
      return res.status(400).json({ error: 'Cannot delete the current CV — set another version as current first, or upload a replacement' });
    }

    try { fs.unlinkSync(cvPath(filename)); } catch { /* already gone */ }
    await pool.query(`DELETE FROM cvs WHERE id = $1`, [req.params.id]);

    await logAudit(req, 'cv.delete', 'cv', req.params.id, { filename });
    logger.info({ id: req.params.id, filename }, '[cv] CV version deleted');
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, '[cv] CV delete failed');
    next(err);
  }
});

export default router;
