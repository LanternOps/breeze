import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getRecentMetricsMock } = vi.hoisted(() => ({ getRecentMetricsMock: vi.fn() }));

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return { ...actual, getRecentMetrics: getRecentMetricsMock };
});

import { diskIoHighHandler } from './diskIoHigh';

// Agent disk rates are BYTES per second; authored values are MB/s (10^6 bytes).
function sample(readBytesPerSec: number | null, writeBytesPerSec: number | null) {
  return {
    diskReadBps: readBytesPerSec === null ? null : BigInt(readBytesPerSec),
    diskWriteBps: writeBytesPerSec === null ? null : BigInt(writeBytesPerSec),
  } as never;
}

describe('diskIoHighHandler', () => {
  beforeEach(() => getRecentMetricsMock.mockReset());

  it('compares bytes/sec against an MB/s threshold and reports actualValue in MB/s', async () => {
    getRecentMetricsMock.mockResolvedValue([sample(60_000_000, 0), sample(55_000_000, 0)]);
    const result = await diskIoHighHandler.evaluate(
      { type: 'disk_io_high', direction: 'read', operator: 'gt', value: 50 },
      'dev-1'
    );
    expect(result.passed).toBe(true);
    // The monitor template renders "{{actualValue}} MB/s" — raw bytes/sec here
    // would print "60000000 MB/s".
    expect(result.actualValue).toBe(60);
  });

  it('sums read + write for direction total', async () => {
    getRecentMetricsMock.mockResolvedValue([sample(30_000_000, 30_000_000)]);
    const result = await diskIoHighHandler.evaluate(
      { type: 'disk_io_high', direction: 'total', operator: 'gt', value: 50 },
      'dev-1'
    );
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(60);
  });

  it('does not fire when one sample in the window is under the threshold', async () => {
    getRecentMetricsMock.mockResolvedValue([sample(0, 80_000_000), sample(0, 10_000_000)]);
    const result = await diskIoHighHandler.evaluate(
      { type: 'disk_io_high', direction: 'write', operator: 'gt', value: 50 },
      'dev-1'
    );
    expect(result.passed).toBe(false);
  });

  it('reports no data when the window is empty', async () => {
    getRecentMetricsMock.mockResolvedValue([]);
    const result = await diskIoHighHandler.evaluate(
      { type: 'disk_io_high', direction: 'read', operator: 'gt', value: 50 },
      'dev-1'
    );
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });

  it('rejects the legacy diskDirection field name', () => {
    expect(diskIoHighHandler.validate!({ direction: 'read', operator: 'gt', value: 1 }, 'c')).toEqual([]);
    expect(diskIoHighHandler.validate!({ diskDirection: 'read', operator: 'gt', value: 1 }, 'c')).toHaveLength(1);
  });
});
