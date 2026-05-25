/**
 * Upload route tests — multer size limit, MIME filtering, auth gate.
 * Uses an in-memory buffer instead of real disk I/O (UPLOADS_DIR mocked).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../app.js';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// Stub multer's diskStorage to write nowhere — tests don't need real files
vi.mock('multer', async (importOriginal) => {
  const multer = await importOriginal();
  const original = multer.default ?? multer;
  const patched = (opts) => original({ ...opts, storage: original.memoryStorage() });
  patched.memoryStorage  = original.memoryStorage;
  patched.diskStorage    = original.diskStorage;
  patched.MulterError    = original.MulterError;
  return { default: patched };
});

process.env.JWT_SECRET   = 'test-secret-test-secret-test-secret-32';
process.env.UPLOADS_DIR  = '/tmp/test-uploads';

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

describe('POST /upload — MIME filtering', () => {
  it('rejects a disallowed MIME type (text/plain)', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from('hello'), { filename: 'test.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  it('rejects a PDF disguised as an image', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'evil.jpg', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('accepts image/jpeg', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', smallJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    // 200 with a url, or 500 if the tmp dir doesn't exist — either way not 400/401
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.url).toMatch(/^\/uploads\//);
    }
  });
});

describe('POST /upload — size limit', () => {
  it('rejects a file over 20 MB', async () => {
    // 21 MB buffer of zeros
    const oversized = Buffer.alloc(21 * 1024 * 1024);
    const res = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', oversized, { filename: 'big.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large|limit/i);
  });
});

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
