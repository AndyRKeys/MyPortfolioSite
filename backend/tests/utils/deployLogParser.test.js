import { describe, it, expect } from 'vitest';
import { parseDeployRuns } from '../../utils/deployLogParser.js';

// Builds a minimal complete deploy run block matching the real log format
const makeRun = (n, status = 'ok') => {
  const pad = String(n).padStart(2, '0');
  const endBanner = status === 'ok'
    ? `║  ✅  DEPLOY COMPLETE — dev — 2026-01-${pad} 00:0${n}:00  ║`
    : `║  ❌  DEPLOY FAILED — dev — 2026-01-${pad} 00:0${n}:00  ║`;
  return [
    `║  🚀 Dev Deploy — 2026-01-${pad} 00:00:00  ║`,
    `[deploy:preflight] step=1 status=ok`,
    `[deploy:git] step=2 status=ok sha=abc123${n}`,
    endBanner,
  ].join('\n');
};

describe('parseDeployRuns', () => {
  it('returns empty array for empty log', () => {
    expect(parseDeployRuns('')).toEqual([]);
  });

  it('returns empty array when log has no deploy banners', () => {
    expect(parseDeployRuns('some random log output\nno banners here')).toEqual([]);
  });

  it('parses a single complete ok run', () => {
    const runs = parseDeployRuns(makeRun(1));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('ok');
    expect(runs[0].started_at).toBe('2026-01-01 00:00:00');
    expect(runs[0].ended_at).toBe('2026-01-01 00:01:00');
    expect(runs[0].raw).toContain('Dev Deploy');
  });

  it('parses a failed run with status "failed"', () => {
    const runs = parseDeployRuns(makeRun(1, 'failed'));
    expect(runs[0].status).toBe('failed');
    expect(runs[0].ended_at).toBe('2026-01-01 00:01:00');
  });

  it('returns the last 2 runs newest-first from a log with 3 runs', () => {
    const log = [makeRun(1), makeRun(2), makeRun(3)].join('\n');
    const runs = parseDeployRuns(log);
    expect(runs).toHaveLength(2);
    expect(runs[0].started_at).toBe('2026-01-03 00:00:00');
    expect(runs[1].started_at).toBe('2026-01-02 00:00:00');
  });

  it('discards a partial run (start banner, no end banner)', () => {
    const complete = makeRun(1);
    const partial = `║  🚀 Dev Deploy — 2026-01-02 00:00:00  ║\n[deploy:preflight] step=1 status=ok`;
    const runs = parseDeployRuns([complete, partial].join('\n'));
    expect(runs).toHaveLength(1);
    expect(runs[0].started_at).toBe('2026-01-01 00:00:00');
  });

  it('strips ANSI escape codes from raw output', () => {
    const log = `║  🚀 Dev Deploy — 2026-01-01 00:00:00  ║\n\x1b[32mGreen text\x1b[0m\n║  ✅  DEPLOY COMPLETE — dev — 2026-01-01 00:01:00  ║`;
    const runs = parseDeployRuns(log);
    expect(runs[0].raw).not.toContain('\x1b');
    expect(runs[0].raw).toContain('Green text');
  });

  it('respects a custom limit', () => {
    const log = [makeRun(1), makeRun(2), makeRun(3)].join('\n');
    expect(parseDeployRuns(log, 1)).toHaveLength(1);
    expect(parseDeployRuns(log, 3)).toHaveLength(3);
  });
});
