import { Router } from 'express';
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
  store:           new PostgresStore({ windowMs: TRAVEL_RATE_WINDOW_MS, keyType: 'travel' }),
});

const TRAVEL_COLS = `
  p.id, p.title, p.slug, p.location,
  p.body_markdown AS notes,
  p.media_url, p.media_type, p.lat, p.lng,
  p.post_date,
  p.location_estimated, p.published_at, p.created_at,
  COALESCE(
    (SELECT json_agg(
       json_build_object('id', pm.id, 'url', pm.media_url, 'type', pm.media_type)
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
  p.media_url, p.media_type, ROUND(p.lat, 2) AS lat, ROUND(p.lng, 2) AS lng,
  p.post_date,
  p.location_estimated, p.published_at, p.created_at,
  COALESCE(
    (SELECT json_agg(
       json_build_object('id', pm.id, 'url', pm.media_url, 'type', pm.media_type)
       ORDER BY pm.order_index, pm.created_at
     )
     FROM post_media pm WHERE pm.post_id = p.id
    ), '[]'::json
  ) AS media
`;

async function replaceMedia(client, postId, mediaItems) {
  await client.query('DELETE FROM post_media WHERE post_id = $1', [postId]);
  if (!mediaItems || !mediaItems.length) {
    await client.query(
      'UPDATE posts SET media_url = NULL, media_type = NULL WHERE id = $1',
      [postId]
    );
    return;
  }
  const vals   = mediaItems.map((m, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3}, ${i})`).join(', ');
  const params = [postId, ...mediaItems.flatMap(m => [m.url, m.type || null])];
  await client.query(
    `INSERT INTO post_media (post_id, media_url, media_type, order_index) VALUES ${vals}`,
    params
  );
  await client.query(
    'UPDATE posts SET media_url = $1, media_type = $2 WHERE id = $3',
    [mediaItems[0].url, mediaItems[0].type || null, postId]
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
    if (!existing.rows.length) return res.status(404).json({ error: 'Memory not found' });

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

// Admin: delete a single media item from post_media
router.delete('/:id/media/:mediaId', travelRateLimit, resolveUser, authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM post_media WHERE id = $1 AND post_id = $2 RETURNING id`,
      [req.params.mediaId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Media item not found' });

    const first = await pool.query(
      `SELECT media_url, media_type FROM post_media WHERE post_id = $1 ORDER BY order_index, created_at LIMIT 1`,
      [req.params.id]
    );
    await pool.query(
      'UPDATE posts SET media_url = $1, media_type = $2 WHERE id = $3',
      [first.rows[0]?.media_url || null, first.rows[0]?.media_type || null, req.params.id]
    );
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, '[travel] Request failed');
    next(err);
  }
});

export default router;
