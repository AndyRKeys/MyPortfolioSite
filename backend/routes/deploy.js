import { Router }        from 'express';
import path              from 'path';
import { fileURLToPath } from 'url';
import fs                from 'fs/promises';
import { rateLimit }     from 'express-rate-limit';
import { authenticateDeploy } from '../middleware/authenticateDeploy.js';
import { PostgresStore } from '../middleware/postgresStore.js';
import { exemptIfTrusted } from '../utils/serviceKey.js';
import { spawnStream, spawnPromise } from '../utils/shell.js';
import { parseDeployRuns } from '../utils/deployLogParser.js';
import { logger }        from '../utils/logger.js';
import { logAudit }     from '../utils/audit.js';

const router   = Router();

// Limiter precedes authenticateDeploy on every route so CodeQL's
// js/missing-rate-limiting detector sees it before the authorization step.
// exemptIfTrusted skips admin JWT holders (UI polling); service JWTs are
// rate-limited to limit blast radius of a compromised token.
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

// /repo is the repo root mounted via docker-compose — the backend image only
// contains /app (backend code), so relative path resolution gives / not the repo root.
const REPO_DIR = process.env.REPO_DIR || '/repo';
const DEPLOY_SCRIPT = path.join(REPO_DIR, 'scripts/deploy/deploy.sh');
// DEPLOY_ENV ('dev'|'prod') is required — validated at startup by validateEnv.js
const DEPLOY_ENV = process.env.DEPLOY_ENV;
// Deploy log is written to ~/logs/ on the host and mounted read-only at /app/logs
const DEPLOY_LOG = `/app/logs/${DEPLOY_ENV}-deploy.log`;
// prod tracks main; dev tracks dev
const DEPLOY_BRANCH = DEPLOY_ENV === 'prod' ? 'main' : 'dev';

// 7–40 hex chars — covers both short and full SHAs
const SHA_RE = /^[0-9a-f]{7,40}$/i;

async function scriptExists() {
  return fs.access(DEPLOY_SCRIPT).then(() => true).catch(() => false);
}

async function recentSHAs() {
  const out = await spawnPromise('git', ['log', '--format=%H', '-20', `origin/${DEPLOY_BRANCH}`], { cwd: REPO_DIR });
  return out.trim().split('\n').filter(Boolean);
}

// Sends SSE lines from an async iterable, then closes the response
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

// ── GET /api/deploy/status ────────────────────────────────────────────────────────────

router.get('/status', deployReadLimit, authenticateDeploy, async (req, res) => {
  try {
    // Fetch silently — ignore errors (offline / no remote access in dev)
    await spawnPromise('git', ['fetch', 'origin', DEPLOY_BRANCH], { cwd: REPO_DIR }).catch(() => {});

    const [branch, fullSha, message, date, behindRaw] = await Promise.all([
      spawnPromise('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_DIR }),
      spawnPromise('git', ['rev-parse', 'HEAD'],                 { cwd: REPO_DIR }),
      spawnPromise('git', ['log', '-1', '--format=%s', 'HEAD'],  { cwd: REPO_DIR }),
      spawnPromise('git', ['log', '-1', '--format=%ci', 'HEAD'], { cwd: REPO_DIR }),
      spawnPromise('git', ['rev-list', '--count', `HEAD..origin/${DEPLOY_BRANCH}`], { cwd: REPO_DIR }).catch(() => '0'),
    ]);

    const behind = parseInt(behindRaw.trim(), 10) || 0;
    res.json({
      env:        DEPLOY_ENV,
      branch:     branch.trim(),
      head:       { sha: fullSha.trim().slice(0, 7), full_sha: fullSha.trim(), message: message.trim(), date: date.trim() },
      behind,
      up_to_date: behind === 0,
      can_deploy: await scriptExists(),
    });
  } catch (err) {
    // Git commands failing in dev is expected — return read-only status
    res.status(200).json({
      branch:     'unknown',
      head:       { sha: '?', full_sha: '?', message: 'Git unavailable', date: '' },
      behind:     0,
      up_to_date: false,
      can_deploy: false,
      git_error:  err.message,
    });
  }
});

// ── GET /api/deploy/history ───────────────────────────────────────────────────────────

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

// ── POST /api/deploy/fetch ───────────────────────────────────────────────────────────

router.post('/fetch', deployWriteLimit, authenticateDeploy, async (req, res) => {
  await logAudit(req, 'deploy.fetch', 'deploy', null, { env: DEPLOY_ENV });
  await streamToSSE(res, spawnStream('git', ['fetch', 'origin'], { cwd: REPO_DIR }));
});

// ── POST /api/deploy ─────────────────────────────────────────────────────────────────────

router.post('/', deployWriteLimit, authenticateDeploy, async (req, res) => {
  if (!await scriptExists()) {
    return res.status(400).json({ error: 'Deploy script not found — check DEPLOY_ENV and that deploy.sh is present' });
  }
  await logAudit(req, 'deploy.start', 'deploy', null, { env: DEPLOY_ENV });
  await streamToSSE(res, spawnStream('bash', [DEPLOY_SCRIPT, '--env', DEPLOY_ENV], { cwd: REPO_DIR }));
});

// ── POST /api/deploy/rollback ────────────────────────────────────────────────────────────

router.post('/rollback', deployWriteLimit, authenticateDeploy, async (req, res) => {
  const { sha } = req.body || {};

  if (!sha || !SHA_RE.test(sha)) {
    return res.status(400).json({ error: 'Invalid SHA format' });
  }

  // Validate SHA exists in recent history before touching anything
  const known = await recentSHAs().catch(() => []);
  const valid = known.some(s => s === sha || s.startsWith(sha) || sha === s.slice(0, sha.length));
  if (!valid) {
    return res.status(400).json({ error: 'SHA not found in recent commit history — rollback rejected' });
  }

  if (!await scriptExists()) {
    return res.status(400).json({ error: 'Deploy script not found — check DEPLOY_ENV and that deploy.sh is present' });
  }

  await logAudit(req, 'deploy.rollback', 'deploy', null, { env: DEPLOY_ENV, sha });
  await streamToSSE(res, spawnStream('bash', [DEPLOY_SCRIPT, '--env', DEPLOY_ENV, '--rollback', sha], { cwd: REPO_DIR }));
});

export default router;
