/**
 * Unit tests for backend/scheduler.js (#500).
 *
 * These tests verify the cron wiring logic without touching the DB or
 * making real AI provider calls. node-cron and the generation utility
 * are mocked via vi.mock().
 *
 * Coverage:
 *   - No-op when AI_BLOG_SCHEDULE is absent or empty
 *   - Job is registered for a valid cron expression
 *   - Invalid cron expressions are logged and skipped (no crash)
 *   - A tick: success path saves draft; error path logs without crashing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Capture the scheduled callback so we can invoke it manually in tick tests.
let capturedCallback = null;

vi.mock('node-cron', () => ({
  default: {
    validate: vi.fn((expr) => /^[\d*,\-/]+ [\d*,\-/]+ [\d*,\-/]+ [\d*,\-/]+ [\d*,\-/]+$/.test(expr.trim())),
    schedule: vi.fn((expr, cb) => {
      capturedCallback = cb;
      return { stop: vi.fn() };
    }),
  },
}));

vi.mock('../../utils/aiGenerate.js', () => ({
  generateAiBlogPost: vi.fn(),
}));

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../../utils/slugify.js', () => ({
  slugify:        vi.fn((s) => s.toLowerCase().replace(/\s+/g, '-')),
  findUniqueSlug: vi.fn((pool, slug) => Promise.resolve(slug)),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function importFresh() {
  vi.resetModules();
  const mod = await import('../../scheduler.js');
  return mod.startScheduler;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('startScheduler', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv      = process.env.AI_BLOG_SCHEDULE;
    capturedCallback = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AI_BLOG_SCHEDULE;
    } else {
      process.env.AI_BLOG_SCHEDULE = originalEnv;
    }
    vi.resetModules();
  });

  // ── No-op cases ─────────────────────────────────────────────────────────────

  it('returns null and does not schedule when AI_BLOG_SCHEDULE is not set', async () => {
    delete process.env.AI_BLOG_SCHEDULE;
    const startScheduler = await importFresh();
    const { default: cron } = await import('node-cron');

    const result = startScheduler();

    expect(result).toBeNull();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it('returns null and does not schedule when AI_BLOG_SCHEDULE is empty string', async () => {
    process.env.AI_BLOG_SCHEDULE = '';
    const startScheduler = await importFresh();
    const { default: cron } = await import('node-cron');

    const result = startScheduler();

    expect(result).toBeNull();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it('returns null and does not schedule when AI_BLOG_SCHEDULE is whitespace', async () => {
    process.env.AI_BLOG_SCHEDULE = '   ';
    const startScheduler = await importFresh();
    const { default: cron } = await import('node-cron');

    const result = startScheduler();

    expect(result).toBeNull();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  // ── Valid schedule ───────────────────────────────────────────────────────────

  it('registers a cron job and returns the task for a valid expression', async () => {
    process.env.AI_BLOG_SCHEDULE = '0 2 * * 1';
    const startScheduler = await importFresh();
    const { default: cron } = await import('node-cron');

    const result = startScheduler();

    expect(cron.validate).toHaveBeenCalledWith('0 2 * * 1');
    expect(cron.schedule).toHaveBeenCalledWith('0 2 * * 1', expect.any(Function));
    expect(result).not.toBeNull();
    expect(typeof result.stop).toBe('function');
  });

  // ── Invalid expression ───────────────────────────────────────────────────────

  it('returns null and logs an error for an invalid cron expression', async () => {
    process.env.AI_BLOG_SCHEDULE = 'not-a-cron';
    const startScheduler = await importFresh();
    const { default: cron } = await import('node-cron');
    const { logger } = await import('../../utils/logger.js');

    const result = startScheduler();

    expect(result).toBeNull();
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: 'not-a-cron' }),
      expect.stringContaining('[scheduler/ai-blog]'),
    );
  });

  // ── Tick: success ────────────────────────────────────────────────────────────

  it('saves a draft on a successful tick', async () => {
    process.env.AI_BLOG_SCHEDULE = '0 2 * * 1';
    const startScheduler = await importFresh();
    const { generateAiBlogPost } = await import('../../utils/aiGenerate.js');
    const { pool } = await import('../../db/pool.js');
    const { logger } = await import('../../utils/logger.js');

    generateAiBlogPost.mockResolvedValueOnce({
      title:         'Day 42 — Scheduler wiring',
      body_markdown: '_We wired up the cron job._\n\n## What we worked on\n...',
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 99, title: 'Day 42 — Scheduler wiring', slug: 'day-42-scheduler-wiring' }],
    });

    startScheduler();
    expect(capturedCallback).toBeTypeOf('function');

    await capturedCallback();

    expect(generateAiBlogPost).toHaveBeenCalledWith(null, 'scheduler');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO posts'),
      expect.arrayContaining(['ai-blog', 'Day 42 — Scheduler wiring', expect.any(String)]),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 99 }),
      expect.stringContaining('[scheduler/ai-blog]'),
    );
  });

  // ── Tick: error ──────────────────────────────────────────────────────────────

  it('logs an error and does not throw when generation fails on a tick', async () => {
    process.env.AI_BLOG_SCHEDULE = '0 2 * * 1';
    const startScheduler = await importFresh();
    const { generateAiBlogPost } = await import('../../utils/aiGenerate.js');
    const { logger } = await import('../../utils/logger.js');

    generateAiBlogPost.mockRejectedValueOnce(new Error('No AI provider available'));

    startScheduler();
    expect(capturedCallback).toBeTypeOf('function');

    // Must not throw
    await expect(capturedCallback()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'No AI provider available' }),
      expect.stringContaining('[scheduler/ai-blog]'),
    );
  });
});
