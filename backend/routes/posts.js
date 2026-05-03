import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

async function uniqueSlug(base) {
  let slug = base;
  let i = 1;
  while (true) {
    const { rows } = await pool.query('SELECT id FROM posts WHERE slug = $1', [slug]);
    if (!rows.length) return slug;
    slug = `${base}-${i++}`;
  }
}

// Public: list published posts
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, published_at, created_at,
              left(body_markdown, 300) AS excerpt
       FROM posts WHERE published_at IS NOT NULL
       ORDER BY published_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: list all posts (drafts + published)
router.get('/all', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, published_at, created_at,
              left(body_markdown, 300) AS excerpt
       FROM posts ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: single post by id — includes drafts
router.get('/admin/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, slug, body_markdown, published_at, created_at FROM posts WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Public: single post by slug
router.get('/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, slug, body_markdown, published_at, created_at FROM posts WHERE slug = $1 AND published_at IS NOT NULL',
      [req.params.slug]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: create post
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, body_markdown, publish } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const base = slugify(title) || 'post';
    const slug = await uniqueSlug(base);
    const publishedAt = publish ? new Date() : null;

    const result = await pool.query(
      `INSERT INTO posts (title, slug, body_markdown, published_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title.trim(), slug, body_markdown || '', publishedAt]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: update post
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { title, body_markdown, publish } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    // Recalculate slug only if title changed
    const existing = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Post not found' });

    let { slug, published_at } = existing.rows[0];

    if (existing.rows[0].title !== title.trim()) {
      const base = slugify(title) || 'post';
      slug = await uniqueSlug(base);
    }

    if (publish && !published_at) published_at = new Date();
    if (publish === false) published_at = null;

    const result = await pool.query(
      `UPDATE posts SET title=$1, slug=$2, body_markdown=$3, published_at=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [title.trim(), slug, body_markdown || '', published_at, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin: delete post
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM posts WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
