import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

// Shared SELECT — aliases keep frontend field names; media aggregated from post_media
const TRAVEL_COLS = `
  p.id, p.title, p.slug, p.location,
  p.body_markdown AS notes,
  p.media_url, p.media_type, p.lat, p.lng,
  p.post_date AS visit_date,
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

function slugify(title) {
  return title.trim().toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 90);
}

// Replace all post_media rows for a post and sync posts.media_url/media_type to first item.
async function replaceMedia(client, postId, mediaItems) {
  await client.query('DELETE FROM post_media WHERE post_id = $1', [postId]);
  if (!mediaItems || !mediaItems.length) {
    await client.query(
      'UPDATE posts SET media_url = NULL, media_type = NULL WHERE id = $1',
      [postId]
    );
    return;
  }
  const vals = mediaItems.map((m, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3}, ${i})`).join(', ');
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
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${TRAVEL_COLS}
       FROM posts p
       WHERE p.post_type = 'travel' AND p.published_at IS NOT NULL
       ORDER BY p.post_date DESC, p.created_at DESC`
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
       FROM posts p
       WHERE p.post_type = 'travel'
       ORDER BY p.post_date DESC, p.created_at DESC`
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
      `SELECT ${TRAVEL_COLS} FROM posts p WHERE p.id = $1 AND p.post_type = 'travel'`,
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { title, location, notes, mediaItems, lat, lng, visitDate, publish } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const latVal = lat !== undefined && lat !== '' ? parseFloat(lat) : null;
    const lngVal = lng !== undefined && lng !== '' ? parseFloat(lng) : null;
    const postDateVal = visitDate || null;
    const publishedAt = publish ? new Date() : null;

    const baseSlug = slugify(title) || 'travel';
    let slug = baseSlug;
    let i = 1;
    let postId = null;

    // Try to insert with ON CONFLICT, retry with incremented slug on collision
    while (!postId && i <= 100) {
      const firstMedia = mediaItems && mediaItems.length ? mediaItems[0] : null;
      const insert = await client.query(
        `INSERT INTO posts
           (post_type, title, slug, body_markdown, post_date, published_at,
            location, media_url, media_type, lat, lng)
         VALUES ('travel', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [title.trim(), slug, notes?.trim() || '', postDateVal, publishedAt,
         location?.trim() || null,
         firstMedia?.url || null, firstMedia?.type || null,
         latVal, lngVal]
      );

      if (insert.rows.length > 0) {
        postId = insert.rows[0].id;
      } else {
        slug = `${baseSlug}-${i++}`;
      }
    }

    if (!postId) throw new Error('Could not generate unique slug after 100 attempts');

    if (mediaItems && mediaItems.length) {
      await replaceMedia(client, postId, mediaItems);
    }

    await client.query('COMMIT');

    const result = await pool.query(
      `SELECT ${TRAVEL_COLS} FROM posts p WHERE p.id = $1`, [postId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// Admin: update travel post
router.put('/:id', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { title, location, notes, mediaItems, lat, lng, visitDate, publish } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const existing = await client.query(
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

    const firstMedia = mediaItems && mediaItems.length ? mediaItems[0] : null;
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

    // If mediaItems provided, replace all media; otherwise leave existing post_media untouched
    if (mediaItems !== undefined) {
      await replaceMedia(client, req.params.id, mediaItems);
    }

    await client.query('COMMIT');

    const result = await pool.query(
      `SELECT ${TRAVEL_COLS} FROM posts p WHERE p.id = $1`, [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// Admin: delete travel post (CASCADE removes post_media rows)
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

// Admin: delete a single media item from post_media
router.delete('/:id/media/:mediaId', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM post_media WHERE id = $1 AND post_id = $2 RETURNING id`,
      [req.params.mediaId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Media item not found' });

    // Re-sync posts.media_url to the new first item
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
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
