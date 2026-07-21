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
    if (args.includes('--abbrev-ref'))       return Promise.resolve('main\n');
    if (args.includes('rev-parse'))          return Promise.resolve('abc1234def5678901234567890123456789012345\n');
    if (args.includes('--format=%s'))        return Promise.resolve('chore: test commit\n');
    if (args.includes('--format=%ci'))       return Promise.resolve('2026-01-01 00:00:00 +0000\n');
    if (args.includes('--count'))            return Promise.resolve('0\n');
    if (args.includes('fetch'))              return Promise.resolve('');
    if (args.includes('--format=%H'))        return Promise.resolve('abc1234def5678901234567890123456789012345\n');
    if (args.includes('--sort=-committerdate')) return Promise.resolve(
      '  origin/dev\n  origin/feature/issue-497-deploy-branch-selector\n  origin/HEAD -> origin/main\n  origin/main\n'
    );
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
  const access   = vi.fn().mockResolvedValue(undefined);
  const stat     = vi.fn().mockResolvedValue({ size: 0 });
  const readFile = vi.fn().mockResolvedValue('');
  return { ...orig, default: { ...orig, access, stat, readFile }, access, stat, readFile };
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
    const fsp = await import('fs/promises');
    fsp.access.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const res = await request(app)
      .post('/deploy')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/queue/i);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/deploy');
    expect(res.status).toBe(401);
  });
});

// ── GET /deploy/branches ──────────────────────────────────────────────────────

describe('GET /deploy/branches', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).get('/deploy/branches');
    expect(res.status).toBe(401);
  });

  it('returns 200 with branches array for a valid admin JWT', async () => {
    const res = await request(app)
      .get('/deploy/branches')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('branches');
    expect(Array.isArray(res.body.branches)).toBe(true);
    // HEAD and main should be excluded; dev and feature branch included
    expect(res.body.branches).not.toContain('HEAD');
    expect(res.body.branches).not.toContain('main');
    expect(res.body.branches).toContain('dev');
    expect(res.body.branches).toContain('feature/issue-497-deploy-branch-selector');
  });
});

// ── POST /deploy/fetch — branch cache invalidation (#522 M17) ────────────────

describe('POST /deploy/fetch — branch cache invalidation', () => {
  async function branchListGitCalls() {
    const { spawnPromise } = await import('../../utils/shell.js');
    return spawnPromise.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && args.includes('--sort=-committerdate')
    ).length;
  }

  it('clears the branch cache so the next /branches call re-runs git', async () => {
    const { spawnPromise } = await import('../../utils/shell.js');

    // Prime the cache (may or may not shell out depending on prior tests)
    await request(app)
      .get('/deploy/branches')
      .set('Authorization', `Bearer ${adminToken()}`);
    spawnPromise.mockClear();

    // Cached: no git call expected
    const cached = await request(app)
      .get('/deploy/branches')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(cached.status).toBe(200);
    expect(await branchListGitCalls()).toBe(0);

    // Fetch must invalidate the cache
    const fetchRes = await request(app)
      .post('/deploy/fetch')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(fetchRes.status).toBe(200);

    // Next /branches call bypasses the (cleared) cache and re-runs git
    const fresh = await request(app)
      .get('/deploy/branches')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(fresh.status).toBe(200);
    expect(await branchListGitCalls()).toBe(1);
  });
});

// ── GET /deploy/history ───────────────────────────────────────────────────────

describe('GET /deploy/history', () => {
  it('returns 401 without JWT', async () => {
    const res = await request(app).get('/deploy/history');
    expect(res.status).toBe(401);
  });

  it('returns 200 with commits, deploy_runs, and branch when no ?branch= param', async () => {
    const res = await request(app)
      .get('/deploy/history')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('commits');
    expect(res.body).toHaveProperty('deploy_runs');
    expect(res.body).toHaveProperty('branch');
    expect(Array.isArray(res.body.commits)).toBe(true);
    expect(Array.isArray(res.body.deploy_runs)).toBe(true);
  });

  it('uses DEPLOY_BRANCH when ?branch= is omitted', async () => {
    const { spawnPromise } = await import('../../utils/shell.js');
    spawnPromise.mockClear();
    await request(app)
      .get('/deploy/history')
      .set('Authorization', `Bearer ${adminToken()}`);
    const gitLogCall = spawnPromise.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args.includes('--format=%H|%h|%s|%ci')
    );
    expect(gitLogCall).toBeDefined();
    const expectedBranch = process.env.DEPLOY_ENV === 'prod' ? 'main' : 'dev';
    expect(gitLogCall[1]).toContain(`origin/${expectedBranch}`);
  });

  it('returns 200 and uses supplied branch when ?branch= is a valid branch name', async () => {
    const { spawnPromise } = await import('../../utils/shell.js');
    spawnPromise.mockClear();
    const res = await request(app)
      .get('/deploy/history?branch=feature/issue-497-deploy-branch-selector')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.branch).toBe('feature/issue-497-deploy-branch-selector');
    const gitLogCall = spawnPromise.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args.includes('--format=%H|%h|%s|%ci')
    );
    expect(gitLogCall).toBeDefined();
    expect(gitLogCall[1]).toContain('origin/feature/issue-497-deploy-branch-selector');
  });

  it('returns 400 for an invalid branch name (path traversal)', async () => {
    const res = await request(app)
      .get('/deploy/history?branch=../../etc/passwd')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid branch/i);
  });

  it('returns 400 for a branch name with shell metacharacters', async () => {
    const res = await request(app)
      .get('/deploy/history?branch=main;rm+-rf+/')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid branch/i);
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
