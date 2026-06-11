/**
 * Audit route tests (#154)
 * GET /audit — auth required; supports ?limit and ?type filter
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../app.js';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

import { pool } from '../../db/pool.js';

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-32';

const app = createApp();

function makeToken() {
  return jwt.sign({ userId: 'test-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const fakeRow = {
  id:          'audit-id-1',
  action:      'post.create',
  entity_type: 'post',
  entity_id:   'post-id-1',
  detail:      { title: 'Hello World' },
  ip:          '127.0.0.1',
  created_at:  new Date().toISOString(),
  username:    'andy',
};

describe('GET /audit — auth gate', () => {
  it('returns 401 without a JWT', async () => {
    const res = await request(app).get('/audit');
    expect(res.status).toBe(401);
  });

  it('returns 401 with an invalid JWT', async () => {
    const res = await request(app)
      .get('/audit')
      .set('Authorization', 'Bearer bad.token.here');
    expect(res.status).toBe(401);
  });
});

describe('GET /audit — authenticated', () => {
  it('returns 200 with an empty array when no entries', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .get('/audit')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('returns audit rows as JSON array', async () => {
    pool.query.mockResolvedValue({ rows: [fakeRow] });
    const res = await request(app)
      .get('/audit')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body[0].action).toBe('post.create');
    expect(res.body[0].username).toBe('andy');
  });

  it('accepts ?limit=10 parameter', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .get('/audit?limit=10')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    // Verify limit was passed to query (cap at 200)
    const call = pool.query.mock.calls[0];
    expect(call[1][1]).toBe(10);
  });

  it('caps limit at 200', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app)
      .get('/audit?limit=9999')
      .set('Authorization', `Bearer ${makeToken()}`);
    const call = pool.query.mock.calls[0];
    expect(call[1][1]).toBe(200);
  });

  it('passes type filter to query', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app)
      .get('/audit?type=post')
      .set('Authorization', `Bearer ${makeToken()}`);
    const call = pool.query.mock.calls[0];
    expect(call[1][0]).toBe('post');
  });

  it('passes null for type=all', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await request(app)
      .get('/audit?type=all')
      .set('Authorization', `Bearer ${makeToken()}`);
    const call = pool.query.mock.calls[0];
    expect(call[1][0]).toBeNull();
  });
});
