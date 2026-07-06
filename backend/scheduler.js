/**
 * Cron-based scheduler for automated AI blog draft generation (#500).
 *
 * Reads AI_BLOG_SCHEDULE (node-cron expression) from the environment.
 * When set and valid, registers a job that runs generateAiBlogPost() and
 * persists the result as a draft (published_at = NULL — never auto-published).
 *
 * If AI_BLOG_SCHEDULE is absent, empty, or an invalid cron expression,
 * startup continues normally and no job is registered.
 *
 * Log prefix: [scheduler/ai-blog]
 */

import cron from 'node-cron';
import { pool }                from './db/pool.js';
import { logger }              from './utils/logger.js';
import { generateAiBlogPost }  from './utils/aiGenerate.js';
import { slugify, findUniqueSlug } from './utils/slugify.js';

// ── Internal helper ───────────────────────────────────────────────────────────

/**
 * Insert a new AI blog post draft (published_at = null) into the DB.
 * Used only by the scheduler — the route handles its own persistence
 * through the admin UI after the user reviews the generated draft.
 */
async function saveDraft(title, body_markdown) {
  const today  = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const slug   = await findUniqueSlug(pool, slugify(title || 'untitled-draft'));
  const result = await pool.query(
    `INSERT INTO posts (post_type, title, slug, body_markdown, post_date, published_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, slug`,
    ['ai-blog', (title || 'Untitled Draft').trim(), slug, body_markdown || '', today, null],
  );
  return result.rows[0];
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Register the AI blog draft generation cron job.
 *
 * @returns {cron.ScheduledTask|null}  The registered task, or null if disabled.
 */
export function startScheduler() {
  const schedule = process.env.AI_BLOG_SCHEDULE;

  if (!schedule || !schedule.trim()) {
    logger.info('[scheduler/ai-blog] AI_BLOG_SCHEDULE not set — scheduled draft generation disabled');
    return null;
  }

  if (!cron.validate(schedule.trim())) {
    logger.error(
      { schedule },
      '[scheduler/ai-blog] Invalid cron expression — scheduled draft generation disabled. ' +
      'Check AI_BLOG_SCHEDULE in .env (example: "0 2 * * 1" for Monday 02:00).',
    );
    return null;
  }

  logger.info({ schedule }, '[scheduler/ai-blog] Scheduled AI blog draft generation registered');

  return cron.schedule(schedule.trim(), async () => {
    logger.info({ schedule }, '[scheduler/ai-blog] Scheduled generation tick fired');
    try {
      const { title, body_markdown } = await generateAiBlogPost(null, 'scheduler');
      const draft = await saveDraft(title, body_markdown);
      logger.info(
        { draftId: draft.id, title: draft.title, slug: draft.slug },
        '[scheduler/ai-blog] Draft saved successfully — review and publish via admin panel',
      );
    } catch (err) {
      logger.error(
        { err: err.message },
        '[scheduler/ai-blog] Scheduled generation failed — draft was not saved',
      );
    }
  });
}
