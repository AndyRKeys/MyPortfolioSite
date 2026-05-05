import { Router }        from 'express';
import path              from 'path';
import { fileURLToPath } from 'url';
import fs                from 'fs/promises';
import { authenticate }  from '../middleware/authenticate.js';
import { spawnStream, spawnPromise } from '../utils/shell.js';

const router   = Router();
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEPLOY_SCRIPT = path.join(REPO_DIR, 'scripts/deploy/prod-deploy.sh');
// Deploy log lives in $HOME on the Pi — falls back to repo root in dev
const DEPLOY_LOG = path.join(process.env.HOME || REPO_DIR, 'deploy.log');

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

// ── GET /api/deploy/status ───────────────────────────────────────────────────

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
     