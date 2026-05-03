import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

// Shared SELECT columns — aliases keep the frontend field names unchanged
const TRAVEL_COLS = `
  id, title, slug, location,
  body_markdown AS notes,
  media_url, media_type, lat, lng,
  post_date AS visit_date,
  location_estimated, published_at, created_at
`;

// Public: published travel posts
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${TRAVEL_COLS}
       FROM posts
       WHERE post_type = 'travel' AND published_at IS NOT NULL
       ORDER BY post_date DESC, created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: all travel posts including drafts
router.get('/all', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${TRAVEL_COLS}
       FROM posts
       WHERE post_type = 'travel'
       ORDER BY post_date DESC, created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: single travel post by id (includes drafts)
router.get('/admin/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${TRAVEL_COLS} FROM posts WHERE id = $1 AND post_type = 'travel'`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Memory not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: create travel post
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, location, notes, mediaUrl, mediaType, lat, lng, visitDate, publish } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const latVal = lat !== undefined && lat !== '' ? parseFloat(lat) : null;
    const lngVal = lng !== undefined && lng !== '' ? parseFloat(lng) : null;
    const postDateVal = visitDate || null;
    const publishedAt = publish ? new Date() : null;

    // Generate a slug from the title
    const baseSlug = title.trim().toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 90);
    let slug = baseSlug || 'travel';
    let i = 1;
    while (true) {
      const { rows } = await pool.query('SELECT id FROM posts WHERE slug = $1', [slug]);
      if (!rows.length) break;
      slug = `${baseSlug}-${i++}`;
    }

    const result = await pool.query(
      `INSERT INTO posts
         (post_type, title, slug, body_markdown, post_date, published_at,
          location, media_url, media_type, lat, lng)
       VALUES ('travel', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${TRAVEL_COLS}`,
      [title.trim(), slug, notes?.trim() || '', postDateVal, publishedAt,
       location?.trim() || null, mediaUrl || null, mediaType || null, latVal, lngVal]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: update travel post
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { title, location, notes, mediaUrl, mediaType, lat, lng, visitDate, publish } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const existing = await pool.query(
      `SELECT * FROM posts WHERE id = $1 AND post_type = 'travel'`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Memory not found' });

    const latVal = lat !== undefined && lat !== '' ? parseFloat(lat) : null;
    const lngVal = lng !== undefined && lng !== '' ? parseFloat(lng) : null;
    const postDateVal = visitDate || null;

    let { published_at } = existing.rows[0];
    if (publish && !published_at) published_at = new Date();
    if (publish === false) published_at = null;

    const result = await pool.query(
      `UPDATE posts SET
         title=$1, body_markdown=$2, post_date=$3, published_at=$4,
         location=$5, media_url=$6, media_type=$7, lat=$8, lng=$9,
         updated_at=NOW()
       WHERE id=$10 AND post_type='travel'
       RETURNING ${TRAVEL_COLS}`,
      [title.trim(), notes?.trim() || '', postDateVal, published_at,
       location?.trim() || null, mediaUrl || null, mediaType || null, latVal, lngVal,
       req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: delete travel post
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM posts WHERE id = $1 AND post_type = 'travel' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Memory not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
