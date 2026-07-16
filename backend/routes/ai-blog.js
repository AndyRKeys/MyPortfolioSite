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
import { generateAiBlogPost } from '../utils/aiGenerate.js';

const router = Router();

// Shares the posts rate-limit constants — same traffic profile, same abuse
// surface. Admin is exempt via exemptIfTrusted (inline JWT check).
const aiBlogRateLimit = rateLimit(rateLimiterOptions({
  windowMs: POSTS_RATE_WINDOW_MS,
  limit:    POSTS_RATE_LIMIT,
  keyType:  'ai-blog',
}));

// ── AI generation constants (system prompt lives in utils/aiGenerate.js)

// ── Helpers

async function insertAiBlogPost(title, body_markdown, post_date, published_at) {
  const slug   = await findUniqueSlug(pool, slugify(title));
  const result = await pool.query(
    `INSERT INTO posts (post_type, title, slug, body_markdown, post_date, published_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    ['ai-blog', title.trim(), slug, body_markdown || '', post_date, published_at]
  );
  return result.rows[0];
}

// ── Routes

// Public: list published AI dev blog posts
router.get('/', aiBlogRateLimit, resolveUser, publicCache(60), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, post_date, published_at, created_at,
              left(body_markdown, ${EXCERPT_LENGTH}) AS excerpt
       FROM posts
       WHERE post_type = 'ai-blog' AND published_at IS NOT NULL
       ORDER BY COALESCE(post_date, published_at::date) DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, '[ai-blog] Request failed');
    next(err);
  }
});

// Admin: list all AI dev blog posts (drafts + published)
router.get('/all', aiBlogRateLimit, resolveUser, authenticate, noStore, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, post_date, published_at, created_at,
              left(body_markdown, ${EXCERPT_LENGTH}) AS excerpt
       FROM posts
       WHERE post_type = 'ai-blog'
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, '[ai-blog] Request failed');
    next(err);
  }
});

// Admin: single AI dev blog post by id (includes drafts)
router.get('/admin/:id', aiBlogRateLimit, resolveUser, authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, body_markdown, post_date, published_at, created_at
       FROM posts WHERE id = $1 AND post_type = 'ai-blog'`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, '[ai-blog] Request failed');
    next(err);
  }
});

// Public: single AI dev blog post by slug
router.get('/:slug', aiBlogRateLimit, resolveUser, publicCache(300), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, body_markdown, post_date, published_at, created_at
       FROM posts
       WHERE slug = $1 AND post_type = 'ai-blog' AND published_at IS NOT NULL`,
      [req.params.slug]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, '[ai-blog] Request failed');
    next(err);
  }
});

// Admin: create AI dev blog post
router.post('/', aiBlogRateLimit, resolveUser, authenticate, validate(CreatePostSchema), async (req, res, next) => {
  try {
    const { title, body_markdown, post_date, publish } = req.body;
    const publishedAt = publish ? new Date() : null;
    const postDateVal  = post_date || null;
    const result = await insertAiBlogPost(title, body_markdown, postDateVal, publishedAt);
    await logAudit(req, 'ai_blog.create', 'ai-blog', result.id, { title: result.title, published: !!publishedAt });
    res.status(201).json(result);
  } catch (err) {
    logger.error({ err }, '[ai-blog] Request failed');
    next(err);
  }
});

// Admin: update AI dev blog post
router.put('/:id', aiBlogRateLimit, resolveUser, authenticate, validate(UpdatePostSchema), async (req, res, next) => {
  try {
    const { title, body_markdown, post_date, publish } = req.body;

    const existing = await pool.query(
      `SELECT * FROM posts WHERE id = $1 AND post_type = 'ai-blog'`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Entry not found' });

    let { slug, published_at } = existing.rows[0];
    if (existing.rows[0].title !== title.trim()) {
      slug = await findUniqueSlug(pool, slugify(title), { excludeId: req.params.id });
    }
    if (publish && !published_at) published_at = new Date();
    if (publish === false) published_at = null;

    const result = await pool.query(
      `UPDATE posts
       SET title=$1, slug=$2, body_markdown=$3, post_date=$4, published_at=$5, updated_at=NOW()
       WHERE id=$6 AND post_type='ai-blog'
       RETURNING *`,
      [title.trim(), slug, body_markdown || '', post_date || null, published_at, req.params.id]
    );
    const updated = result.rows[0];
    const wasPublished = !!existing.rows[0].published_at;
    const nowPublished = !!updated.published_at;
    const auditAction  = !wasPublished && nowPublished ? 'ai_blog.publish'
                       : wasPublished && !nowPublished ? 'ai_blog.unpublish'
                       : 'ai_blog.update';
    await logAudit(req, auditAction, 'ai-blog', updated.id, { title: updated.title });
    res.json(updated);
  } catch (err) {
    logger.error({ err }, '[ai-blog] Request failed');
    next(err);
  }
});

// Admin: generate a draft AI dev blog post via Ollama (primary) or Anthropic API (fallback)
router.post('/generate', aiBlogRateLimit, resolveUser, authenticate, async (req, res, next) => {
  const { context } = req.body || {};
  try {
    const { title, body_markdown } = await generateAiBlogPost(context || null, 'route');
    res.json({ title, body_markdown });
  } catch (err) {
    // Provider not available — 503; all other fetch errors bubble as 502
    if (err.message?.includes('No AI provider available')) {
      return res.status(503).json({ error: err.message });
    }
    if (err.message?.includes('AI generation failed')) {
      return res.status(502).json({ error: err.message });
    }
    logger.error({ err }, '[ai-blog-generate] Fetch to AI provider failed');
    next(err);
  }
});

// Admin: delete AI dev blog post
router.delete('/:id', aiBlogRateLimit, resolveUser, authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM posts WHERE id = $1 AND post_type = 'ai-blog' RETURNING id, title`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
    await logAudit(req, 'ai_blog.delete', 'ai-blog', result.rows[0].id, { title: result.rows[0].title });
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, '[ai-blog] Request failed');
    next(err);
  }
});

export default router;
