import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const SECRET = 'test-secret-32-chars-minimum-length!';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// Mock metrics module so route tests don't depend on timing
vi.mock('../../utils/metrics.js', () => ({
  recordRequest:    vi.fn(),
  getMetrics:       vi.fn().mockReturnValue([
    { ts: 1720000000000, s2xx: 10, s4xx: 2, s5xx: 0, requests: 12, p50_ms: 30, p95_ms: 120 },
  ]),
  _resetForTesting: vi.fn(),
}));

import { createApp } from '../../app.js';

const app = createApp();

function authToken() {
  return jwt.sign({ userId: 1 }, SECRET);
}

beforeEach(() => { process.env.JWT_SECRET = SECRET; });
afterEach(() => { delete process.env.JWT_SECRET; });

describe('POST /stats/visit', () => {
  it('accepts page=ai-blog and records the visit (#522 M7)', async () => {
    const { pool } = await import('../../db/pool.js');
    pool.query.mockResolvedValueOnce({ rows: [{ count: '5' }] });
    const res = await request(app).post('/stats/visit?page=ai-blog');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ page: 'ai-blog', count: 5 });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO page_visits'),
      ['ai-blog']
    );
  });

  it('still rejects a non-whitelisted page with 400', async () => {
    const res = await request(app).post('/stats/visit?page=not-a-page');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid page/i);
  });
});

describe('GET /stats/visits', () => {
  it('returns 200 with auth', async () => {
    const res = await request(app)
      .get('/stats/visits')
      .set('Authorization', `Bearer ${authToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/stats/visits');
    expect(res.status).toBe(401);
  });
});

describe('GET /stats/metrics', () => {
  it('returns 200 with an array of bucket objects when authenticated', async () => {
    const res = await request(app)
      .get('/stats/metrics')
      .set('Authorization', `Bearer ${authToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({
      ts:       expect.any(Number),
      s2xx:     expect.any(Number),
      s4xx:     expect.any(Number),
      s5xx:     expect.any(Number),
      requests: expect.any(Number),
      p50_ms:   expect.any(Number),
      p95_ms:   expect.any(Number),
    });
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/stats/metrics');
    expect(res.status).toBe(401);
  });
});
