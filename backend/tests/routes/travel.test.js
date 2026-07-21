/**
 * Priority 2 — travel route integration tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt      from 'jsonwebtoken';
import { createApp } from '../../app.js';

// vi.mock is hoisted above imports — use vi.hoisted so mockClient is available
// inside the factory without triggering "Cannot access before initialisation".
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

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-32';

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  mockClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockClient.release.mockReset();
});

describe('POST /travel', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).post('/travel').send({ title: 'Paris' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app)
      .post('/travel')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ post_date: '2026-04-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });
});

describe('PUT /travel/:id', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).put('/travel/some-id').send({ title: 'Paris' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when post_date format is invalid', async () => {
    const res = await request(app)
      .put('/travel/some-id')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Paris', post_date: '01-04-2026' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/i);
  });

  // #522 H2 — the 404 early-return previously skipped ROLLBACK, releasing the
  // client to the pool with an open transaction.
  it('rolls back the transaction before returning 404 for a missing memory', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT existing → not found

    const res = await request(app)
      .put('/travel/nonexistent-id')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Paris', post_date: '2026-07-04' });

    expect(res.status).toBe(404);
    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('preserves full_url and thumb_url for already-processed media on edit', async () => {
    const { pool } = await import('../../db/pool.js');

    const mockClient = { query: vi.fn(), release: vi.fn() };
    pool.connect.mockResolvedValueOnce(mockClient);

    // client.query call sequence inside PUT /:id handler:
    // 1. BEGIN
    // 2. SELECT existing post
    // 3. UPDATE posts
    // 4. replaceMedia — SELECT post_media (return ready row)
    // 5. replaceMedia — DELETE post_media
    // 6. replaceMedia — INSERT post_media
    // 7. COMMIT
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                                          // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'post-1', published_at: null }] })      // SELECT post
      .mockResolvedValueOnce({ rows: [] })                                          // UPDATE posts
      .mockResolvedValueOnce({ rows: [{                                             // SELECT post_media
        media_url:    '/uploads/original/photo.jpg',
        full_url:     '/uploads/full/photo.webp',
        thumb_url:    '/uploads/thumb/photo.webp',
        media_status: 'ready',
      }] })
      .mockResolvedValueOnce({ rows: [] })  // DELETE
      .mockResolvedValueOnce({ rows: [] })  // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    pool.query.mockResolvedValueOnce({ rows: [{ id: 'post-1', title: 'Test' }] }); // post-save SELECT

    await request(app)
      .put('/travel/post-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        title:       'Test',
        post_date:   '2026-07-04',
        media_items: [{ url: '/uploads/original/photo.jpg', type: 'image/jpeg' }],
      });

    const insertCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO post_media'),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall[1];
    expect(params).toContain('/uploads/full/photo.webp');   // full_url carried forward
    expect(params).toContain('/uploads/thumb/photo.webp');  // thumb_url carried forward
    expect(params).toContain('ready');                      // status carried forward
  });
});

// ── DELETE /travel/:id/media/:mediaId ─────────────────────────────────────────
// #522 L11 — media delete must run in a transaction (DELETE + posts.media_url
// sync are atomic) and write an audit_log row like every other travel mutation.

describe('DELETE /travel/:id/media/:mediaId', () => {
  it('runs in a transaction and writes an audit row', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockClear();
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })                                     // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'm2', media_url: '/u/b.jpg' }] }) // DELETE RETURNING
      .mockResolvedValueOnce({ rows: [{ media_url: '/u/a.jpg', media_type: 'image/jpeg' }] }) // SELECT first
      .mockResolvedValueOnce({ rows: [] })                                     // UPDATE posts
      .mockResolvedValueOnce({ rows: [] });                                    // COMMIT

    const res = await request(app)
      .delete('/travel/post-1/media/m2')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    const auditCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO audit_log'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[1]).toContain('travel.media_delete');
  });

  it('rolls back and returns 404 when the media item is missing', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // DELETE → nothing deleted

    const res = await request(app)
      .delete('/travel/post-1/media/nope')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });
});

// ── POST /travel/import ───────────────────────────────────────────────────────

const VALID_CSV = 'title,location,notes,post_date,lat,lng,publish\n' +
  '"Paris trip","Paris, France","Great city",2024-06-15,48.8566,2.3522,false\n';

describe('POST /travel/import — auth', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app)
      .post('/travel/import')
      .attach('file', Buffer.from(VALID_CSV), { filename: 'travel.csv', contentType: 'text/csv' });
    expect(res.status).toBe(401);
  });
});

describe('POST /travel/import — file validation', () => {
  it('returns 400 when no file is sent', async () => {
    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no csv file/i);
  });

  it('returns 400 for a non-CSV file (by extension)', async () => {
    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from('hello'), { filename: 'data.txt', contentType: 'text/plain' });
    // multer fileFilter rejects non-.csv, wrapMulter turns it into 400
    expect(res.status).toBe(400);
  });

  it('returns 400 if the CSV has no title column', async () => {
    const csv = 'location,notes\n"Paris","Nice"\n';
    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(csv), { filename: 'bad.csv', contentType: 'text/csv' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    expect(res.body.expected).toBe('title,location,notes,post_date,lat,lng,publish');
  });
});

describe('POST /travel/import — row handling', () => {
  it('imports a valid CSV row and returns imported count', async () => {
    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(VALID_CSV), { filename: 'travel.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toHaveLength(0);
  });

  it('skips a row with a missing title and records the error', async () => {
    const csv = 'title,location\n"Valid title","Paris"\n,"Missing title row"\n';
    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(csv), { filename: 'travel.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.errors[0].reason).toMatch(/title is required/i);
  });

  it('skips a row with an invalid post_date format', async () => {
    const csv = 'title,post_date\n"Good row",2024-06-15\n"Bad date",not-a-date\n';
    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(csv), { filename: 'travel.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.errors[0].reason).toMatch(/YYYY-MM-DD/);
  });

  it('accepts DD/MM/YYYY dates and normalises them to YYYY-MM-DD', async () => {
    const csv = 'title,post_date\n"Excel date",15/06/2024\n';
    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(csv), { filename: 'travel.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(0);
  });

  it('imports an empty CSV (header only) without error', async () => {
    const csv = 'title,location,post_date\n';
    const res = await request(app)
      .post('/travel/import')
      .set('Authorization', `Bearer ${makeToken()}`)
      .attach('file', Buffer.from(csv), { filename: 'travel.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(0);
  });
});
