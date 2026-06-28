/**
 * Deploy route auth tests (#275) — verifies scope enforcement for
 * authenticateDeploy: admin JWT, valid service JWT, wrong role, wrong
 * service name, no token, and that service tokens are rejected by
 * admin-only routes (different secret, so they fail authenticate).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const ADMIN_SECRET   = 'test-admin-secret-32-chars-minimum!';
const SERVICE_SECRET = 'test-service-secret-32-chars-minimum';

// ── Mocks (hoisted — must precede createApp/module imports) ──────────────────

vi.mock('../../db/pool.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// spawnPromise returns fake git output so /status resolves without a real repo.
// spawnStream returns an empty async iterable so SSE routes close cleanly.
vi.mock('../../utils/shell.js', () => ({
  spawnPromise: vi.fn().mockImplementation((_cmd, args) => {
    if (args.includes('--abbrev-ref')) return Promise.resolve('main\n');
    if (args.includes('rev-parse'))   return Promise.resolve('abc1234def5678901234567890123456789012345\n');
    if (args.includes('--format=%s')) return Promise.resolve('chore: test commit\n');
    if (args.includes('--format=%ci')) return Promise.resolve('2026-01-01 00:00:00 +0000\n');
    if (args.includes('--count'))     return Promise.resolve('0\n');
    if (args.includes('fetch'))       return Promise.resolve('');
    return Promise.resolve('');
  }),
  spawnStream: vi.fn().mockImplementation(() => {
    return (async function* () {})();
  }),
}));

import { createApp } from '../../app.js';

const app = createApp();

// ── Token helpers ─────────────────────────────────────────────────────────────

function adminToken() {
  return jwt.sign({ userId: 1 }, ADMIN_SECRET);
}

function serviceToken(overrides = {}) {
  return jwt.sign(
    { role: 'service', service: 'deploy-webhook', ...overrides },
    SERVICE_SECRET,
    { expiresIn: '1d' }
  );
}

beforeEach(() => {
  process.env.JWT_SECRET         = ADMIN_SECRET;
  process.env.SERVICE_JWT_SECRET = SERVICE_SECRET;
});

afterEach(() => {
  delete process.env.JWT_SECRET;
  delete process.env.SERVICE_JWT_SECRET;
});

// ── /api/deploy/status auth tests ────────────────────────────────────────────

describe('GET /deploy/status — authenticateDeploy', () => {
  it('returns 200 with a valid admin JWT', async () => {
    const res = await request(app)
      .get('/deploy/status')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });

  it('returns 200 with a valid service JWT (role:service, service:deploy-webhook)', async () => {
    const res = await request(app)
      .get('/deploy/status')
      .set('Authorization', `Bearer ${serviceToken()}`);
    expect(res.status).toBe(200);
  });

  it('returns 403 when service JWT has role:admin instead of role:service', async () => {
    const token = jwt.sign({ role: 'admin', service: 'deploy-webhook' }, SERVICE_SECRET, { expiresIn: '1d' });
    const res = await request(app)
      .get('/deploy/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/scope/i);
  });

  it('returns 403 when service JWT has wrong service name', async () => {
    const token = serviceToken({ service: 'wrong-service' });
    const res = await request(app)
      .get('/deploy/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/scope/i);
  });

  it('returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/deploy/status');
    expect(res.status).toBe(401);
  });

  it('returns 403 when a service-claim token is signed with the admin secret', async () => {
    // A service-shaped payload signed with JWT_SECRET (not SERVICE_JWT_SECRET)
    // must be rejected — the admin path must not accept service-scoped tokens.
    const token = jwt.sign(
      { role: 'service', service: 'deploy-webhook' },
      ADMIN_SECRET,
      { algorithm: 'HS256' }
    );
    const res = await request(app)
      .get('/deploy/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 when service JWT has no expiry claim', async () => {
    // Tokens without exp must be rejected to prevent indefinite-lifetime service tokens.
    const token = jwt.sign(
      { role: 'service', service: 'deploy-webhook' },
      SERVICE_SECRET,
      { algorithm: 'HS256' }
    );
    const res = await request(app)
      .get('/deploy/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ── Service token rejected by admin-only route ────────────────────────────────
// Posts route uses authenticate (JWT_SECRET only) — a service token signed with
// SERVICE_JWT_SECRET cannot verify against JWT_SECRET, so it gets 401.

describe('POST /posts — service token does not grant admin access', () => {
  it('returns 401 when a service JWT is used on an admin-only route', async () => {
    const res = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${serviceToken()}`)
      .send({ title: 'Injected post', body_markdown: '# Hack' });
    expect(res.status).toBe(401);
  });
});
