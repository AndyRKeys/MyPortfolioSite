/**
 * Priority 2 — travel route integration tests.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt      from 'jsonwebtoken';
import { createApp } from '../../app.js';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
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
      .send({ visitDate: '2026-04-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });
});

describe('PUT /travel/:id', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).put('/travel/some-id').send({ title: 'Paris' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when visitDate format is invalid', async () => {
    const res = await request(app)
      .put('/travel/some-id')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ title: 'Paris', visitDate: '01-04-2026' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/i);
  });
});
