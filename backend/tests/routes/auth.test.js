/**
 * Auth route — POST /auth/setup server-side admin guard (#274).
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

describe('POST /auth/setup — admin registration guard (#274)', () => {
  const origAdmin = process.env.ADMIN_EMAIL;
  const origSecret = process.env.JWT_SECRET;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.ADMIN_EMAIL = ADMIN;
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-32';
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    pool.query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    process.env.ADMIN_EMAIL = origAdmin;
    process.env.JWT_SECRET = origSecret;
  });

  it('rejects with 403 when the submitted email does not match ADMIN_EMAIL', async () => {
    const res = await request(app)
      .post('/auth/setup')
      .send({ email: 'attacker@evil.com', username: 'attacker' });
    expect(res.status).toBe(403);
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    expect(pool.query).not.toHaveBeenCalled(); // gated before any DB access
  });

  it('rejects with 403 (fail closed) when ADMIN_EMAIL is not configured', async () => {
    delete process.env.ADMIN_EMAIL;
    const res = await request(app)
      .post('/auth/setup')
      .send({ email: 'admin@example.com', username: 'admin' });
    expect(res.status).toBe(403);
  });

  it('rejects with 403 when a user already exists, even for the admin email', async () => {
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    pool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // COUNT(*)
    const res = await request(app)
      .post('/auth/setup')
      .send({ email: ADMIN, username: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/already complete/i);
  });

  it('allows setup for the admin email when no user exists yet', async () => {
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // COUNT(*)
      .mockResolvedValueOnce({ rows: [{ id: 1, email: ADMIN, username: 'admin' }] }); // INSERT
    const res = await request(app)
      .post('/auth/setup')
      .send({ email: ADMIN, username: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toMatchObject({ email: ADMIN });
  });

  it('rejects with 400 on an invalid email before the guard runs', async () => {
    const res = await request(app)
      .post('/auth/setup')
      .send({ email: 'not-an-email', username: 'admin' });
    expect(res.status).toBe(400);
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

  it('returns sent:true and skips DB when email does not match ADMIN_EMAIL', async () => {
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    const res = await request(app)
      .post('/auth/email/send')
      .send({ email: 'attacker@evil.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('creates user and issues token when no user exists (fresh DB)', async () => {
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    // upsert returns a newly created user
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', created: true }] })  // upsert
      .mockResolvedValueOnce({ rows: [] });                                  // token insert
    const res = await request(app)
      .post('/auth/email/send')
      .send({ email: ADMIN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('reuses existing user and issues token when user already exists', async () => {
    const { pool } = vi.mocked(await import('../../db/pool.js'));
    // upsert returns the existing user (created=false)
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', created: false }] }) // upsert
      .mockResolvedValueOnce({ rows: [] });                                  // token insert
    const res = await request(app)
      .post('/auth/email/send')
      .send({ email: ADMIN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
