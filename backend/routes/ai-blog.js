import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveUser } from '../middleware/resolveUser.js';
import { rateLimit } from 'express-rate-limit';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { slugify, findUniqueSlug } from '../utils/slugify.js';
import { validate, CreatePostSchema, UpdatePostSchema } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';
import { EXCERPT_LENGTH, POSTS_RATE_WINDOW_MS, POSTS_RATE_LIMIT } from '../utils/constants.js';
import { publicCache, noStore } from '../middleware/cacheHeaders.js';
import { logAudit } from '../utils/audit.js';

const router = Router();

// Shares the posts rate-limit constants — same traffic profile, same abuse
// surface. Admin is exempt via exemptIfTrusted (inline JWT check).
const aiBlogRateLimit = rateLimit({
  windowMs:        POSTS_RATE_WINDOW_MS,
  limit:           POSTS_RATE_LIMIT,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { positiveHits: false },
  store:           new PostgresStore({ windowMs: POSTS_RATE_WINDOW_MS, keyType: 'ai-blog' }),
});

// ── AI generation constants

const AI_GENERATE_SYSTEM_PROMPT = `You are writing an AI dev blog post for a personal portfolio site. The owner (Andy) documents pair-programming sessions with Claude AI. Write in first person plural ("we") — Andy and Claude working together.

The post should follow this exact structure:
_One-line summary of the session._

## What we worked on

Brief description of the issue or feature tackled.

## What we built

- Key change one (be specific)
- Key change two
- Key change three

## What we broke / what was tricky

Honest note about obstacles, wrong turns, or surprising complexity. If nothing broke, write something like "Smooth session — no major obstacles."

## What we learned

An insight worth capturing — about the codebase, the tools, or the AI-assisted workflow.

## Next up

What's logically next based on what we just built.

Keep it concise and honest. No marketing language. Write as if explaining to a fellow developer reading your dev diary. The one-line summary at the top is in italics (wrapped in _underscores_).`;

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
  const userMessage = `Write an AI dev blog post about today's session.
${context ? `Context from the developer: ${context}` : 'No specific context provided — generate a plausible draft based on common portfolio site development tasks.'}

Return ONLY the blog post content — start with the italic one-line summary, then the sections. Do not include a title heading like "# Title" at the top. The first line is the italicized summary.

For the post title (a separate field in the form), suggest: "Day N — [short description]" where N is a reasonable session number.

Format your response as:
TITLE: <suggested title here>
---
<blog post body starting with _italic summary_>`;

  // ── Helper: parse TITLE / body from raw LLM response
  function parseResponse(raw) {
    const separatorIdx = raw.indexOf('\n---\n');
    let title         = '';
    let body_markdown = raw.trim();
    if (separatorIdx !== -1) {
      const titleLine = raw.slice(0, separatorIdx).trim();
      title           = titleLine.startsWith('TITLE:') ? titleLine.slice(6).trim() : titleLine;
      body_markdown   = raw.slice(separatorIdx + 5).trim();
    }
    return { title, body_markdown };
  }

  // ── Priority 1: Ollama
  const ollamaHost = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
  const ollamaModel = process.env.OLLAMA_MODEL || 'tinyllama';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 150_000);
    let ollamaRes;
    try {
      ollamaRes = await fetch(`${ollamaHost}/api/chat`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          model:    ollamaModel,
          stream:   false,
          messages: [
            { role: 'system', content: AI_GENERATE_SYSTEM_PROMPT },
            { role: 'user',   content: userMessage },
          ],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!ollamaRes.ok) {
      const errBody = await ollamaRes.text().catch(() => '');
      logger.warn({ status: ollamaRes.status, body: errBody }, '[ai-blog-generate] Ollama unavailable, trying Anthropic fallback');
    } else {
      const data = await ollamaRes.json();
      const raw  = data?.message?.content || '';
      const { title, body_markdown } = parseResponse(raw);
      logger.info({ provider: 'ollama', model: ollamaModel, context: context || null, titleExtracted: !!title }, '[ai-blog-generate] Draft generated successfully');
      return res.json({ title, body_markdown });
    }
  } catch (err) {
    logger.warn({ err: err.message }, '[ai-blog-generate] Ollama unavailable, trying Anthropic fallback');
  }

  // ── Priority 2: Anthropic API fallback
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'No AI provider available. Ollama is not running or Anthropic API key is not set.' });
  }

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     AI_GENERATE_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userMessage }],
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text().catch(() => '');
      logger.error({ status: apiRes.status, body: errBody }, '[ai-blog-generate] Anthropic API error');
      return res.status(502).json({ error: 'AI generation failed — upstream API error.' });
    }

    const apiData = await apiRes.json();
    const raw = apiData?.content?.[0]?.text || '';
    const { title, body_markdown } = parseResponse(raw);
    logger.info({ provider: 'anthropic', context: context || null, titleExtracted: !!title }, '[ai-blog-generate] Draft generated successfully');
    res.json({ title, body_markdown });
  } catch (err) {
    logger.error({ err }, '[ai-blog-generate] Fetch to Anthropic API failed');
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
