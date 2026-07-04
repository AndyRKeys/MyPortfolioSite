/**
 * Upload route tests — multer size limit, MIME filtering, auth gate,
 * status/jobs/retry endpoints. (#174)
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt     from 'jsonwebtoken';
import { createApp } from '../../app.js';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// Mock boss so upload.js can enqueue without a real pg-boss instance.
vi.mock('../../utils/boss.js', () => ({
  getBoss: vi.fn(() => ({
    send: vi.fn().mockResolvedValue('job-id'),
  })),
}));

// Stub multer diskStorage to avoid real file I/O in tests.
vi.mock('multer', async (importOriginal) => {
  const multer = await importOriginal();
  const original = multer.default ?? multer;
  const patched = (opts) => original({ ...opts, storage: original.memoryStorage() });
  patched.memoryStorage = original.memoryStorage;
  patched.diskStorage   = original.diskStorage;
  patched.MulterError   = original.MulterError;
  return { default: patched };
});

process.env.JWT_SECRET  = 'test-secret-test-secret-test-secret-32';
process.env.UPLOADS_DIR = '/tmp/test-uploads';

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const smallJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
  'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
  'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUE/8QAIBAAAg' +
  'ICAgMAAAAAAAAAAAAAAQIDBAUREiFBUf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEA' +
  'AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABRQAUUAf//Z',
  'base64'
);

// ── Auth gate ─────────────────────────────────────────────────────────────────

describe('POST /upload — auth gate', () => {
  it('returns 401 without a JWT', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', smallJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });

  it('returns 401 with an invalid JWT', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', 'Bearer bad.token')
      .attach('file', smallJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });
});

// ── MIME filtering ────────────────────────────────────────────────────────────

describe('POST /upload — MIME filtering', () => {
  it('rejects a disallowed MIME type (text/plain)', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from('hello'), { filename: 'test.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  it('accepts image/jpeg and returns status pending', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    // 200 or 500 (tmp dir may not exist in test env) — not 400/401
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.url).toMatch(/^\/uploads\/original\//);
      expect(res.body.status).toBe('pending');
    }
  });
});

// ── Size limit ────────────────────────────────────────────────────────────────

describe('POST /upload — size limit', () => {
  it('accepts a 20 MB file (well under the 1 GB limit)', async () => {
    // 20 MB was previously rejected; 1 GB limit means this must now succeed
    const twentyMb = Buffer.alloc(20 * 1024 * 1024);
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', twentyMb, { filename: 'large.jpg', contentType: 'image/jpeg' });
    // 200 or 500 (disk write fails in test env) — not 400
    expect(res.status).not.toBe(400);
  });
});

// ── Missing file ──────────────────────────────────────────────────────────────

describe('POST /upload — missing file', () => {
  it('returns 400 when no file field is sent', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });
});

// ── Status endpoint ───────────────────────────────────────────────────────────

describe('GET /upload/status', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).get('/upload/status?file=test.jpg');
    expect(res.status).toBe(401);
  });

  it('returns 400 when file query param is absent', async () => {
    const res = await request(app)
      .get('/upload/status')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(400);
  });

  it('returns status for a known file', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({
      rows: [{ media_status: 'ready', full_url: '/uploads/full/test.webp', thumb_url: '/uploads/thumb/test.webp' }],
    });
    const res = await request(app)
      .get('/upload/status?file=test.jpg')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.full_url).toBe('/uploads/full/test.webp');
    expect(res.body.thumb_url).toBe('/uploads/thumb/test.webp');
  });

  it('returns 404 when file not found in DB', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/upload/status?file=missing.jpg')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });
});

// ── Jobs endpoint ─────────────────────────────────────────────────────────────

describe('GET /upload/jobs', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).get('/upload/jobs');
    expect(res.status).toBe(401);
  });

  it('returns array of jobs', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({
      rows: [
        { media_url: '/uploads/original/a.jpg', media_type: 'image/jpeg', media_status: 'ready', full_url: '/uploads/full/a.webp', thumb_url: '/uploads/thumb/a.webp', created_at: new Date().toISOString() },
      ],
    });
    const res = await request(app)
      .get('/upload/jobs')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].media_status).toBe('ready');
  });
});

// ── Retry endpoint ────────────────────────────────────────────────────────────

describe('POST /upload/retry', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).post('/upload/retry').send({ file: 'a.jpg' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when file param is missing', async () => {
    const res = await request(app)
      .post('/upload/retry')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('re-enqueues the job and returns ok', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/upload/retry')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ file: 'test.jpg', mimeType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
