import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeRows: [] as unknown[][],
  deviceRows: [] as unknown[],
}));

vi.mock('../../db', () => {
  const selectChain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit']) selectChain[method] = () => selectChain;
  selectChain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(mocks.deviceRows).then(resolve);
  return {
    db: {
      execute: vi.fn(async () => mocks.executeRows.shift() ?? []),
      select: vi.fn(() => selectChain),
    },
  };
});

import {
  performanceDeviceSeries,
  performanceOverview,
  performanceRange,
} from './performanceReadModel';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-07T12:00:00.000Z');
const originalRetention = process.env.DEVICE_METRICS_RETENTION_DAYS;

beforeEach(() => {
  mocks.executeRows = [];
  mocks.deviceRows = [];
  delete process.env.DEVICE_METRICS_RETENTION_DAYS;
});

afterEach(() => {
  if (originalRetention === undefined) delete process.env.DEVICE_METRICS_RETENTION_DAYS;
  else process.env.DEVICE_METRICS_RETENTION_DAYS = originalRetention;
});

describe('performanceRange', () => {
  it('uses 5-minute rollups for 24h and hourly rollups for 7d/30d', () => {
    expect(performanceRange('24h', NOW).bucketSeconds).toBe(300);
    expect(performanceRange('7d', NOW).bucketSeconds).toBe(3600);
    expect(performanceRange('30d', NOW).bucketSeconds).toBe(3600);
  });

  it('reports partial raw coverage when configured retention is shorter than the requested range', () => {
    process.env.DEVICE_METRICS_RETENTION_DAYS = '1';
    const result = performanceRange('7d', NOW);
    expect(result.rawCoverage).toEqual({
      complete: false,
      retentionDays: 1,
      requestedFrom: '2026-09-30T12:00:00.000Z',
      coveredFrom: '2026-10-06T12:00:00.000Z',
    });
  });
});

describe('performance output contract', () => {
  it('exposes only the nine allowed rollup metrics and daily network volume', async () => {
    mocks.executeRows = [
      [
        { bucket_start: '2026-10-07 11:55:00', metric_name: 'cpu_percent', avg_value: 22, max_value: 55 },
        { bucket_start: '2026-10-07 11:55:00', metric_name: 'process_count', avg_value: 999, max_value: 999 },
      ],
      [{ day: '2026-10-07 00:00:00', network_in_bytes: '1234', network_out_bytes: '4321', custom_metrics: 'SECRET' }],
    ];

    const result = await performanceOverview(ORG, '24h', NOW);
    expect(Object.keys(result).sort()).toEqual([
      'asOf', 'bucketSeconds', 'dataStatus', 'networkVolume', 'range', 'rawCoverage', 'series',
    ]);
    expect(Object.keys(result.series[0]!.metrics).sort()).toEqual([
      'bandwidthInBps', 'bandwidthOutBps', 'cpuPercent', 'diskPercent', 'diskReadBps',
      'diskUsedGb', 'diskWriteBps', 'ramPercent', 'ramUsedMb',
    ]);
    expect(result.series[0]!.metrics.cpuPercent).toEqual({ average: 22, maximum: 55 });
    expect(JSON.stringify(result)).not.toContain('processCount');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('sanitizes interfaceStats to the closed six-field allowlist', async () => {
    mocks.deviceRows = [{ id: DEVICE, hostname: 'host-a', displayName: null, osType: 'linux' }];
    mocks.executeRows = [
      [],
      [],
      [{
        bucket_start: '2026-10-07 11:55:00', name: 'eth0', speed: 1_000_000_000,
        in_bytes_per_sec: 100, out_bytes_per_sec: 200, in_errors: 3, out_errors: 4,
        in_bytes: 999999, out_bytes: 888888, in_packets: 777, out_packets: 666,
      }],
    ];

    const result = (await performanceDeviceSeries(ORG, DEVICE, '24h', NOW))!;
    expect(Object.keys(result.interfaces[0]!.interfaces[0]!).sort()).toEqual([
      'inBytesPerSec', 'inErrors', 'name', 'outBytesPerSec', 'outErrors', 'speed',
    ]);
    const json = JSON.stringify(result);
    for (const forbidden of ['inBytes"', 'outBytes"', 'inPackets', 'outPackets', 'customMetrics', 'processCount']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('returns null for a device outside the session organization', async () => {
    mocks.deviceRows = [];
    expect(await performanceDeviceSeries(ORG, DEVICE, '24h', NOW)).toBeNull();
    expect(mocks.executeRows).toEqual([]);
  });
});
