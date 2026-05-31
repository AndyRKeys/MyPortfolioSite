/**
 * Debug route tests — error ingestion, sanitisation, GET pagination, rate limit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../app.js';

// ── DB mock ───────────────────────────────────────────────────────────────────
const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('../../db/pool.js', () => ({
  pool: { query: mockQuery },
}));

// ── Email mock (prevent real SMTP/Graph calls) ────────────────────────────────
vi.mock('../../utils/email.js', () => ({
  isEmailConfigured:   vi.fn().mockReturnValue(false),
  sendErrorAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

process.env.JWT_SECRET  = 'test-secret-test-secret-test-secret-32';
process.env.NODE_ENV    = 'test'; // treated as non-production → GET /debug/errors open

const app = createApp();

beforeEach(() => {
  mockQuery.mockReset();
  // Default: INSERT succeeds, SELECT returns empty list, COUNT returns 0
  mockQuery.mockResolvedValue({ rows: [] });
});

// ── POST /debug/errors ────────────────────────────────────────────────────────

describe('POST /debug/errors — ingestion', () => {
  it('returns { received: true } for a valid payload', async () => {
    const res = await request(app)
      .post('/debug/errors')
      .send({ type: 'TypeError', message: 'Cannot read property x of undefined' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it('persists the error to the DB', async () => {
    await request(app)
      .post('/debug/errors')
      .send({ type: 'ReferenceError', message: 'foo is not defined', lineno: 42, colno: 7 });

    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO client_errors'));
    expect(insertCall).toBeDefined();
    const params = insertCall[1];
    expect(params[0]).toBe('ReferenceError');
    expect(params[1]).toBe('foo is not defined');
    expect(params[4]).toBe(42); // lineno
    expect(params[5]).toBe(7);  // colno
  });

  it('returns { received: false } for a missing type', async () => {
    const res = await request(app)
      .post('/debug/errors')
      .send({ message: 'no type here' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(false);
  });

  it('returns { received: false } for a missing message', async () => {
    const res = await request(app)
      .post('/debug/errors')
      .send({ type: 'TypeError' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(false);
  });
});

describe('POST /debug/errors — sanitisation', () => {
  it('stores null for non-UUID sessionId', async () => {
    await request(app)
      .post('/debug/errors')
      .send({ type: 'Error', message: 'test', sessionId: 'not-a-uuid' });

    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO client_errors'));
    const params = insertCall[1];
    // session_id is index 7
    expect(params[7]).toBeNull();
  });

  it('stores a valid UUID sessionId', async () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    await request(app)
      .post('/debug/errors')
      .send({ type: 'Error', message: 'test', sessionId: uuid });

    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO client_errors'));
    const params = insertCall[1];
    expect(params[7]).toBe(uuid);
  });

  it('truncates a type longer than 50 chars', async () => {
    const longType = 'A'.repeat(100);
    await request(app)
      .post('/debug/errors')
      .send({ type: longType, message: 'test' });

    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO client_errors'));
    const params = insertCall[1];
    expect(params[0].length).toBeLessThanOrEqual(50);
  });

  it('does not throw when DB insert fails (non-fatal)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app)
      .post('/debug/errors')
      .send({ type: 'Error', message: 'test' });
    // Should still respond 200 — DB failures must not break the page
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

// ── GET /debug/errors ─────────────────────────────────────────────────────────

describe('GET /debug/errors', () => {
  beforeEach(() => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'abc', type: 'Error', message: 'test', received_at: new Date().toISOString() }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
  });

  it('returns paginated errors and total', async () => {
    const res = await request(app).get('/debug/errors');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total', 1);
    expect(res.body.errors).toHaveLength(1);
  });

  it('respects limit and offset query params', async () => {
    await request(app).get('/debug/errors?limit=10&offset=5');
    const selectCall = mockQuery.mock.calls.find(([sql]) => sql.includes('LIMIT'));
    expect(selectCall[1]).toEqual([10, 5]);
  });

  it('caps limit at 200', async () => {
    // Reset mock for this call
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await request(app).get('/debug/errors?limit=9999');
    const selectCall = mockQuery.mock.calls.find(([sql]) => sql.includes('LIMIT'));
    expect(selectCall[1][0]).toBe(200);
  });
});

// ── POST /debug/errors — rate limit exemption ─────────────────────────────────

describe('POST /debug/errors — JWT authenticated session exemption', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // Simulate rate limit exceeded so exemption behaviour is observable
    mockQuery.mockResolvedValue({ rows: [{ count: 51 }] });
  });

  afterEach(() => {
    delete process.env.SERVICE_KEY;
  });

  it('returns 429 when rate limit exceeded and no credentials sent', async () => {
    const res = await request(app)
      .post('/debug/errors')
      .send({ type: 'TypeError', message: 'test' });
    expect(res.status).toBe(429);
  });

  it('exempts authenticated session when valid JWT sent', async () => {
    const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET);
    // Reset mock so the INSERT after rate-limit exemption succeeds
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/debug/errors')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'TypeError', message: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it('still rate limits when JWT is invalid', async () => {
    const res = await request(app)
      .post('/debug/errors')
      .set('Authorization', 'Bearer not.a.valid.jwt')
      .send({ type: 'TypeError', message: 'test' });
    expect(res.status).toBe(429);
  });

  it('exempts service account when correct SERVICE_KEY sent', async () => {
    process.env.SERVICE_KEY = 'test-key';
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/debug/errors')
      .set('X-Service-Key', 'test-key')
      .send({ type: 'TypeError', message: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});
