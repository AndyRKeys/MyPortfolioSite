// Rolling 60-minute window of per-minute request metrics.
// Module-scope singleton — resets on container restart.
const BUCKET_COUNT = 60;
const BUCKET_MS    = 60_000;

const buckets = [];

function currentBucket() {
  const ts   = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
  const last = buckets.at(-1);
  if (last?.ts === ts) return last;
  const b = { ts, s2xx: 0, s4xx: 0, s5xx: 0, latencies: [] };
  buckets.push(b);
  if (buckets.length > BUCKET_COUNT) buckets.shift();
  return b;
}

export function recordRequest(statusCode, latencyMs) {
  const b   = currentBucket();
  const cls = Math.floor(statusCode / 100);
  if      (cls === 2) b.s2xx++;
  else if (cls === 4) b.s4xx++;
  else if (cls === 5) b.s5xx++;
  b.latencies.push(latencyMs);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function getMetrics() {
  return buckets.map(b => {
    const sorted = [...b.latencies].sort((a, z) => a - z);
    return {
      ts:       b.ts,
      s2xx:     b.s2xx,
      s4xx:     b.s4xx,
      s5xx:     b.s5xx,
      requests: b.latencies.length,
      p50_ms:   percentile(sorted, 50),
      p95_ms:   percentile(sorted, 95),
    };
  });
}

// Only for use in tests — clears all accumulated data.
export function _resetForTesting() {
  buckets.length = 0;
}
