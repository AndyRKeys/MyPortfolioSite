/**
 * Priority 2 — contact route integration tests.
 * The pg pool is mocked so no real DB is required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

// Mock pool directly — contact route uses it for rate-limit checks
vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// Mock nodemailer so no real SMTP is needed
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-id' }),
    })),
  },
}));

const app = createApp();

describe('POST /contact', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: no existing rate-limit record
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('returns 400 with error message when name is missing', async () => {
    const res = await request(app)
      .post('/contact')
      .send({ email: 'alice@example.com', message: 'Hi' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/name/i);
  });

  it('returns 400 with error message when email is invalid', async () => {
    const res = await request(app)
      .post('/contact')
      .send({ name: 'Alice', email: 'bad-email', message: 'Hi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('returns 400 when message is missing', async () => {
    const res = await request(app)
      .post('/contact')
      .send({ name: 'Alice', email: 'alice@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message/i);
  });
});

describe('POST /contact — SERVICE_KEY rate-limit bypass', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Simulate rate limit exceeded so bypass behaviour is observable
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    pool.query.mockResolvedValue({ rows: [{ count: 4 }] });
  });

  afterEach(() => {
    delete process.env.SERVICE_KEY;
  });

  it('returns 429 when rate limit exceeded and no service key sent', async () => {
    process.env.SERVICE_KEY = 'test-secret';
    const res = await request(app)
      .post('/contact')
      .send({ name: 'Alice', email: 'alice@example.com', message: 'Hi' });
    expect(res.status).toBe(429);
  });

  it('returns 429 when rate limit exceeded and wrong service key sent', async () => {
    process.env.SERVICE_KEY = 'test-secret';
    const res = await request(app)
      .post('/contact')
      .set('X-Service-Key', 'wrong-key')
      .send({ name: 'Alice', email: 'alice@example.com', message: 'Hi' });
    expect(res.status).toBe(429);
  });

  it('bypasses rate limit and reaches validation when correct service key sent', async () => {
    process.env.SERVICE_KEY = 'test-secret';
    const res = await request(app)
      .post('/contact')
      .set('X-Service-Key', 'test-secret')
      .send({ name: 'Alice', email: 'not-an-email', message: 'Hi' });
    // Rate limiter skipped — validation fires and rejects the bad email with 400, not 429
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('does not bypass rate limit when SERVICE_KEY env var is unset', async () => {
    // SERVICE_KEY deliberately not set
    const res = await request(app)
      .post('/contact')
      .set('X-Service-Key', 'any-value')
      .send({ name: 'Alice', email: 'alice@example.com', message: 'Hi' });
    expect(res.status).toBe(429);
  });
});
