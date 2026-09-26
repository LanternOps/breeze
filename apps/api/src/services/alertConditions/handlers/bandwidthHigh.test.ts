import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getRecentMetricsMock } = vi.hoisted(() => ({ getRecentMetricsMock: vi.fn() }));

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return { ...actual, getRecentMetrics: getRecentMetricsMock };
});

import { bandwidthHighHandler } from './bandwidthHigh';

// The agent reports bandwidth in BYTES per second (agent/internal/collectors/
// metrics.go: `BandwidthInBps = NetworkInBytes / elapsed`); authored values are
// megaBITS per second. 1 Mbps = 125_000 bytes/sec.
function sample(inBytesPerSec: number | null, outBytesPerSec: number | null) {
  return {
    bandwidthInBps: inBytesPerSec === null ? null : BigInt(inBytesPerSec),
    bandwidthOutBps: outBytesPerSec === null ? null : BigInt(outBytesPerSec),
  } as never;
}

describe('bandwidthHighHandler', () => {
  beforeEach(() => getRecentMetricsMock.mockReset());

  it('treats agent bytes/sec as 8 bits per byte when comparing to an Mbps threshold', async () => {
    // 15 MB/s inbound = 120 Mbps, which exceeds a 100 Mbps threshold.
    getRecentMetricsMock.mockResolvedValue([sample(15_000_000, 0), sample(15_000_000, 0)]);
    const result = await bandwidthHighHandler.evaluate(
      { type: 'bandwidth_high', direction: 'in', operator: 'gt', value: 100 },
      'dev-1'
    );
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(120);
  });

  it('does not fire when bits/sec stays under the Mbps threshold', async () => {
    // 10 MB/s = 80 Mbps < 100 Mbps.
    getRecentMetricsMock.mockResolvedValue([sample(10_000_000, 0)]);
    const result = await bandwidthHighHandler.evaluate(
      { type: 'bandwidth_high', direction: 'in', operator: 'gt', value: 100 },
      'dev-1'
    );
    expect(result.passed).toBe(false);
    expect(result.actualValue).toBe(80);
  });

  it('sums in + out for direction total and reports the latest sample in Mbps', async () => {
    getRecentMetricsMock.mockResolvedValue([sample(6_250_000, 6_250_000)]); // 50 + 50 Mbps
    const result = await bandwidthHighHandler.evaluate(
      { type: 'bandwidth_high', direction: 'total', operator: 'gte', value: 100 },
      'dev-1'
    );
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(100);
  });

  it('only uses the requested direction', async () => {
    getRecentMetricsMock.mockResolvedValue([sample(0, 25_000_000)]); // out = 200 Mbps
    const inResult = await bandwidthHighHandler.evaluate(
      { type: 'bandwidth_high', direction: 'in', operator: 'gt', value: 100 },
      'dev-1'
    );
    const outResult = await bandwidthHighHandler.evaluate(
      { type: 'bandwidth_high', direction: 'out', operator: 'gt', value: 100 },
      'dev-1'
    );
    expect(inResult.passed).toBe(false);
    expect(outResult.passed).toBe(true);
  });

  it('requires every sample in the window to breach (sustained semantics)', async () => {
    getRecentMetricsMock.mockResolvedValue([sample(15_000_000, 0), sample(1_000_000, 0)]);
    const result = await bandwidthHighHandler.evaluate(
      { type: 'bandwidth_high', direction: 'in', operator: 'gt', value: 100, durationMinutes: 5 },
      'dev-1'
    );
    expect(result.passed).toBe(false);
    expect(getRecentMetricsMock).toHaveBeenCalledWith('dev-1', 5);
  });

  it('reads a null rate (agent omitempty for zero) as 0 Mbps', async () => {
    getRecentMetricsMock.mockResolvedValue([sample(null, null)]);
    const result = await bandwidthHighHandler.evaluate(
      { type: 'bandwidth_high', direction: 'total', operator: 'lt', value: 1 },
      'dev-1'
    );
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(0);
  });

  it('reports no data when the window is empty', async () => {
    getRecentMetricsMock.mockResolvedValue([]);
    const result = await bandwidthHighHandler.evaluate(
      { type: 'bandwidth_high', direction: 'in', operator: 'gt', value: 100 },
      'dev-1'
    );
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });

  it('validates direction/operator/value', () => {
    expect(bandwidthHighHandler.validate!({ direction: 'in', operator: 'gt', value: 1 }, 'c')).toEqual([]);
    expect(bandwidthHighHandler.validate!({ networkDirection: 'in', operator: 'gt', value: 1 }, 'c')).toHaveLength(1);
  });
});
