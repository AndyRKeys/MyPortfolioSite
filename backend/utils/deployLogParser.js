// eslint-disable-next-line no-control-regex
const ANSI_RE    = /\x1b\[[0-9;]*m/g;
const stripAnsi  = s => s.replace(ANSI_RE, '');

const START_RE    = /║\s+🚀\s+(?:Dev|Prod) Deploy\s+—\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
const END_OK_RE   = /║\s+✅\s+DEPLOY COMPLETE\s+—\s+\w+\s+—\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
const END_FAIL_RE = /║\s+❌\s+DEPLOY FAILED\s+—\s+\w+\s+—\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

export function parseDeployRuns(logText, limit = 2) {
  if (!limit) return [];
  const lines = logText.split('\n');
  const runs  = [];
  let current = null;

  for (const line of lines) {
    const startMatch = line.match(START_RE);
    if (startMatch) {
      current = { started_at: startMatch[1], lines: [] };
    }
    if (current) {
      current.lines.push(line);
      const okMatch   = line.match(END_OK_RE);
      const failMatch = line.match(END_FAIL_RE);
      if (okMatch || failMatch) {
        const m = okMatch || failMatch;
        runs.push({
          started_at: current.started_at,
          ended_at:   m[1],
          status:     okMatch ? 'ok' : 'failed',
          raw:        stripAnsi(current.lines.join('\n')),
        });
        current = null;
      }
    }
  }

  return runs.slice(-limit).reverse();
}
