/**
 * Search route tests (#157)
 * GET /search?q=<term>&type=<all|blog|travel>&limit=<n>
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

import { pool } from '../../db/pool.js';

const app = createApp();

beforeEach(() => { vi.clearAllMocks(); });

// Helper: find the pool.query call that ran the actual search SQL
// (PostgresStore rate-limit queries fire first; the search query contains search_vector)
function findSearchCall() {
  return pool.query.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('search_vector'));
}

const fakeRow = {
  id:           'post-id-1',
  title:        'Tokyo Travel',
  slug:         'tokyo-travel',
  post_type:    'travel',
  location:     'Tokyo, Japan',
  published_at: new Date().toISOString(),
  post_date:    '2023-04-10',
  excerpt:      'A fantastic trip to Tokyo...',
  rank:         0.9,
};

describe('GET /search', () => {
  it('returns 400 when q is missing', async () => {
    const res = await request(app).get('/search');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 400 when q is empty string', async () => {
    const res = await request(app).get('/search?q=');
    expect(res.status).toBe(400);
  });

  it('returns search results for a valid query', async () => {
    pool.query.mockResolvedValue({ rows: [fakeRow] });
    const res = await request(app).get('/search?q=tokyo');
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('tokyo');
    expect(res.body.total).toBe(1);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results[0].title).toBe('Tokyo Travel');
  });

  it('returns empty results array when no matches', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/search?q=nonexistent');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.results).toHaveLength(0);
  });

  it('passes type=blog filter to query', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app).get('/search?q=hello&type=blog');
    const call = findSearchCall();
    // Second param is the type filter
    expect(call[1][1]).toBe('blog');
  });

  it('passes null for type=all (no filter)', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app).get('/search?q=hello&type=all');
    const call = findSearchCall();
    expect(call[1][1]).toBeNull();
  });

  it('passes null for unknown type values (safety guard)', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app).get('/search?q=hello&type=admin');
    const call = findSearchCall();
    expect(call[1][1]).toBeNull();
  });

  it('caps limit at 50', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app).get('/search?q=hello&limit=999');
    const call = findSearchCall();
    expect(call[1][2]).toBe(50);
  });
});
