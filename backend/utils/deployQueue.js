import fsPromises from 'fs/promises';
import path from 'path';

// Sentinel patterns that signal deploy completion in the log
const SENTINEL_RE = /DEPLOY (COMPLETE|FAILED|ROLLED BACK)/;
const ANSI_RE     = /\x1b\[[0-9;]*m/g;
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
      try {
        await fh.read(buf, 0, buf.length, offset);
      } finally {
        await fh.close();
      }
      offset = size;

      const chunk = buf.toString('utf8');
      for (const line of chunk.split('\n')) {
        if (line.trim()) yield line.replace(ANSI_RE, '');
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
