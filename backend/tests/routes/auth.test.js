/**
 * Auth route — POST /auth/setup retired (#282); now returns 410.
 * POST /auth/email/send bootstraps the admin user on first use.
 * The pg pool is mocked so no real DB is required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// auth.js → utils/email.js → nodemailer; mock so no real SMTP at import time
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-id' }),
    })),
  },
}));

const app = createApp();
const ADMIN = 'admin@example.com';

describe('POST /auth/setup — retired endpoint (#282)', () => {
  it('returns 410 Gone for any request', async () => {
    const res = await request(app)
      .post('/auth/setup')
      .send({ email: ADMIN, username: 'admin' });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/retired/i);
  });

  it('returns 410 Gone even for non-admin email', async () => {
    const res = await request(app)
      .post('/auth/setup')
      .send({ email: 'attacker@evil.com', username: 'attacker' });
    expect(res.status).toBe(410);
  });
});

describe('POST /auth/email/send — magic link find-or-create', () => {
  const origAdmin = process.env.ADMIN_EMAIL;
  const origSecret = process.env.JWT_SECRET;
  const origFrontend = process.env.FRONTEND_URL;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_EMAIL = ADMIN;
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-32';
    process.env.FRONTEND_URL = 'https://example.com';
    // SMTP_* set so isEmailConfigured() returns true without OAuth2
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASS = 'pass';
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    pool.query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    process.env.ADMIN_EMAIL = origAdmin;
    process.env.JWT_SECRET = origSecret;
    process.env.FRONTEND_URL = origFrontend;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  it('returns sent:true and skips user/token DB calls when email does not match ADMIN_EMAIL', async () => {
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    // Rate limiter fires first (DB-backed), then the admin-email gate blocks — no user/token queries.
    pool.query.mockResolvedValueOnce({ rows: [{ count: 1 }] }); // rate limiter
    const res = await request(app)
      .post('/auth/email/send')
      .send({ email: 'attacker@evil.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(pool.query).toHaveBeenCalledTimes(1); // only the rate limiter
  });

  it('creates user and issues token when no user exists (fresh DB)', async () => {
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })                     // rate limiter
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', created: true }] })  // upsert
      .mockResolvedValueOnce({ rows: [] });                                  // token insert
    const res = await request(app)
      .post('/auth/email/send')
      .send({ email: ADMIN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('reuses existing user and issues token when user already exists', async () => {
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })                      // rate limiter
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', created: false }] })  // upsert (existing)
      .mockResolvedValueOnce({ rows: [] });                                   // token insert
    const res = await request(app)
      .post('/auth/email/send')
      .send({ email: ADMIN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('passes MAGIC_LINK_TTL as a bound interval parameter, not a SQL literal (#522 M15)', async () => {
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    const { MAGIC_LINK_TTL } = await import('../../utils/constants.js');
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })                     // rate limiter
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', created: true }] })  // upsert
      .mockResolvedValueOnce({ rows: [] });                                  // token insert
    const res = await request(app)
      .post('/auth/email/send')
      .send({ email: ADMIN });
    expect(res.status).toBe(200);

    const [sql, params] = pool.query.mock.calls[2];
    expect(sql).toContain('INSERT INTO email_tokens');
    expect(sql).toContain('$3::interval');
    expect(sql).not.toContain("INTERVAL '");
    expect(params[2]).toBe(MAGIC_LINK_TTL);
  });
});
