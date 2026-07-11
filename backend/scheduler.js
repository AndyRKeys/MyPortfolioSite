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

import { execFileSync }        from 'child_process';
import cron from 'node-cron';
import { pool }                from './db/pool.js';
import { logger }              from './utils/logger.js';
import { generateAiBlogPost }  from './utils/aiGenerate.js';
import { slugify, findUniqueSlug } from './utils/slugify.js';

// ── Activity context ──────────────────────────────────────────────────────────

/**
 * Collect today's git commits and merged GitHub PRs.
 * Returns a formatted context string, or null if there was no activity.
 * Failures are non-fatal: log a warning and return null so generation still
 * has the option to fall back to a generic draft.
 */
async function buildDailyContext() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Today's commits (since midnight UTC)
  let commits = '';
  try {
    commits = execFileSync('git', ['log', '--oneline', '--since=midnight', '--format=%h %s'], {
      encoding: 'utf8',
      timeout: 10_000,
      cwd: process.env.REPO_DIR || '/repo',
    }).trim();
  } catch (err) {
    logger.warn({ err: err.message }, '[scheduler/ai-blog] git log failed — skipping commit context');
  }

  // PRs merged today via GitHub API
  let mergedPrs = [];
  try {
    const token   = process.env.GITHUB_TOKEN;
    const headers = { 'User-Agent': 'MyPortfolioSite-scheduler', Accept: 'application/vnd.github+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const url  = 'https://api.github.com/repos/AndyRKeys/MyPortfolioSite/pulls?state=closed&sort=updated&direction=desc&per_page=30';
    const res  = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const prs = await res.json();
      mergedPrs = prs.filter(pr => pr.merged_at && pr.merged_at.startsWith(today))
                     .map(pr => `#${pr.number}: ${pr.title}`);
    } else {
      logger.warn({ status: res.status }, '[scheduler/ai-blog] GitHub API non-OK — skipping PR context');
    }
  } catch (err) {
    logger.warn({ err: err.message }, '[scheduler/ai-blog] GitHub API call failed — skipping PR context');
  }

  const commitCount = commits ? commits.split('\n').length : 0;
  const prCount     = mergedPrs.length;

  logger.debug({ commitCount, prCount, today }, '[scheduler/ai-blog] Daily activity context built');

  if (!commits && prCount === 0) return null;

  const parts = [];
  if (commits)      parts.push(`Today's commits:\n${commits}`);
  if (prCount > 0)  parts.push(`Merged PRs today:\n${mergedPrs.join('\n')}`);
  return parts.join('\n\n');
}

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
      const context = await buildDailyContext();
      if (!context) {
        logger.info('[scheduler/ai-blog] No git or PR activity today — skipping draft generation');
        return;
      }
      let { title, body_markdown } = await generateAiBlogPost(context, 'scheduler');
      if (!title) {
        // Model didn't return a TITLE: line — derive from first commit subject.
        const firstCommit = context.match(/^[a-f0-9]+ (.+)$/m);
        const subject     = firstCommit
          ? firstCommit[1].replace(/^(feat|fix|refactor|chore|docs|test|style)(\([^)]+\))?:\s*/i, '')
          : null;
        title = subject
          ? `Dev Session — ${subject.slice(0, 60)}`
          : `Dev Session — ${new Date().toISOString().split('T')[0]}`;
        logger.info({ title }, '[scheduler/ai-blog] Model did not return a title — derived fallback from commit context');
      }
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
