/**
 * Priority 2 — travel route integration tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt      from 'jsonwebtoken';
import { createApp } from '../../app.js';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn() },
}));

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

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

  it('preserves full_url and thumb_url for already-processed media on edit', async () => {
    const { pool } = await import('../../db/pool.js');

    const mockClient = { query: vi.fn(), release: vi.fn() };
    pool.connect.mockResolvedValue(mockClient);

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
