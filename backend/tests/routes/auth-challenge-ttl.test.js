/**
 * WebAuthn challenge TTL parameterisation (#522 M15).
 *
 * auth.js previously interpolated WEBAUTHN_CHALLENGE_TTL directly into
 * `NOW() + INTERVAL '...'` SQL literals. These tests assert the TTL is now a
 * bound `$n::interval` parameter. Separate file so WEBAUTHN_* env vars can be
 * set before the app (and @simplewebauthn option generation) is imported.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// email.js → nodemailer; mock so no real SMTP at import time
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn() },
}));

process.env.WEBAUTHN_RP_NAME = 'Test RP';
process.env.WEBAUTHN_RP_ID   = 'localhost';
process.env.WEBAUTHN_ORIGIN  = 'http://localhost';
process.env.JWT_SECRET       = 'test-secret-test-secret-test-secret-32';

const { createApp }              = await import('../../app.js');
const { pool }                   = await import('../../db/pool.js');
const { WEBAUTHN_CHALLENGE_TTL } = await import('../../utils/constants.js');

const app = createApp();

describe('POST /auth/passkey/login/start — challenge TTL binding', () => {
  it('passes WEBAUTHN_CHALLENGE_TTL as a bound interval parameter, not a SQL literal', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // rate limiter
      .mockResolvedValueOnce({ rows: [] });              // challenge insert

    const res = await request(app).post('/auth/passkey/login/start').send({});
    expect(res.status).toBe(200);

    const insertCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO webauthn_challenges'),
    );
    expect(insertCall).toBeDefined();
    const [sql, params] = insertCall;
    expect(sql).toContain('::interval');
    expect(sql).not.toContain("INTERVAL '");
    expect(params[params.length - 1]).toBe(WEBAUTHN_CHALLENGE_TTL);
  });
});
