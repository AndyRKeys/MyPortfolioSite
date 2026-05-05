/**
 * Priority 2 — posts route integration tests.
 * Verifies validation rejects bad input before the DB is touched,
 * and that protected routes return 401 without a valid JWT.
 */
import { describe, it, expect, vi } from 'vitest';
import request   from 'supertest';
import jwt        from 'jsonwebtoken';
import { createApp } from '../../app.js';

vi.mock('pg', () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const Pool  = vi.fn(() => ({ query }));
  return { default: { Pool }, Pool };
});

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

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
    const { Pool } = vi.mocked(await import('pg'));
    const querySpy = Pool.mock.results[0].value.query;
    querySpy.mockClear();

    const res = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ body_markdown: '# No title here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    // Validation fires before DB — no query should have run
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe('PUT /posts/:slug', () => {
  it('returns 401 when no JWT provided', async () => {
    const res = await request(app).put('/posts/some-slug').send({ title: 'Updated' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app)
      .put('/posts/some-slug')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ body_markdown: '# No title' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });
});
