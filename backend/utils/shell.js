import { spawn } from 'child_process';

// Spawns cmd with array args (shell: false always — no user input ever interpolated).
// Yields stdout+stderr lines as an async iterable so callers can stream to SSE.
export async function* spawnStream(cmd, args, { cwd } = {}) {
  const proc = spawn(cmd, args, { cwd, shell: false });

  const pending = [];
  let notify = null;
  let closed = false;

  const push = (line) => {
    if (notify) { const r = notify; notify = null; r(line); }
    else pending.push(line);
  };

  const onData  = (chunk) => chunk.toString().split('\n').filter(Boolean).forEach(push);
  const onClose = ()      => { closed = true; if (notify) { const r = notify; notify = null; r(null); } };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', onClose);

  while (true) {
    if (pending.length) { yield pending.shift(); continue; }
    if (closed) break;
    const line = await new Promise(r => { notify = r; });
    if (line === null) break;
    yield line;
  }
}

// Resolves with combined stdout+stderr, rejects on non-zero exit.
export function spawnPromise(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, shell: false });
    const out  = [];
    proc.stdout.on('data', d => out.push(d.toString()));
    proc.stderr.on('data', d => out.push(d.toString()));
    proc.on('close', code => {
      const text = out.join('');
      if (code === 0) resolve(text);
      else reject(new Error(text || `exit code ${code}`));
    });
  });
}
