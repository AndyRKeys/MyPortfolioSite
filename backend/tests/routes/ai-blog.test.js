/**
 * AI dev blog route integration tests.
 * Verifies validation, auth guards, and happy-path DB operations
 * for the /ai-blog endpoints, mirroring the pattern in posts.test.js.
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

describe('GET /ai-blog', () => {
  // Public routes (no JWT) go through the rate-limiter's PostgresStore which
  // makes one DB call (increment). The store fails open when rows are empty,
  // so an extra mock is needed before the actual handler data mock.
  it('returns an empty array when no entries exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // rate-limiter increment (fails open)
    const res = await request(app).get('/ai-blog');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns published ai-blog entries', async () => {
    const fakeEntry = {
      id: 'entry-1', title: 'Day 1', slug: 'day-1',
      post_date: '2026-07-01', published_at: '2026-07-01T10:00:00Z',
      excerpt: 'We started the AI Dev Blog feature.',
    };
    mockQuery.mockResolvedValueOnce({ rows: [] });           // rate-limiter increment (fails open)
    mockQuery.mockResolvedValueOnce({ rows: [fakeEntry] });  // handler SELECT
    const res = await request(app).get('/ai-blog');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Day 1');
  });
});

describe('GET /ai-blog/all', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(app).get('/ai-blog/all');
    expect(res.status).toBe(401);
  });

  it('returns all entries (including drafts) when authenticated', async () => {
    // Authenticated requests (valid JWT) are skipped by exemptIfTrusted — no rate-limit query.
    // resolveUser and authenticate are JWT-only — no DB queries.
    // Only the handler's SELECT consumes a mock.
    const fakeEntries = [
      { id: 'e1', title: 'Day 2', published_at: null },
      { id: 'e2', title: 'Day 1', published_at: '2026-07-01T10:00:00Z' },
    ];
    mockQuery.mockResolvedValueOnce({ rows: fakeEntries }); // handler SELECT
    const res = await request(app)
      .get('/ai-blog/all')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe('POST /ai-blog', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(app).post('/ai-blog').send({ title: 'Test' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when title is missing (DB not touched)', async () => {
    const res = await request(app)
      .post('/ai-blog')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ body_markdown: '# No title here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('calls INSERT and returns 201 for a valid ai-blog entry', async () => {
    const fakeEntry = {
      id: 'abc-456', title: 'Day 1 — AI Dev Blog', slug: 'day-1-ai-dev-blog',
      body_markdown: '# Day 1', post_type: 'ai-blog', published_at: null,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [] })           // slug uniqueness check
      .mockResolvedValueOnce({ rows: [fakeEntry] }); // INSERT RETURNING

    const res = await request(app)
      .post('/ai-blog')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Day 1 — AI Dev Blog', body_markdown: '# Day 1' });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('day-1-ai-dev-blog');
    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO posts'));
    expect(insertCall).toBeDefined();
    // Verify the post_type is ai-blog, not blog
    expect(insertCall[1]).toContain('ai-blog');
  });
});

describe('PUT /ai-blog/:id', () => {
  it('returns 401 when no JWT provided', async () => {
    const res = await request(app).put('/ai-blog/some-id').send({ title: 'Updated' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app)
      .put('/ai-blog/some-id')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ body_markdown: '# No title' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });

  it('returns 404 when entry does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT existing → empty
    const res = await request(app)
      .put('/ai-blog/nonexistent-id')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Updated Title', body_markdown: '# Updated' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /ai-blog/:id', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).delete('/ai-blog/some-id');
    expect(res.status).toBe(401);
  });

  it('returns 404 when entry does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .delete('/ai-blog/nonexistent-id')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });

  it('deletes the entry and returns { deleted: true }', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc', title: 'Day 1' }] });
    const res = await request(app)
      .delete('/ai-blog/abc')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

describe('GET /ai-blog/:slug', () => {
  it('returns 404 for an unknown slug', async () => {
    // rate-limiter increment (fails open) then handler SELECT returns empty → 404
    mockQuery.mockResolvedValueOnce({ rows: [] }); // rate-limiter increment
    mockQuery.mockResolvedValueOnce({ rows: [] }); // handler SELECT → 404
    const res = await request(app).get('/ai-blog/not-a-real-slug');
    expect(res.status).toBe(404);
  });

  it('returns a published entry by slug', async () => {
    const fakeEntry = {
      id: 'e1', title: 'Day 1', slug: 'day-1',
      body_markdown: '# Day 1', published_at: '2026-07-01T10:00:00Z',
    };
    // Public route: rate-limiter increment (fails open) + handler SELECT
    mockQuery.mockResolvedValueOnce({ rows: [] });           // rate-limiter increment
    mockQuery.mockResolvedValueOnce({ rows: [fakeEntry] });  // handler SELECT
    const res = await request(app).get('/ai-blog/day-1');
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Day 1');
  });
});
