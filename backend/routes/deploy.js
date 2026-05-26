import { Router }        from 'express';
import path              from 'path';
import { fileURLToPath } from 'url';
import fs                from 'fs/promises';
import { authenticate }  from '../middleware/authenticate.js';
import { spawnStream, spawnPromise } from '../utils/shell.js';

const router   = Router();
// /repo is the repo root mounted via docker-compose — the backend image only
// contains /app (backend code), so relative path resolution gives / not the repo root.
const REPO_DIR = process.env.REPO_DIR || '/repo';
const DEPLOY_SCRIPT = path.join(REPO_DIR, 'scripts/deploy/deploy.sh');
// DEPLOY_ENV ('dev'|'prod') is required — validated at startup by validateEnv.js
const DEPLOY_ENV = process.env.DEPLOY_ENV;
// deploy.sh writes to $HOME/<env>-deploy.log
const DEPLOY_LOG = path.join(process.env.HOME || REPO_DIR, `${DEPLOY_ENV}-deploy.log`);

// 7–40 hex chars — covers both short and full SHAs
const SHA_RE = /^[0-9a-f]{7,40}$/i;

async function scriptExists() {
  return fs.access(DEPLOY_SCRIPT).then(() => true).catch(() => false);
}

async function recentSHAs() {
  const out = await spawnPromise('git', ['log', '--format=%H', '-20', 'origin/main'], { cwd: REPO_DIR });
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

router.get('/status', authenticate, async (req, res) => {
  try {
    // Fetch silently — ignore errors (offline / no remote access in dev)
    await spawnPromise('git', ['fetch', 'origin', 'main'], { cwd: REPO_DIR }).catch(() => {});

    const [branch, fullSha, message, date, behindRaw] = await Promise.all([
      spawnPromise('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_DIR }),
      spawnPromise('git', ['rev-parse', 'HEAD'],                 { cwd: REPO_DIR }),
      spawnPromise('git', ['log', '-1', '--format=%s', 'HEAD'],  { cwd: REPO_DIR }),
      spawnPromise('git', ['log', '-1', '--format=%ci', 'HEAD'], { cwd: REPO_DIR }),
      spawnPromise('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: REPO_DIR }).catch(() => '0'),
    ]);

    const behind = parseInt(behindRaw.trim(), 10) || 0;
    res.json({
      branch:    branch.trim(),
      head:      { sha: fullSha.trim().slice(0, 7), fullSha: fullSha.trim(), message: message.trim(), date: date.trim() },
      behind,
      upToDate:  behind === 0,
      canDeploy: await scriptExists(),
    });
  } catch (err) {
    // Git commands failing in dev is expected — return read-only status
    res.status(200).json({
      branch:    'unknown',
      head:      { sha: '?', fullSha: '?', message: 'Git unavailable', date: '' },
      behind:    0,
      upToDate:  false,
      canDeploy: false,
      gitError:  err.message,
    });
  }
});

// ── GET /api/deploy/history ───────────────────────────────────────────────────────────

router.get('/history', authenticate, async (req, res) => {
  try {
    const gitOut = await spawnPromise(
      'git', ['log', '--format=%H|%h|%s|%ci', '-10', 'origin/main'],
      { cwd: REPO_DIR }
    ).catch(() => '');

    const commits = gitOut.trim().split('\n').filter(Boolean).map(line => {
      const [sha, shortSha, message, date] = line.split('|');
      return { sha, shortSha, message, date };
    });

    let deployLog = [];
    try {
      const raw = await fs.readFile(DEPLOY_LOG, 'utf8');
      // Strip ANSI escape codes, then parse [YYYY-MM-DD HH:MM:SS] <message>
      // eslint-disable-next-line no-control-regex
      const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
      deployLog = raw.trim().split('\n').filter(Boolean)
        .slice(-20).reverse()
        .map(l => {
          const clean = stripAnsi(l).trim();
          const m = clean.match(/^\[([^\]]+)\]\s*(.*)$/);
          return m ? { ts: m[1], detail: m[2] } : { ts: '', detail: clean };
        })
        .filter(e => e.detail); // skip blank separator lines
    } catch { /* log file may not exist yet */ }

    res.json({ commits, deployLog });
  } catch (err) {
    // Git not available in dev — return empty history gracefully
    res.json({ commits: [], deployLog: [] });
  }
});

// ── POST /api/deploy/fetch ───────────────────────────────────────────────────────────

router.post('/fetch', authenticate, async (req, res) => {
  await streamToSSE(res, spawnStream('git', ['fetch', 'origin'], { cwd: REPO_DIR }));
});

// ── POST /api/deploy ─────────────────────────────────────────────────────────────────────

router.post('/', authenticate, async (req, res) => {
  if (!await scriptExists()) {
    return res.status(400).json({ error: 'Deploy script not found — check DEPLOY_ENV and that deploy.sh is present' });
  }
  await streamToSSE(res, spawnStream('bash', [DEPLOY_SCRIPT, '--env', DEPLOY_ENV], { cwd: REPO_DIR }));
});

// ── POST /api/deploy/rollback ────────────────────────────────────────────────────────────

router.post('/rollback', authenticate, async (req, res) => {
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

  await streamToSSE(res, spawnStream('bash', [DEPLOY_SCRIPT, '--env', DEPLOY_ENV, '--rollback', sha], { cwd: REPO_DIR }));
});

export default router;
