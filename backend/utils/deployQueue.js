import fsPromises from 'fs/promises';
import path from 'path';
import { StringDecoder } from 'string_decoder';

// Sentinel pattern that signals deploy completion in the log.
// Anchored to the banner box character (║) printed by print_deploy_status
// (deploy-lib-report.sh) so free text — e.g. a commit message printed during
// Phase 2 "Deployment details" that happens to contain "DEPLOY COMPLETE" —
// can never falsely end the stream early.
const SENTINEL_RE = /║\s+.*DEPLOY (COMPLETE|FAILED|ROLLED BACK) —/;
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
// Buffers partial data across reads so that:
//  - multi-byte UTF-8 chars split at a read boundary are not garbled (StringDecoder)
//  - only complete lines are yielded (no half-written lines from the daemon)
//  - the sentinel is matched per complete line, so it cannot be missed when a
//    write lands across two polls, and ANSI codes cannot break the match
export async function* tailLogFile(logPath, fromByte, signal) {
  let offset = fromByte;
  const deadline = Date.now() + MAX_WAIT_MS;
  const decoder = new StringDecoder('utf8');
  let pending = '';

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

      const lines = (pending + decoder.write(buf)).split('\n');
      pending = lines.pop(); // incomplete tail — kept for the next read

      let sawSentinel = false;
      for (const line of lines) {
        const clean = line.replace(ANSI_RE, '');
        if (clean.trim()) yield clean;
        if (SENTINEL_RE.test(clean)) sawSentinel = true;
      }
      if (sawSentinel) return;
    } else {
      await sleep(POLL_MS);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
