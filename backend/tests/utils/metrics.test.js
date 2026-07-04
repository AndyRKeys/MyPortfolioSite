import { describe, it, expect, beforeEach } from 'vitest';
import { recordRequest, getMetrics, _resetForTesting } from '../../utils/metrics.js';

beforeEach(() => _resetForTesting());

describe('getMetrics — empty', () => {
  it('returns an empty array when no requests recorded', () => {
    expect(getMetrics()).toEqual([]);
  });
});

describe('recordRequest + getMetrics', () => {
  it('accumulates status-class counts in current bucket', () => {
    recordRequest(200, 10);
    recordRequest(201, 20);
    recordRequest(404, 5);
    recordRequest(500, 50);

    const buckets = getMetrics();
    expect(buckets).toHaveLength(1);
    expect(buckets[0].s2xx).toBe(2);
    expect(buckets[0].s4xx).toBe(1);
    expect(buckets[0].s5xx).toBe(1);
    expect(buckets[0].requests).toBe(4);
  });

  it('computes p50 correctly', () => {
    // Latencies: 10, 20, 30, 40, 50 — p50 is the median = 30
    [10, 20, 30, 40, 50].forEach(ms => recordRequest(200, ms));
    const [b] = getMetrics();
    expect(b.p50_ms).toBe(30);
  });

  it('computes p95 correctly', () => {
    // 20 values: p95 = index ceil(0.95*20)-1 = ceil(19)-1 = 18 → value at sorted[18]
    Array.from({ length: 20 }, (_, i) => (i + 1) * 10).forEach(ms => recordRequest(200, ms));
    const [b] = getMetrics();
    expect(b.p95_ms).toBe(190); // sorted[18] = 190
  });

  it('returns null p50/p95 when bucket has no requests', () => {
    expect(getMetrics()).toEqual([]);
  });

  it('bucket ts is aligned to the minute boundary', () => {
    recordRequest(200, 10);
    const [b] = getMetrics();
    expect(b.ts % 60_000).toBe(0);
  });

  it('each bucket includes all expected fields', () => {
    recordRequest(200, 100);
    const [b] = getMetrics();
    expect(b).toMatchObject({
      ts:       expect.any(Number),
      s2xx:     expect.any(Number),
      s4xx:     expect.any(Number),
      s5xx:     expect.any(Number),
      requests: expect.any(Number),
      p50_ms:   expect.any(Number),
      p95_ms:   expect.any(Number),
    });
  });
});
