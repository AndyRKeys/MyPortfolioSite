/**
 * Tests for POST /travel/:id/photos/bulk (#511)
 * Covers auth gate, file validation, happy path, and 404 for unknown memory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt      from 'jsonwebtoken';
import { createApp } from '../../app.js';

// Hoist mockClient so it is available inside the vi.mock factory below.
const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    query:   vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return { mockClient };
});

vi.mock('../../db/pool.js', () => ({
  pool: {
    query:   vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue(mockClient),
  },
}));

// Mock boss so the route can enqueue jobs without a real pg-boss instance.
vi.mock('../../utils/boss.js', () => ({
  getBoss: vi.fn(() => ({
    send: vi.fn().mockResolvedValue('job-id'),
  })),
}));

// Stub multer diskStorage so tests don't write real files.
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

// Minimal valid JPEG buffer (same fixture as upload.test.js)
const smallJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U' +
  'HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN' +
  'DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUE/8QAIBAAAg' +
  'ICAgMAAAAAAAAAAAAAAQIDBAUREiFBUf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEA' +
  'AAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABRQAUUAf//Z',
  'base64',
);

beforeEach(async () => {
  const { pool } = await import('../../db/pool.js');
  pool.query.mockReset().mockResolvedValue({ rows: [] });
  mockClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockClient.release.mockReset();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('POST /travel/:id/photos/bulk — auth', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app)
      .post('/travel/123/photos/bulk')
      .attach('photos', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });

  it('returns 401 with an invalid JWT', async () => {
    const res = await request(app)
      .post('/travel/123/photos/bulk')
      .set('Authorization', 'Bearer bad.token')
      .attach('photos', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });
});

// ── File validation ───────────────────────────────────────────────────────────

describe('POST /travel/:id/photos/bulk — file validation', () => {
  it('returns 400 when no files are sent', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({ rows: [{ id: '1' }] }); // memory exists check (won't be reached)

    const res = await request(app)
      .post('/travel/123/photos/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no files/i);
  });

  it('returns 400 when a file has a disallowed MIME type', async () => {
    const res = await request(app)
      .post('/travel/123/photos/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', Buffer.from('hello'), { filename: 'doc.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
  });
});

// ── 404 for unknown memory ────────────────────────────────────────────────────

describe('POST /travel/:id/photos/bulk — memory not found', () => {
  it('returns 404 when the travel memory does not exist', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({ rows: [] }); // memory check returns nothing

    const res = await request(app)
      .post('/travel/nonexistent/photos/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/memory not found/i);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('POST /travel/:id/photos/bulk — happy path', () => {
  it('returns uploaded array with one entry for a single valid file', async () => {
    const { pool } = await import('../../db/pool.js');

    // Call sequence: memory check → order_index query → INSERT post_media → UPDATE posts primary media → logAudit pool.query
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'post-1' }] })      // memory exists
      .mockResolvedValueOnce({ rows: [{ max_idx: -1 }] })        // order_index
      .mockResolvedValueOnce({ rows: [] })                        // INSERT post_media
      .mockResolvedValueOnce({ rows: [] })                        // UPDATE posts primary media
      .mockResolvedValueOnce({ rows: [] });                       // logAudit INSERT

    const res = await request(app)
      .post('/travel/post-1/photos/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.uploaded)).toBe(true);
    expect(res.body.uploaded).toHaveLength(1);
    expect(res.body.uploaded[0].url).toMatch(/^\/uploads\/original\//);
    expect(res.body.uploaded[0].type).toBe('image/jpeg');
    expect(res.body.uploaded[0].status).toBe('pending');
    expect(res.body.errors).toHaveLength(0);
  });

  it('returns multiple uploaded entries for multiple valid files', async () => {
    const { pool } = await import('../../db/pool.js');

    // Two files: memory check, order_index, two INSERTs, UPDATE posts, logAudit
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'post-2' }] })  // memory exists
      .mockResolvedValueOnce({ rows: [{ max_idx: 0 }] })     // order_index
      .mockResolvedValueOnce({ rows: [] })                    // INSERT #1
      .mockResolvedValueOnce({ rows: [] })                    // INSERT #2
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE posts
      .mockResolvedValueOnce({ rows: [] });                   // logAudit

    const res = await request(app)
      .post('/travel/post-2/photos/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', smallJpeg, { filename: 'photo1.jpg', contentType: 'image/jpeg' })
      .attach('photos', smallJpeg, { filename: 'photo2.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.uploaded).toHaveLength(2);
    expect(res.body.errors).toHaveLength(0);
  });
});

// ── Partial success (DB-layer failure) ───────────────────────────────────────

describe("POST /travel/:id/photos/bulk — partial success", () => {
  it("returns partial success when one file inserts and one fails at the DB layer", async () => {
    const { pool } = await import('../../db/pool.js');

    // Call sequence: memory check → order_index → INSERT #1 (ok) → INSERT #2 (fail) → UPDATE posts primary media → logAudit
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'post-3' }] })  // memory exists
      .mockResolvedValueOnce({ rows: [{ max_idx: 0 }] })     // order_index
      .mockResolvedValueOnce({ rows: [] })                    // INSERT #1 succeeds
      .mockRejectedValueOnce(new Error('DB error'))           // INSERT #2 fails
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE posts primary media
      .mockResolvedValueOnce({ rows: [] });                   // logAudit

    const res = await request(app)
      .post('/travel/post-3/photos/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('photos', smallJpeg, { filename: 'photo1.jpg', contentType: 'image/jpeg' })
      .attach('photos', smallJpeg, { filename: 'photo2.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.uploaded).toHaveLength(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].error).toMatch(/DB error/i);
  });
});
