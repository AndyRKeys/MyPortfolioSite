import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveUser } from '../middleware/resolveUser.js';
import { rateLimit } from 'express-rate-limit';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { slugify } from '../utils/slugify.js';
import { validate, CreatePostSchema, UpdatePostSchema } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Per-IP backstop against scraping and credential-stuffing fuzz on blog routes.
// The owner is exempt via resolveUser → exemptIfTrusted, so legitimate admin
// editing never throttles; the cap protects anonymous endpoints from abuse and
// blocks attackers spamming protected routes with random JWTs.
const postsRateLimit = rateLimit({
  windowMs:        60 * 1000,
  limit:           120,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  store:           new PostgresStore({ windowMs: 60 * 1000, keyType: 'posts' }),
});

// ── Helpers

async function tryInsertPost(post_type, title, body_markdown, post_date, published_at, attempt = 0, maxAttempts = 100) {
  const baseSlug = slugify(title);
  const slug     = attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;

  try {
    const result = await pool.query(
      `INSERT INTO posts (post_type, title, slug, body_markdown, post_date, published_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO NOTHING
       RETURNING *`,
      [post_type, title.trim(), slug, body_markdown || '', post_date, published_at]
    );

    if (result.rows.length > 0) {
      return result.rows[0];
    } else if (attempt < maxAttempts) {
      return tryInsertPost(post_type, title, body_markdown, post_date, published_at, attempt + 1, maxAttempts);
    } else {
      throw new Error('Could not generate unique slug after max attempts');
    }
  } catch (err) {
    if (attempt < maxAttempts) {
      return tryInsertPost(post_type, title, body_markdown, post_date, published_at, attempt + 1, maxAttempts);
    }
    throw err;
  }
}

// ── Routes

// Public: list published blog posts
router.get('/', resolveUser, postsRateLimit, async (req, res, next) => { // codeql[js/missing-rate-limiting] — rate-limited via postsRateLimit; resolveUser must precede it so exemptIfTrusted can read req.user to exempt the owner
  try {
    const result = await pool.query(
      `SELECT id, title, slug, post_date, published_at, created_at,
              left(body_markdown, 300) AS excerpt
       FROM posts
       WHERE post_type = 'blog' AND published_at IS NOT NULL
       ORDER BY COALESCE(post_date, published_at::date) DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

// Admin: list all blog posts (drafts + published)
router.get('/all', resolveUser, postsRateLimit, authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, post_date, published_at, created_at,
              left(body_markdown, 300) AS excerpt
       FROM posts
       WHERE post_type = 'blog'
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

// Admin: single blog post by id (includes drafts)
router.get('/admin/:id', resolveUser, postsRateLimit, authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, body_markdown, post_date, published_at, created_at
       FROM posts WHERE id = $1 AND post_type = 'blog'`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

// Public: single blog post by slug
router.get('/:slug', resolveUser, postsRateLimit, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, body_markdown, post_date, published_at, created_at
       FROM posts
       WHERE slug = $1 AND post_type = 'blog' AND published_at IS NOT NULL`,
      [req.params.slug]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

// Admin: create blog post
router.post('/', resolveUser, postsRateLimit, authenticate, validate(CreatePostSchema), async (req, res, next) => { // codeql[js/missing-rate-limiting] — rate-limited via postsRateLimit; resolveUser must precede it so exemptIfTrusted can read req.user to exempt the owner
  try {
    const { title, body_markdown, post_date, publish } = req.body;
    // title guaranteed present by validate()
    const publishedAt = publish ? new Date() : null;
    const postDateVal  = post_date || null;
    const result = await tryInsertPost('blog', title, body_markdown, postDateVal, publishedAt);
    res.status(201).json(result);
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

// Admin: update blog post
router.put('/:id', resolveUser, postsRateLimit, authenticate, validate(UpdatePostSchema), async (req, res, next) => { // codeql[js/missing-rate-limiting] — rate-limited via postsRateLimit; resolveUser must precede it so exemptIfTrusted can read req.user to exempt the owner
  try {
    const { title, body_markdown, post_date, publish } = req.body;
    // title guaranteed present by validate()

    const existing = await pool.query(
      `SELECT * FROM posts WHERE id = $1 AND post_type = 'blog'`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Post not found' });

    let { slug, published_at } = existing.rows[0];
    if (existing.rows[0].title !== title.trim()) {
      const base = slugify(title);
      let attempt = 0;
      let newSlug = base;
      while (attempt < 100) {
        const { rows } = await pool.query(
          `SELECT id FROM posts WHERE slug = $1 AND id != $2`,
          [newSlug, req.params.id]
        );
        if (!rows.length) { slug = newSlug; break; }
        newSlug = `${base}-${++attempt}`;
      }
    }
    if (publish && !published_at) published_at = new Date();
    if (publish === false) published_at = null;

    const result = await pool.query(
      `UPDATE posts
       SET title=$1, slug=$2, body_markdown=$3, post_date=$4, published_at=$5, updated_at=NOW()
       WHERE id=$6 AND post_type='blog'
       RETURNING *`,
      [title.trim(), slug, body_markdown || '', post_date || null, published_at, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

// Admin: delete blog post
router.delete('/:id', resolveUser, postsRateLimit, authenticate, async (req, res, next) => { // codeql[js/missing-rate-limiting] — rate-limited via postsRateLimit; resolveUser must precede it so exemptIfTrusted can read req.user to exempt the owner
  try {
    const result = await pool.query(
      `DELETE FROM posts WHERE id = $1 AND post_type = 'blog' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

export default router;
