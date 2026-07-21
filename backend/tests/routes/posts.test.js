/**
 * Priority 2 — posts route integration tests.
 * Verifies validation rejects bad input before the DB is touched,
 * that protected routes return 401 without a valid JWT,
 * and happy-path DB writes for create/update/delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request   from 'supertest';
import jwt        from 'jsonwebtoken';
import { createApp } from '../../app.js';

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  pool: { query: mockQuery },
}));

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('POST /posts', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(app).post('/posts').send({ title: 'Test' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when JWT is invalid', async () => {
    const res = await request(app)
      .post('/posts')
      .set('Authorization', 'Bearer bad.token.here')
      .send({ title: 'Test' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when title is missing (DB not touched)', async () => {
    const res = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ body_markdown: '# No title here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('calls INSERT and returns 201 for a valid blog post', async () => {
    const fakePost = {
      id: 'abc-123', title: 'Hello World', slug: 'hello-world',
      body_markdown: '# Hello', post_type: 'blog', published_at: null,
    };
    // tryInsertPost does a slug check then INSERT RETURNING
    mockQuery
      .mockResolvedValueOnce({ rows: [] })   // slug uniqueness check
      .mockResolvedValueOnce({ rows: [fakePost] }); // INSERT RETURNING

    const res = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Hello World', body_markdown: '# Hello' });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('hello-world');
    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO posts'));
    expect(insertCall).toBeDefined();
  });
});

describe('PUT /posts/:id', () => {
  it('returns 401 when no JWT provided', async () => {
    const res = await request(app).put('/posts/some-id').send({ title: 'Updated' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app)
      .put('/posts/some-id')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ body_markdown: '# No title' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });

  it('returns 404 when post does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT existing post → empty
    const res = await request(app)
      .put('/posts/nonexistent-id')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Updated Title', body_markdown: '# Updated' });
    expect(res.status).toBe(404);
  });

  // #522 H1 — togglePublish sends a partial PUT without body_markdown;
  // the UPDATE must COALESCE to the stored body instead of wiping it.
  it('preserves stored body_markdown when the field is omitted (publish toggle)', async () => {
    const existing = {
      id: 'abc', title: 'Hello', slug: 'hello',
      body_markdown: '# Full body', post_date: null, published_at: null,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [existing] })                                     // SELECT existing
      .mockResolvedValueOnce({ rows: [{ ...existing, published_at: new Date() }] })    // UPDATE RETURNING
      .mockResolvedValue({ rows: [] });                                                // audit insert

    const res = await request(app)
      .put('/posts/abc')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Hello', publish: true }); // no body_markdown — togglePublish shape

    expect(res.status).toBe(200);
    const updateCall = mockQuery.mock.calls.find(([sql]) => sql.includes('UPDATE posts'));
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toMatch(/COALESCE\(\$3, body_markdown\)/);
    expect(updateCall[1][2]).toBeNull(); // null param → COALESCE keeps stored body
  });

  it('still overwrites body_markdown when explicitly provided', async () => {
    const existing = {
      id: 'abc', title: 'Hello', slug: 'hello',
      body_markdown: '# Old body', post_date: null, published_at: null,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [{ ...existing, body_markdown: '# New body' }] })
      .mockResolvedValue({ rows: [] });

    const res = await request(app)
      .put('/posts/abc')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Hello', body_markdown: '# New body' });

    expect(res.status).toBe(200);
    const updateCall = mockQuery.mock.calls.find(([sql]) => sql.includes('UPDATE posts'));
    expect(updateCall[1][2]).toBe('# New body');
  });
});

describe('DELETE /posts/:id', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).delete('/posts/some-id');
    expect(res.status).toBe(401);
  });

  it('returns 404 when post does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .delete('/posts/nonexistent-id')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });

  it('deletes the post and returns { deleted: true }', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc' }] });
    const res = await request(app)
      .delete('/posts/abc')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});
