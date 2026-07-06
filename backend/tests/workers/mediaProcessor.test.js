import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize:  vi.fn().mockReturnThis(),
    webp:    vi.fn().mockReturnThis(),
    toFile:  vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd, _args, cb) => cb(null, '', '')),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mkdirSync: vi.fn() };
});

process.env.JWT_SECRET   = 'test-secret-test-secret-test-secret-32';
process.env.UPLOADS_DIR  = '/tmp/test-uploads';

// ── Import under test ────────────────────────────────────────────────────────

const { processJob, registerMediaWorker } = await import('../../workers/mediaProcessor.js');
const { pool }       = await import('../../db/pool.js');
const sharp          = (await import('sharp')).default;
const { execFile }   = await import('child_process');

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [] });
});

// ── Image processing ─────────────────────────────────────────────────────────

describe('processJob — image', () => {
  const imageJob = {
    data: { filePath: '/tmp/test-uploads/original/test.jpg', mimeType: 'image/jpeg' },
  };

  it('calls sharp twice (full + thumb)', async () => {
    await processJob(imageJob);
    expect(sharp).toHaveBeenCalledTimes(2);
  });

  it('updates both posts and post_media with full_url, thumb_url, and ready status', async () => {
    await processJob(imageJob);
    const calls = pool.query.mock.calls;
    const updateCalls = calls.filter(c => String(c[0]).includes('full_url'));
    expect(updateCalls.length).toBe(2); // posts + post_media
    updateCalls.forEach(([_sql, params]) => {
      expect(params[0]).toMatch(/^\/uploads\/full\//);
      expect(params[1]).toMatch(/^\/uploads\/thumb\//);
      expect(params[2]).toBe('ready');
    });
  });

  it('does not call ffmpeg for images', async () => {
    await processJob(imageJob);
    expect(execFile).not.toHaveBeenCalled();
  });
});

// ── Video processing ─────────────────────────────────────────────────────────

describe('processJob — video', () => {
  const videoJob = {
    data: { filePath: '/tmp/test-uploads/original/clip.mp4', mimeType: 'video/mp4' },
  };

  it('calls ffmpeg to extract a frame', async () => {
    await processJob(videoJob);
    expect(execFile).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-ss', '1', '-vframes', '1']),
      expect.any(Function),
    );
  });

  it('does not call sharp for video', async () => {
    await processJob(videoJob);
    expect(sharp).not.toHaveBeenCalled();
  });

  it('sets thumb_url but leaves full_url null in DB', async () => {
    await processJob(videoJob);
    const calls = pool.query.mock.calls;
    const updateCalls = calls.filter(c => String(c[0]).includes('thumb_url'));
    expect(updateCalls.length).toBe(2);
    updateCalls.forEach(([_sql, params]) => {
      expect(params[0]).toBeNull();                    // full_url
      expect(params[1]).toMatch(/^\/uploads\/thumb\//); // thumb_url
      expect(params[2]).toBe('ready');
    });
  });
});

// ── Worker registration (pg-boss v10 batch handling) ─────────────────────────

describe('registerMediaWorker', () => {
  it('creates the queue then registers a worker', async () => {
    const boss = { createQueue: vi.fn().mockResolvedValue(), work: vi.fn().mockResolvedValue() };
    await registerMediaWorker(boss);
    expect(boss.createQueue).toHaveBeenCalled();
    expect(boss.work).toHaveBeenCalled();
    // createQueue must run before work (queue must exist before subscribing)
    expect(boss.createQueue.mock.invocationCallOrder[0])
      .toBeLessThan(boss.work.mock.invocationCallOrder[0]);
  });

  it('unwraps the pg-boss v10 job batch (array) before processing', async () => {
    let handler;
    const boss = {
      createQueue: vi.fn().mockResolvedValue(),
      work: vi.fn((_name, _opts, cb) => { handler = cb; return Promise.resolve(); }),
    };
    await registerMediaWorker(boss);

    // pg-boss v10 hands the callback an ARRAY of jobs — this is the regression
    // that broke every upload with "Cannot destructure property 'filePath'".
    await handler([
      { data: { filePath: '/tmp/test-uploads/original/a.jpg', mimeType: 'image/jpeg' } },
    ]);

    // Two sharp calls (full + thumb) prove the single job inside the batch was processed.
    expect(sharp).toHaveBeenCalledTimes(2);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('processJob — error handling', () => {
  it('sets media_status to error when sharp throws', async () => {
    sharp.mockImplementationOnce(() => ({
      resize: vi.fn().mockReturnThis(),
      webp:   vi.fn().mockReturnThis(),
      toFile: vi.fn().mockRejectedValue(new Error('sharp failed')),
    }));

    await expect(processJob({
      data: { filePath: '/tmp/test-uploads/original/bad.jpg', mimeType: 'image/jpeg' },
    })).rejects.toThrow('sharp failed');

    const errorCalls = pool.query.mock.calls.filter(c => c[1] && c[1][2] === 'error');
    expect(errorCalls.length).toBeGreaterThan(0);
  });
});
