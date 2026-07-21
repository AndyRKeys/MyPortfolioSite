import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveUser } from '../middleware/resolveUser.js';
import { rateLimit } from 'express-rate-limit';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { slugify, findUniqueSlug } from '../utils/slugify.js';
import { validate, CreateTravelSchema, UpdateTravelSchema } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';
import { TRAVEL_RATE_WINDOW_MS, TRAVEL_RATE_LIMIT } from '../utils/constants.js';
import { publicCache, noStore } from '../middleware/cacheHeaders.js';
import { logAudit } from '../utils/audit.js';
import { wrapMulter } from '../utils/wrapMulter.js';

const router = Router();

// Separate keyType from posts (#445 — shared counters caused cross-route lockout).
// Owner is exempt via exemptIfTrusted (which verifies the JWT inline); cap
// targets anonymous scraping and fuzz attempts against the protected CRUD
// surface. The limiter precedes resolveUser in the chain so CodeQL's
// js/missing-rate-limiting detector sees it before any authorization step.
const travelRateLimit = rateLimit({
  windowMs:        TRAVEL_RATE_WINDOW_MS,
  limit:           TRAVEL_RATE_LIMIT,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { positiveHits: false },
  store:           new PostgresStore({ windowMs: TRAVEL_RATE_WINDOW_MS, keyType: 'travel' }),
});

const TRAVEL_COLS = `
  p.id, p.title, p.slug, p.location,
  p.body_markdown AS notes,
  p.media_url, p.media_type, p.full_url, p.thumb_url, p.media_status, p.lat, p.lng,
  p.post_date,
  p.location_estimated, p.published_at, p.created_at,
  COALESCE(
    (SELECT json_agg(
       json_build_object('id', pm.id, 'url', pm.media_url, 'type', pm.media_type,
         'full_url', pm.full_url, 'thumb_url', pm.thumb_url, 'media_status', pm.media_status)
       ORDER BY pm.order_index, pm.created_at
     )
     FROM post_media pm WHERE pm.post_id = p.id
    ), '[]'::json
  ) AS media
`;

// Public variant: coordinates rounded to ~1km precision for privacy
const TRAVEL_COLS_PUBLIC = `
  p.id, p.title, p.slug, p.location,
  p.body_markdown AS notes,
  p.media_url, p.media_type, p.full_url, p.thumb_url, p.media_status, ROUND(p.lat, 2) AS lat, ROUND(p.lng, 2) AS lng,
  p.post_date,
  p.location_estimated, p.published_at, p.created_at,
  COALESCE(
    (SELECT json_agg(
       json_build_object('id', pm.id, 'url', pm.media_url, 'type', pm.media_type,
         'full_url', pm.full_url, 'thumb_url', pm.thumb_url, 'media_status', pm.media_status)
       ORDER BY pm.order_index, pm.created_at
     )
     FROM post_media pm WHERE pm.post_id = p.id
    ), '[]'::json
  ) AS media
`;

async function replaceMedia(client, postId, mediaItems) {
  // Fetch existing media to preserve processed derivatives
  const existing = await client.query(
    'SELECT media_url, full_url, thumb_url, media_status FROM post_media WHERE post_id = $1',
    [postId],
  );
  const processedByUrl = {};
  for (const row of existing.rows) {
    if (row.media_status === 'ready') {
      processedByUrl[row.media_url] = {
        full_url: row.full_url,
        thumb_url: row.thumb_url,
        media_status: row.media_status,
      };
    }
  }

  await client.query('DELETE FROM post_media WHERE post_id = $1', [postId]);

  if (!mediaItems || !mediaItems.length) return;

  // Build VALUES placeholders: each row = (post_id, media_url, media_type, media_status, order_index, full_url, thumb_url)
  const values = [];
  const params = [];
  mediaItems.forEach((m, i) => {
    const base = i * 7;
    const alreadyProcessed = processedByUrl[m.url];
    const isNewUpload = m.url && m.url.startsWith('/uploads/original/');
    const mediaStatus = alreadyProcessed
      ? alreadyProcessed.media_status
      : (isNewUpload ? 'pending' : null);
    const fullUrl  = alreadyProcessed ? alreadyProcessed.full_url  : null;
    const thumbUrl = alreadyProcessed ? alreadyProcessed.thumb_url : null;

    values.push(`($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5}, $${base+6}, $${base+7})`);
    params.push(postId, m.url, m.type, mediaStatus, i, fullUrl, thumbUrl);
  });

  await client.query(
    `INSERT INTO post_media (post_id, media_url, media_type, media_status, order_index, full_url, thumb_url)
     VALUES ${values.join(', ')}`,
    params,
  );
}

// Public: published travel posts
router.get('/', travelRateLimit, resolveUser, publicCache(60), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${TRAVEL_COLS_PUBLIC}
       FROM posts p
       WHERE p.post_type = 'travel' AND p.published_at IS NOT NULL
       ORDER BY p.post_date DESC, p.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, '[travel] Request failed');
    next(err);
  }
});

// Admin: all travel posts including drafts
router.get('/all', travelRateLimit, resolveUser, authenticate, noStore, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${TRAVEL_COLS}
       FROM posts p
       WHERE p.post_type = 'travel'
       ORDER BY p.post_date DESC, p.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, '[travel] Request failed');
    next(err);
  }
});

// Admin: single travel post by id (includes drafts)
router.get('/admin/:id', travelRateLimit, resolveUser, authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${TRAVEL_COLS} FROM posts p WHERE p.id = $1 AND p.post_type = 'travel'`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Memory not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, '[travel] Request failed');
    next(err);
  }
});

// Public: single published travel post by id
router.get('/:id', travelRateLimit, resolveUser, publicCache(300), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${TRAVEL_COLS_PUBLIC} FROM posts p
       WHERE p.id = $1 AND p.post_type = 'travel' AND p.published_at IS NOT NULL`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Memory not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, '[travel] Request failed');
    next(err);
  }
});

// Admin: create travel post
router.post('/', travelRateLimit, resolveUser, authenticate, validate(CreateTravelSchema), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { title, location, notes, media_items, lat, lng, post_date, publish } = req.body;
    // title guaranteed present by validate()

    const latVal     = lat  != null ? parseFloat(lat)  : null;
    const lngVal     = lng  != null ? parseFloat(lng)  : null;
    const postDateVal = post_date || null;
    const publishedAt = publish ? new Date() : null;

    const slug = await findUniqueSlug(client, slugify(title, 'travel'));

    const firstMedia = media_items && media_items.length ? media_items[0] : null;
    const insert = await client.query(
      `INSERT INTO posts
         (post_type, title, slug, body_markdown, post_date, published_at,
          location, media_url, media_type, lat, lng)
       VALUES ('travel', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [title.trim(), slug, notes?.trim() || '', postDateVal, publishedAt,
       location?.trim() || null,
       firstMedia?.url || null, firstMedia?.type || null,
       latVal, lngVal]
    );
    const postId = insert.rows[0].id;

    if (media_items && media_items.length) {
      await replaceMedia(client, postId, media_items);
    }

    await client.query('COMMIT');

    const result = await pool.query(
      `SELECT ${TRAVEL_COLS} FROM posts p WHERE p.id = $1`, [postId]
    );
    await logAudit(req, 'travel.create', 'travel', postId, { title: title.trim(), published: !!publishedAt });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[travel] Request failed');
    next(err);
  } finally {
    client.release();
  }
});

// Admin: update travel post
router.put('/:id', travelRateLimit, resolveUser, authenticate, validate(UpdateTravelSchema), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { title, location, notes, media_items, lat, lng, post_date, publish } = req.body;
    // title guaranteed present by validate()

    const existing = await client.query(
      `SELECT * FROM posts WHERE id = $1 AND post_type = 'travel'`,
      [req.params.id]
    );
    if (!existing.rows.length) {
      // Roll back the open transaction before returning — otherwise `finally`
      // releases the client to the pool mid-transaction (#522 H2).
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Memory not found' });
    }

    const latVal      = lat  != null ? parseFloat(lat)  : null;
    const lngVal      = lng  != null ? parseFloat(lng)  : null;
    const postDateVal  = post_date || null;

    let { published_at } = existing.rows[0];
    if (publish && !published_at) published_at = new Date();
    if (publish === false) published_at = null;

    const firstMedia = media_items && media_items.length ? media_items[0] : null;
    await client.query(
      `UPDATE posts SET
         title=$1, body_markdown=$2, post_date=$3, published_at=$4,
         location=$5, media_url=$6, media_type=$7, lat=$8, lng=$9,
         updated_at=NOW()
       WHERE id=$10 AND post_type='travel'`,
      [title.trim(), notes?.trim() || '', postDateVal, published_at,
       location?.trim() || null,
       firstMedia?.url || null, firstMedia?.type || null,
       latVal, lngVal, req.params.id]
    );

    if (media_items !== undefined) {
      await replaceMedia(client, req.params.id, media_items);
    }

    await client.query('COMMIT');

    const result = await pool.query(
      `SELECT ${TRAVEL_COLS} FROM posts p WHERE p.id = $1`, [req.params.id]
    );
    const updated = result.rows[0];
    const wasPublished = !!existing.rows[0].published_at;
    const nowPublished = !!updated?.published_at;
    const auditAction  = !wasPublished && nowPublished ? 'travel.publish'
                       : wasPublished && !nowPublished ? 'travel.unpublish'
                       : 'travel.update';
    await logAudit(req, auditAction, 'travel', req.params.id, { title: title?.trim() });
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[travel] Request failed');
    next(err);
  } finally {
    client.release();
  }
});

// Admin: delete travel post (CASCADE removes post_media rows)
router.delete('/:id', travelRateLimit, resolveUser, authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM posts WHERE id = $1 AND post_type = 'travel' RETURNING id, title`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Memory not found' });
    await logAudit(req, 'travel.delete', 'travel', result.rows[0].id, { title: result.rows[0].title });
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, '[travel] Request failed');
    next(err);
  }
});

// ── CSV import ────────────────────────────────────────────────────────────────

const CSV_MAX_BYTES = 1 * 1024 * 1024; // 1 MB

// Memory-only multer — CSV content is parsed in-process, no file written to disk.
// Extension check is the authoritative gate: browsers are inconsistent with MIME
// types for .csv files (text/csv, text/plain, application/vnd.ms-excel all occur).
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CSV_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only .csv files are accepted — file must have a .csv extension'));
    }
  },
});

// Parse a single CSV line, handling double-quoted fields and escaped quotes ("").
function parseCSVLine(line) {
  // Type guard (CodeQL js/loop-bound-injection): a non-string value with a
  // crafted .length property would make the loop below effectively unbounded.
  if (typeof line !== 'string') return [];
  const fields = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote inside a quoted field
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// Parse CSV text into { headers: string[], rows: object[] }.
// Each row is a plain object keyed by lowercase header name.
// Empty lines and CRLF are handled; the header row is normalised to lowercase.
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const rows    = lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj    = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ''; });
    return obj;
  });
  return { headers, rows };
}

const CSV_TEMPLATE_HEADERS = 'title,location,notes,post_date,lat,lng,publish';

// Admin: bulk-import travel entries from a CSV file.
// Accepts multipart/form-data with a single "file" field (must be .csv, max 1 MB).
// Response: { imported: N, skipped: N, errors: [{ row: N, reason: string }] }
router.post('/import', travelRateLimit, resolveUser, authenticate, wrapMulter(csvUpload.single('file')), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file received' });

  const csvText = req.file.buffer.toString('utf8');
  const { headers, rows } = parseCSV(csvText);

  if (!headers.includes('title')) {
    logger.warn({ headers }, '[travel/import] CSV missing required title column');
    return res.status(400).json({
      error: 'Invalid CSV format — required "title" column not found in header row',
      expected: CSV_TEMPLATE_HEADERS,
    });
  }

  logger.info({ rowCount: rows.length }, '[travel/import] Starting CSV import');

  let imported = 0;
  let skipped  = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2; // header is row 1; data starts at row 2

    const title = (row.title ?? '').trim();
    if (!title) {
      skipped++;
      errors.push({ row: rowNum, reason: 'title is required' });
      continue;
    }

    let postDate = (row.post_date ?? '').trim() || null;
    if (postDate) {
      // Accept DD/MM/YYYY (Excel default) and normalise to YYYY-MM-DD
      const dmyMatch = postDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (dmyMatch) postDate = `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(postDate)) {
        skipped++;
        errors.push({ row: rowNum, reason: `post_date "${row.post_date}" must be YYYY-MM-DD or DD/MM/YYYY` });
        continue;
      }
    }

    const latRaw = (row.lat ?? '').trim();
    const lngRaw = (row.lng ?? '').trim();
    const lat    = latRaw ? parseFloat(latRaw) : null;
    const lng    = lngRaw ? parseFloat(lngRaw) : null;
    if ((latRaw && isNaN(lat)) || (lngRaw && isNaN(lng))) {
      skipped++;
      errors.push({ row: rowNum, reason: 'lat and lng must be valid decimal numbers' });
      continue;
    }

    const location    = (row.location ?? '').trim() || null;
    const notes       = (row.notes ?? '').trim() || '';
    const publishRaw  = (row.publish ?? '').trim().toLowerCase();
    const publishedAt = publishRaw === 'true' ? new Date() : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const slug = await findUniqueSlug(client, slugify(title, 'travel'));
      await client.query(
        `INSERT INTO posts
           (post_type, title, slug, body_markdown, post_date, published_at, location, lat, lng)
         VALUES ('travel', $1, $2, $3, $4, $5, $6, $7, $8)`,
        [title, slug, notes, postDate, publishedAt, location, lat, lng]
      );
      await client.query('COMMIT');
      imported++;
    } catch (err) {
      await client.query('ROLLBACK');
      skipped++;
      logger.warn({ err, rowNum, title }, '[travel/import] Row insert failed');
      errors.push({ row: rowNum, reason: err.message });
    } finally {
      client.release();
    }
  }

  await logAudit(req, 'travel.import', 'travel', null, { imported, skipped, total: rows.length });
  logger.info({ imported, skipped, total: rows.length }, '[travel/import] CSV import complete');

  res.json({ imported, skipped, errors });
});

// Admin: delete a single media item from post_media
router.delete('/:id/media/:mediaId', travelRateLimit, resolveUser, authenticate, async (req, res, next) => {
  const client = await pool.connect();
  try {
    // DELETE + posts.media_url resync must be atomic — wrap in a transaction
    // and audit like every other travel mutation (#522 L11).
    await client.query('BEGIN');
    const result = await client.query(
      `DELETE FROM post_media WHERE id = $1 AND post_id = $2 RETURNING id, media_url`,
      [req.params.mediaId, req.params.id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Media item not found' });
    }

    const first = await client.query(
      `SELECT media_url, media_type FROM post_media WHERE post_id = $1 ORDER BY order_index, created_at LIMIT 1`,
      [req.params.id]
    );
    await client.query(
      'UPDATE posts SET media_url = $1, media_type = $2 WHERE id = $3',
      [first.rows[0]?.media_url || null, first.rows[0]?.media_type || null, req.params.id]
    );

    await client.query('COMMIT');

    await logAudit(req, 'travel.media_delete', 'travel', req.params.id, { mediaId: req.params.mediaId });
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, '[travel] Request failed');
    next(err);
  } finally {
    client.release();
  }
});

export default router;
