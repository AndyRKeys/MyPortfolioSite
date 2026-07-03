import { Router }        from 'express';
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

// 7–40 hex chars — covers both short and full SHAs
const SHA_RE = /^[0-9a-f]{7,40}$/i;

async function queueDirExists() {
  // Read env var at call time so tests can override it without module reload
  const dir = process.env.DEPLOY_QUEUE_DIR || '/deploy-queue';
  return fs.access(dir).then(() => true).catch(() => false);
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
