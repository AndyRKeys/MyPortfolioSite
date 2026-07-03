/**
 * Deploy route tests — auth scope enforcement (#275) and queue-based
 * trigger behaviour (#487). POST /deploy and POST /rollback now write
 * a trigger file and tail the log; POST /fetch still uses spawnStream.
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

vi.mock('../../utils/shell.js', () => ({
  spawnPromise: vi.fn().mockImplementation((_cmd, args) => {
    if (args.includes('--abbrev-ref'))  return Promise.resolve('main\n');
    if (args.includes('rev-parse'))     return Promise.resolve('abc1234def5678901234567890123456789012345\n');
    if (args.includes('--format=%s'))   return Promise.resolve('chore: test commit\n');
    if (args.includes('--format=%ci'))  return Promise.resolve('2026-01-01 00:00:00 +0000\n');
    if (args.includes('--count'))       return Promise.resolve('0\n');
    if (args.includes('fetch'))         return Promise.resolve('');
    if (args.includes('--format=%H'))   return Promise.resolve('abc1234def5678901234567890123456789012345\n');
    return Promise.resolve('');
  }),
  spawnStream: vi.fn().mockImplementation(() => (async function* () {})()),
}));

vi.mock('../../utils/deployQueue.js', () => ({
  writeQueueTrigger: vi.fn().mockResolvedValue(undefined),
  tailLogFile: vi.fn().mockImplementation(async function* () {
    yield '[deploy:start] step=1 status=ok';
    yield '✅  DEPLOY COMPLETE — dev — 2026-07-02 18:00:00';
  }),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const orig = await importOriginal();
  const stat     = vi.fn().mockResolvedValue({ size: 0 });
  const readFile = vi.fn().mockResolvedValue('');
  return { ...orig, default: { ...orig, stat, readFile }, stat, readFile };
});

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
  vi.clearAllMocks();
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

  it('returns 200 with a valid service JWT', async () => {
    const res = await request(app)
      .get('/deploy/status')
      .set('Authorization', `Bearer ${serviceToken()}`);
    expect(res.status).toBe(200);
  });

  it('returns 403 when service JWT has wrong role', async () => {
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

describe('POST /posts — service token does not grant admin access', () => {
  it('returns 401 when a service JWT is used on an admin-only route', async () => {
    const res = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${serviceToken()}`)
      .send({ title: 'Injected post', body_markdown: '# Hack' });
    expect(res.status).toBe(401);
  });
});

// ── POST /deploy — queue-based trigger ───────────────────────────────────────

describe('POST /deploy — queue-based trigger', () => {
  it('returns SSE response and calls writeQueueTrigger with valid admin JWT', async () => {
    const { writeQueueTrigger } = await import('../../utils/deployQueue.js');
    const res = await request(app)
      .post('/deploy')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(writeQueueTrigger).toHaveBeenCalledWith(expect.any(String), null);
  });

  it('returns 400 when queue directory is not mounted', async () => {
    const saved = process.env.DEPLOY_QUEUE_DIR;
    process.env.DEPLOY_QUEUE_DIR = '/nonexistent-deploy-queue-test-xyz';
    try {
      const res = await request(app)
        .post('/deploy')
        .set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/queue/i);
    } finally {
      process.env.DEPLOY_QUEUE_DIR = saved;
    }
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/deploy');
    expect(res.status).toBe(401);
  });
});

// ── POST /deploy/rollback ─────────────────────────────────────────────────────

describe('POST /deploy/rollback — queue-based trigger', () => {
  it('returns 400 for invalid SHA format', async () => {
    const res = await request(app)
      .post('/deploy/rollback')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ sha: 'not-a-sha!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SHA/i);
  });

  it('returns 400 for SHA not in recent history', async () => {
    const res = await request(app)
      .post('/deploy/rollback')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ sha: 'deadbeef123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns SSE stream and calls writeQueueTrigger with sha for a known SHA', async () => {
    const { writeQueueTrigger } = await import('../../utils/deployQueue.js');
    // spawnPromise for --format=%H returns abc1234...; slice matches
    const res = await request(app)
      .post('/deploy/rollback')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ sha: 'abc1234' });
    expect(res.status).toBe(200);
    expect(writeQueueTrigger).toHaveBeenCalledWith(expect.any(String), 'abc1234');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/deploy/rollback').send({ sha: 'abc1234' });
    expect(res.status).toBe(401);
  });
});
