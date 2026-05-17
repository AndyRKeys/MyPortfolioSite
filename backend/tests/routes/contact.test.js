/**
 * Priority 2 — contact route integration tests.
 * The pg pool is mocked so no real DB is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
