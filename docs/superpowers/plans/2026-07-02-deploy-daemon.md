# Deploy Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move deploy execution from inside the backend container to a host-level systemd daemon, breaking the catch-22 where rolling back the app can remove the tools (`bash`, `curl`) needed to run the next deploy.

**Architecture:** A polling daemon (`deploy-daemon.sh`) runs on the host as a systemd service. The backend route writes a JSON trigger file to `~/deploy-queue/` (bind-mounted into the container at `/deploy-queue`). The daemon picks it up within ~2 seconds and calls `deploy.sh` natively. The SSE output panel switches from streaming subprocess stdout to tailing the existing deploy log file, which is already mounted into the container at `/app/logs/`.

**Tech Stack:** Bash (daemon), Node.js/Express (backend route), `fs/promises` (log tailing), systemd (host service manager), Vitest (tests)

## Global Constraints

- Bash scripts: no `set -euo pipefail` in sourced sub-libs; only in entry-point scripts (`deploy-daemon.sh` is an entry point — use it there)
- No new npm dependencies
- All tests run inside the Docker container: `docker compose exec backend npm test`
- Backend image: Node 20 Alpine; docker-compose.yml is the unified file for both dev and prod
- Never read `.env` files directly — use `redact_env` from deploy-lib.sh if needed
- `backend/tests/routes/deploy.test.js` already exists — update it, don't replace
- `scripts/deploy/deploy.sh` lines 167–180 and 337–360 contain the `DEPLOY_FROM_CONTAINER` blocks to remove (verified by grep in the session that produced this plan)

---

### Task 1: Daemon script, systemd unit, and queue bind-mount

**Files:**
- Create: `scripts/deploy/deploy-daemon.sh`
- Create: `scripts/config/deploy-daemon.service`
- Modify: `docker-compose.yml` (add queue bind-mount + `DEPLOY_QUEUE_DIR` env var; remove `DEPLOY_FROM_CONTAINER` + `DEPLOY_REPO_DIR`)

**Interfaces:**
- Produces: queue directory `~/deploy-queue/` polled every 2s; trigger files consumed as `{ env, requested_at, rollback_sha? }` JSON

- [ ] **Step 1: Create the daemon script**

```bash
# scripts/deploy/deploy-daemon.sh
```

Write this file:

```bash
#!/usr/bin/env bash
# deploy-daemon.sh — Host-level deploy daemon.
# Polls ~/deploy-queue/ for JSON trigger files and calls deploy.sh on the host.
# Managed by systemd — never run directly.
set -euo pipefail

QUEUE_DIR="${HOME}/deploy-queue"
REPO_DIR_DEV="${HOME}/MyPortfolioSite-dev"
REPO_DIR_PROD="${HOME}/MyPortfolioSite"
LOCK_FILE="${HOME}/.deploy-daemon.lock"

mkdir -p "$QUEUE_DIR"
echo "[deploy-daemon] started pid=$$"

cleanup() { rm -f "$LOCK_FILE"; }
trap cleanup EXIT

while true; do
  for req in "$QUEUE_DIR"/*.json; do
    [ -f "$req" ] || continue

    if [ -f "$LOCK_FILE" ]; then
      echo "[deploy-daemon] lock held — another deploy in progress, skipping $req"
      break
    fi
    touch "$LOCK_FILE"

    env_val=$(jq -r '.env // empty' "$req")
    sha=$(jq -r '.rollback_sha // empty' "$req")
    rm -f "$req"

    if [ -z "$env_val" ]; then
      echo "[deploy-daemon] invalid trigger — missing env field, skipping"
      rm -f "$LOCK_FILE"
      continue
    fi

    case "$env_val" in
      dev)  REPO_DIR="$REPO_DIR_DEV" ;;
      prod) REPO_DIR="$REPO_DIR_PROD" ;;
      *)
        echo "[deploy-daemon] unknown env '$env_val' — skipping"
        rm -f "$LOCK_FILE"
        continue
        ;;
    esac

    args=(--env "$env_val")
    [ -n "$sha" ] && args+=(--rollback "$sha")

    echo "[deploy-daemon] triggering deploy env=$env_val sha=${sha:-none}"
    bash "$REPO_DIR/scripts/deploy/deploy.sh" "${args[@]}" || true
    rm -f "$LOCK_FILE"
    break
  done
  sleep 2
done
```

```bash
chmod +x scripts/deploy/deploy-daemon.sh
```

- [ ] **Step 2: Create the systemd unit**

Write `scripts/config/deploy-daemon.service`:

```ini
[Unit]
Description=Portfolio deploy daemon
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=modnar3
ExecStart=/bin/bash /home/modnar3/MyPortfolioSite-dev/scripts/deploy/deploy-daemon.sh
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Update docker-compose.yml — backend environment block**

In the `backend:` → `environment:` section, remove these two lines:

```yaml
      DEPLOY_FROM_CONTAINER: "1"
      DEPLOY_REPO_DIR: /repo
```

And add in their place:

```yaml
      DEPLOY_QUEUE_DIR: /deploy-queue
```

- [ ] **Step 4: Update docker-compose.yml — backend volumes block**

In `backend:` → `volumes:`, add after the existing `${HOME}/logs:/app/logs:ro` line:

```yaml
      - ${HOME}/deploy-queue:/deploy-queue
```

The final backend volumes block should look like:

```yaml
    volumes:
      - uploads_data:/app/uploads
      - .:/repo
      - /var/run/docker.sock:/var/run/docker.sock
      - ${HOME}/logs:/app/logs:ro
      - ${HOME}/deploy-queue:/deploy-queue
```

- [ ] **Step 5: Syntax-check deploy-daemon.sh**

```bash
bash -n scripts/deploy/deploy-daemon.sh && echo "OK"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy/deploy-daemon.sh scripts/config/deploy-daemon.service docker-compose.yml
git commit -m "ops: add host-level deploy daemon + queue bind-mount (#487)"
```

---

### Task 2: deployQueue utility + deploy route refactor + test updates

**Files:**
- Create: `backend/utils/deployQueue.js`
- Modify: `backend/routes/deploy.js`
- Modify: `backend/tests/routes/deploy.test.js`

**Interfaces:**
- Consumes: `DEPLOY_QUEUE_DIR` env var (set to `/deploy-queue` by compose); `DEPLOY_LOG` path (`/app/logs/${DEPLOY_ENV}-deploy.log`)
- Produces: `writeQueueTrigger(env, rollbackSha?)` → writes trigger file; `tailLogFile(logPath, fromByte, signal)` → async generator of log lines

- [ ] **Step 1: Create `backend/utils/deployQueue.js`**

```js
import fsPromises from 'fs/promises';
import path from 'path';

// Sentinel patterns that signal deploy completion in the log
const SENTINEL_RE = /DEPLOY (COMPLETE|FAILED|ROLLED BACK)/;
const POLL_MS = 150;
const MAX_WAIT_MS = 15 * 60 * 1000; // 15 minutes

// Write a JSON trigger file to the queue directory.
// The host daemon picks it up within ~2s and calls deploy.sh.
export async function writeQueueTrigger(env, rollbackSha = null) {
  const queueDir = process.env.DEPLOY_QUEUE_DIR || '/deploy-queue';
  const filename = `${Date.now()}-${env}.json`;
  const payload = { env, requested_at: new Date().toISOString() };
  if (rollbackSha) payload.rollback_sha = rollbackSha;
  await fsPromises.writeFile(path.join(queueDir, filename), JSON.stringify(payload));
}

// Async generator: tails logPath from fromByte, yielding new lines as they arrive.
// Returns when a deploy-completion sentinel is seen, signal is aborted, or timeout.
export async function* tailLogFile(logPath, fromByte, signal) {
  let offset = fromByte;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (!signal?.aborted && Date.now() < deadline) {
    let size;
    try {
      size = (await fsPromises.stat(logPath)).size;
    } catch {
      await sleep(POLL_MS);
      continue;
    }

    if (size > offset) {
      const buf = Buffer.alloc(size - offset);
      const fh = await fsPromises.open(logPath, 'r');
      await fh.read(buf, 0, buf.length, offset);
      await fh.close();
      offset = size;

      const chunk = buf.toString('utf8');
      for (const line of chunk.split('\n')) {
        if (line.trim()) yield line;
      }
      if (SENTINEL_RE.test(chunk)) return;
    } else {
      await sleep(POLL_MS);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
```

- [ ] **Step 2: Rewrite `backend/routes/deploy.js`**

Replace the entire file with:

```js
import { Router }        from 'express';
import path              from 'path';
import fs                from 'fs/promises';
import { rateLimit }     from 'express-rate-limit';
import { authenticateDeploy } from '../middleware/authenticateDeploy.js';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { spawnStream, spawnPromise } from '../utils/shell.js';
import { parseDeployRuns } from '../utils/deployLogParser.js';
import { logger }        from '../utils/logger.js';
import { logAudit }      from '../utils/audit.js';
import { writeQueueTrigger, tailLogFile } from '../utils/deployQueue.js';

const router   = Router();

// Limiter precedes authenticateDeploy on every route so CodeQL's
// js/missing-rate-limiting detector sees it before the authorization step.
const deployReadLimit = rateLimit({
  windowMs:        60 * 1000,
  limit:           60,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { positiveHits: false },
  store:           new PostgresStore({ windowMs: 60 * 1000, keyType: 'deploy-read' }),
});

const deployWriteLimit = rateLimit({
  windowMs:        60 * 1000,
  limit:           10,
  keyGenerator:    (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
  skip:            exemptIfTrusted,
  message:         { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { positiveHits: false },
  store:           new PostgresStore({ windowMs: 60 * 1000, keyType: 'deploy-write' }),
});

const REPO_DIR        = process.env.REPO_DIR || '/repo';
const DEPLOY_ENV      = process.env.DEPLOY_ENV;
const DEPLOY_LOG      = `/app/logs/${DEPLOY_ENV}-deploy.log`;
const DEPLOY_BRANCH   = DEPLOY_ENV === 'prod' ? 'main' : 'dev';
const DEPLOY_QUEUE_DIR = process.env.DEPLOY_QUEUE_DIR || '/deploy-queue';

// 7–40 hex chars — covers both short and full SHAs
const SHA_RE = /^[0-9a-f]{7,40}$/i;

async function queueDirExists() {
  return fs.access(DEPLOY_QUEUE_DIR).then(() => true).catch(() => false);
}

async function recentSHAs() {
  const out = await spawnPromise('git', ['log', '--format=%H', '-20', `origin/${DEPLOY_BRANCH}`], { cwd: REPO_DIR });
  return out.trim().split('\n').filter(Boolean);
}

// Generic SSE streamer for async iterables (used by /fetch)
async function streamToSSE(res, iter) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    for await (const line of iter) {
      send({ type: 'line', text: line });
    }
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', text: err.message });
  }
  res.end();
}

// Writes a queue trigger and streams the deploy log file as SSE.
// The host daemon picks up the trigger within ~2s and writes to DEPLOY_LOG.
async function streamQueuedDeploy(res, env, rollbackSha = null) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Snapshot log size before triggering so tail starts from this run's output only
  let fromByte = 0;
  try {
    fromByte = (await fs.stat(DEPLOY_LOG)).size;
  } catch { /* log may not exist yet — tail from 0 */ }

  await writeQueueTrigger(env, rollbackSha);
  send({ type: 'line', text: '[admin] Deploy queued — daemon will pick it up within ~2s…' });

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    for await (const line of tailLogFile(DEPLOY_LOG, fromByte, ac.signal)) {
      send({ type: 'line', text: line });
    }
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', text: err.message });
  }
  res.end();
}

// ── GET /api/deploy/status ────────────────────────────────────────────────────

router.get('/status', deployReadLimit, authenticateDeploy, async (req, res) => {
  try {
    await spawnPromise('git', ['fetch', 'origin', DEPLOY_BRANCH], { cwd: REPO_DIR }).catch(() => {});

    const [branch, fullSha, message, date, behindRaw] = await Promise.all([
      spawnPromise('git', ['rev-parse', '--abbrev-ref', 'HEAD'],                { cwd: REPO_DIR }),
      spawnPromise('git', ['rev-parse', 'HEAD'],                                { cwd: REPO_DIR }),
      spawnPromise('git', ['log', '-1', '--format=%s', 'HEAD'],                 { cwd: REPO_DIR }),
      spawnPromise('git', ['log', '-1', '--format=%ci', 'HEAD'],                { cwd: REPO_DIR }),
      spawnPromise('git', ['rev-list', '--count', `HEAD..origin/${DEPLOY_BRANCH}`], { cwd: REPO_DIR }).catch(() => '0'),
    ]);

    const behind = parseInt(behindRaw.trim(), 10) || 0;
    res.json({
      env:        DEPLOY_ENV,
      branch:     branch.trim(),
      head:       { sha: fullSha.trim().slice(0, 7), full_sha: fullSha.trim(), message: message.trim(), date: date.trim() },
      behind,
      up_to_date: behind === 0,
      can_deploy: await queueDirExists(),
    });
  } catch (err) {
    res.status(200).json({
      branch:    'unknown',
      head:      { sha: '?', full_sha: '?', message: 'Git unavailable', date: '' },
      behind:    0,
      up_to_date: false,
      can_deploy: false,
      git_error: err.message,
    });
  }
});

// ── GET /api/deploy/history ───────────────────────────────────────────────────

router.get('/history', deployReadLimit, authenticateDeploy, async (req, res) => {
  try {
    const gitOut = await spawnPromise(
      'git', ['log', '--format=%H|%h|%s|%ci', '-20', `origin/${DEPLOY_BRANCH}`],
      { cwd: REPO_DIR }
    ).catch(() => '');

    const commits = gitOut.trim().split('\n').filter(Boolean).map(line => {
      const [sha, short_sha, message, date] = line.split('|');
      return { sha, short_sha, message, date };
    });

    let deploy_runs = [];
    try {
      const raw = await fs.readFile(DEPLOY_LOG, 'utf8');
      deploy_runs = parseDeployRuns(raw);
    } catch { /* log file may not exist yet */ }

    res.json({ commits, deploy_runs });
  } catch {
    res.json({ commits: [], deploy_runs: [] });
  }
});

// ── POST /api/deploy/fetch ────────────────────────────────────────────────────

router.post('/fetch', deployWriteLimit, authenticateDeploy, async (req, res) => {
  await logAudit(req, 'deploy.fetch', 'deploy', null, { env: DEPLOY_ENV });
  await streamToSSE(res, spawnStream('git', ['fetch', 'origin'], { cwd: REPO_DIR }));
});

// ── POST /api/deploy ──────────────────────────────────────────────────────────

router.post('/', deployWriteLimit, authenticateDeploy, async (req, res) => {
  if (!await queueDirExists()) {
    return res.status(400).json({ error: 'Deploy queue not mounted — check DEPLOY_QUEUE_DIR and docker-compose.yml' });
  }
  await logAudit(req, 'deploy.start', 'deploy', null, { env: DEPLOY_ENV });
  await streamQueuedDeploy(res, DEPLOY_ENV);
});

// ── POST /api/deploy/rollback ─────────────────────────────────────────────────

router.post('/rollback', deployWriteLimit, authenticateDeploy, async (req, res) => {
  const { sha } = req.body || {};

  if (!sha || !SHA_RE.test(sha)) {
    return res.status(400).json({ error: 'Invalid SHA format' });
  }

  const known = await recentSHAs().catch(() => []);
  const valid = known.some(s => s === sha || s.startsWith(sha) || sha === s.slice(0, sha.length));
  if (!valid) {
    return res.status(400).json({ error: 'SHA not found in recent commit history — rollback rejected' });
  }

  if (!await queueDirExists()) {
    return res.status(400).json({ error: 'Deploy queue not mounted — check DEPLOY_QUEUE_DIR and docker-compose.yml' });
  }

  await logAudit(req, 'deploy.rollback', 'deploy', null, { env: DEPLOY_ENV, sha });
  await streamQueuedDeploy(res, DEPLOY_ENV, sha);
});

export default router;
```

- [ ] **Step 3: Update `backend/tests/routes/deploy.test.js`**

Replace the entire file with:

```js
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
  return {
    ...orig,
    access:   vi.fn().mockResolvedValue(undefined),
    stat:     vi.fn().mockResolvedValue({ size: 0 }),
    readFile: vi.fn().mockResolvedValue(''),
  };
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
```

- [ ] **Step 4: Run the tests**

```bash
docker compose exec backend npm test -- backend/tests/routes/deploy.test.js
```

Expected: all tests pass. Fix any failures before continuing.

- [ ] **Step 5: Commit**

```bash
git add backend/utils/deployQueue.js backend/routes/deploy.js backend/tests/routes/deploy.test.js
git commit -m "ops: replace spawnStream deploy with queue trigger + log tail (#487)"
```

---

### Task 3: Dockerfile cleanup, deploy.sh cleanup, and RUNBOOK docs

**Files:**
- Modify: `backend/Dockerfile` (remove `bash curl openssl bind-tools` from apk)
- Modify: `scripts/deploy/deploy.sh` (remove `DEPLOY_FROM_CONTAINER` blocks)
- Modify: `docs/RUNBOOK.md` (add daemon install + management commands)

**Interfaces:**
- Consumes: Task 1 (daemon script) and Task 2 (route no longer calls bash scripts from container)

- [ ] **Step 1: Remove tools from `backend/Dockerfile`**

Find this block:

```dockerfile
RUN apk add --no-cache \
  ca-certificates \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont \
  libstdc++ \
  git \
  bash \
  curl \
  openssl \
  bind-tools \
  docker-cli \
  docker-compose
```

Replace with:

```dockerfile
RUN apk add --no-cache \
  ca-certificates \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont \
  libstdc++ \
  git \
  docker-cli \
  docker-compose
```

(Removing `bash`, `curl`, `openssl`, `bind-tools` — these were only needed when the container called `deploy.sh` directly. `git` stays for `GET /status` and `GET /history`. `docker-cli` and `docker-compose` stay for `POST /fetch`.)

- [ ] **Step 2: Remove `DEPLOY_FROM_CONTAINER` override block from `scripts/deploy/deploy.sh`**

Remove the entire block at lines ~161–180 (the container execution path override). It begins with:

```bash
# ── Container execution path override ─────────────────────────────────
```

And ends with:

```bash
fi

# Single unified compose file
```

Delete everything from the `# ── Container execution path override` comment through the closing `fi`, inclusive.

- [ ] **Step 3: Simplify the sudo guard in `scripts/deploy/deploy.sh`**

Find (near line 30):

```bash
if [ "${EUID:-$(id -u)}" -eq 0 ] && [ "${DEPLOY_FROM_CONTAINER:-0}" != "1" ]; then
```

Replace with:

```bash
if [ "${EUID:-$(id -u)}" -eq 0 ]; then
```

(The container exception is no longer needed — `deploy.sh` is only ever called from the host now.)

- [ ] **Step 4: Remove container rollback path from `scripts/deploy/deploy.sh`**

Find the rollback section (around line 337). The current code looks like:

```bash
  if [ "${DEPLOY_FROM_CONTAINER:-0}" = "1" ]; then
    # Running from inside the backend container: docker compose down would send
    # SIGTERM to this container and kill bash before dc up --build can run.
    dsection "Phase 5: building backend image"
    dinfo "Building backend image from rolled-back source..."
    dc build backend 2>&1 | tee -a "$LOG_FILE" || ddie "docker build failed"
    POST_SHA=$(git rev-parse HEAD)
    dlog "$(date -u +'%Y-%m-%dT%H:%M:%SZ') rollback $PRE_SHA → $POST_SHA" >> "$LOG_FILE"
    dsection "Rollback complete"
    dok "Rollback to $POST_SHA complete — backend is restarting..."
    dc up -d --no-deps --remove-orphans backend 2>&1 | tee -a "$LOG_FILE" || true
  else
    compose_up_with_rollback "$BACKEND_SERVICE"
    POST_SHA=$(git rev-parse HEAD)
    dlog "$(date -u +'%Y-%m-%dT%H:%M:%SZ') rollback $PRE_SHA → $POST_SHA" >> "$LOG_FILE"
    dsection "Rollback complete"
    dok "Rollback to $POST_SHA complete."
  fi
```

Replace the entire `if/else/fi` block with just the `else` branch content:

```bash
  compose_up_with_rollback "$BACKEND_SERVICE"
  POST_SHA=$(git rev-parse HEAD)
  dlog "$(date -u +'%Y-%m-%dT%H:%M:%SZ') rollback $PRE_SHA → $POST_SHA" >> "$LOG_FILE"
  dsection "Rollback complete"
  dok "Rollback to $POST_SHA complete."
```

- [ ] **Step 5: Verify deploy.sh syntax**

```bash
bash -n scripts/deploy/deploy.sh && echo "OK"
```

Expected: `OK`

- [ ] **Step 6: Add daemon management section to `docs/RUNBOOK.md`**

Add a new section after the existing "Common Tasks" opening. Insert after `## Common Tasks` and before `### 1. Check "is prod healthy?"`:

```markdown
### 0. Deploy daemon (first-time setup and management)

The deploy daemon runs on the host as a systemd service. It polls `~/deploy-queue/`
for trigger files written by the admin panel and calls `deploy.sh` natively.

**Install (one-time, after first deploy of a branch containing the daemon):**

```bash
sudo cp ~/MyPortfolioSite-dev/scripts/config/deploy-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deploy-daemon
```

**Check status:**

```bash
sudo systemctl status deploy-daemon
```

**View daemon logs:**

```bash
journalctl -u deploy-daemon -f
```

**Restart after updating the daemon script:**

```bash
sudo systemctl restart deploy-daemon
sudo systemctl status deploy-daemon
```

**Manual trigger (bypass the admin panel):**

```bash
echo '{"env":"dev","requested_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' \
  > ~/deploy-queue/$(date +%s)-dev.json
```
```

- [ ] **Step 7: Run the full test suite**

```bash
docker compose exec backend npm test
```

Expected: all 167+ tests pass. Fix any failures before continuing.

- [ ] **Step 8: Commit**

```bash
git add backend/Dockerfile scripts/deploy/deploy.sh docs/RUNBOOK.md
git commit -m "ops: remove DEPLOY_FROM_CONTAINER; trim bash/curl/openssl from image (#487)"
```

---

## Verification

After all 3 tasks are committed:

```bash
# 1. Syntax checks
bash -n scripts/deploy/deploy-daemon.sh && echo "daemon OK"
bash -n scripts/deploy/deploy.sh && echo "deploy.sh OK"

# 2. No DEPLOY_FROM_CONTAINER references remain
grep -r "DEPLOY_FROM_CONTAINER" scripts/ backend/ docker-compose.yml && echo "FOUND — cleanup missed" || echo "clean"

# 3. Full test suite
docker compose exec backend npm test
```

Expected: all three clean.

## Acceptance criteria (from issue #487)

- [ ] Triggering deploy/rollback from admin panel writes a trigger file; daemon picks it up and runs `deploy.sh` on the host
- [ ] SSE output panel streams live log output from the daemon-written log file
- [ ] Rolling back to any commit does not break the ability to deploy again
- [ ] Daemon restarts automatically after server reboot (`systemctl enable`)
- [ ] `docs/RUNBOOK.md` includes install + status check commands for the daemon
- [ ] `bash`, `curl`, `openssl`, `bind-tools` removed from `backend/Dockerfile`
- [ ] `DEPLOY_FROM_CONTAINER` code path removed from `deploy.sh`
