import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveUser } from '../middleware/resolveUser.js';
import { rateLimit } from 'express-rate-limit';
import { rateLimiterOptions } from '../middleware/rateLimiter.js';
import { slugify, findUniqueSlug } from '../utils/slugify.js';
import { validate, CreatePostSchema, UpdatePostSchema } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';
import { EXCERPT_LENGTH, POSTS_RATE_WINDOW_MS, POSTS_RATE_LIMIT } from '../utils/constants.js';
import { publicCache, noStore } from '../middleware/cacheHeaders.js';
import { logAudit } from '../utils/audit.js';

const router = Router();

// Per-IP backstop against scraping and credential-stuffing fuzz on blog routes.
// The owner is exempt via exemptIfTrusted (which verifies the JWT inline),
// so legitimate admin editing never throttles; the cap protects anonymous
// endpoints from abuse and blocks attackers spamming protected routes with
// random JWTs. The limiter is placed before resolveUser in the chain so
// CodeQL's js/missing-rate-limiting detector sees it precede authorization.
const postsRateLimit = rateLimit(rateLimiterOptions({
  windowMs: POSTS_RATE_WINDOW_MS,
  limit:    POSTS_RATE_LIMIT,
  keyType:  'posts',
}));

// ── Helpers

async function insertPost(post_type, title, body_markdown, post_date, published_at) {
  const slug   = await findUniqueSlug(pool, slugify(title));
  const result = await pool.query(
    `INSERT INTO posts (post_type, title, slug, body_markdown, post_date, published_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [post_type, title.trim(), slug, body_markdown || '', post_date, published_at]
  );
  return result.rows[0];
}

// ── Routes

// Public: list published blog posts
router.get('/', postsRateLimit, resolveUser, publicCache(60), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, post_date, published_at, created_at,
              left(body_markdown, ${EXCERPT_LENGTH}) AS excerpt
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
router.get('/all', postsRateLimit, resolveUser, authenticate, noStore, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, post_date, published_at, created_at,
              left(body_markdown, ${EXCERPT_LENGTH}) AS excerpt
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
router.get('/admin/:id', postsRateLimit, resolveUser, authenticate, async (req, res, next) => {
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
router.get('/:slug', postsRateLimit, resolveUser, publicCache(300), async (req, res, next) => {
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
router.post('/', postsRateLimit, resolveUser, authenticate, validate(CreatePostSchema), async (req, res, next) => {
  try {
    const { title, body_markdown, post_date, publish } = req.body;
    // title guaranteed present by validate()
    const publishedAt = publish ? new Date() : null;
    const postDateVal  = post_date || null;
    const result = await insertPost('blog', title, body_markdown, postDateVal, publishedAt);
    await logAudit(req, 'post.create', 'post', result.id, { title: result.title, published: !!publishedAt });
    res.status(201).json(result);
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

// Admin: update blog post
router.put('/:id', postsRateLimit, resolveUser, authenticate, validate(UpdatePostSchema), async (req, res, next) => {
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
      slug = await findUniqueSlug(pool, slugify(title), { excludeId: req.params.id });
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
    const updated = result.rows[0];
    // Determine if this was a publish/unpublish action
    const wasPublished   = !!existing.rows[0].published_at;
    const nowPublished   = !!updated.published_at;
    const auditAction    = !wasPublished && nowPublished ? 'post.publish'
                         : wasPublished && !nowPublished ? 'post.unpublish'
                         : 'post.update';
    await logAudit(req, auditAction, 'post', updated.id, { title: updated.title });
    res.json(updated);
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

// Admin: delete blog post
router.delete('/:id', postsRateLimit, resolveUser, authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM posts WHERE id = $1 AND post_type = 'blog' RETURNING id, title`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    await logAudit(req, 'post.delete', 'post', result.rows[0].id, { title: result.rows[0].title });
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, '[posts] Request failed');
    next(err);
  }
});

export default router;
