import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, executeRows } = vi.hoisted(() => ({ rows: [] as unknown[][], executeRows: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  (chain as { execute: unknown }).execute = vi.fn(async () => executeRows.shift() ?? []);
  return {
    db: chain,
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { probeTelemetryFreshness, telemetryProbeFor, windowElapsed } from './outcomeProbes';

const CPU = { table: 'device_metrics', column: 'cpu_percent' } as const;

const from = new Date('2026-11-01T00:00:00Z');
const to = new Date('2026-11-02T00:00:00Z'); // 48 half-hour buckets

describe('windowElapsed', () => {
  it('is false strictly before the window and true at/after it', () => {
    expect(windowElapsed(from, 24, new Date('2026-11-01T23:59:59Z'))).toBe(false);
    expect(windowElapsed(from, 24, to)).toBe(true);
  });
});

describe('probeTelemetryFreshness', () => {
  beforeEach(() => { rows.length = 0; executeRows.length = 0; });

  it('fresh when heartbeat is recent and >=80% of buckets have samples', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    executeRows.push([{ buckets: 40 }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toEqual({ fresh: true, reason: 'ok', coverage: 40 / 48 });
  });

  it('metric gap (device reporting heartbeats but most buckets empty) is NOT fresh', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    executeRows.push([{ buckets: 30 }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'metric_gap' });
  });

  it('offline at hold end is NOT fresh even with historical samples', async () => {
    rows.push([{ status: 'offline', lastSeenAt: new Date('2026-11-01T20:00:00Z') }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'heartbeat_stale' });
  });

  it('missing or decommissioned device is NOT fresh', async () => {
    rows.push([]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'device_missing' });
    rows.push([{ status: 'decommissioned', lastSeenAt: to }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'device_decommissioned' });
  });
});

describe('telemetryProbeFor', () => {
  it.each([
    ['anomaly:device_metrics:spike:disk_read', { table: 'device_metrics', column: 'disk_read_bps' }],
    ['anomaly:device_metrics:network_egress:net_out', { table: 'device_metrics', column: 'bandwidth_out_bps' }],
    ['anomaly:device_metrics:memory_growth:ram_used', { table: 'device_metrics', column: 'ram_used_mb' }],
    ['anomaly:device_process_samples:process_runaway:process_cpu', { table: 'device_process_samples', column: 'top_processes' }],
    ['rule:metric:diskPercent:high', { table: 'device_metrics', column: 'disk_percent' }],
    ['rule:bandwidth_high:in', { table: 'device_metrics', column: 'bandwidth_in_bps' }],
    ['rule:disk_io_high:write', { table: 'device_metrics', column: 'disk_write_bps' }],
    ['rule:service_stopped', CPU],
    [null, CPU],
  ] as const)('%s → %o', (condition, probe) => {
    expect(telemetryProbeFor(condition)).toEqual(probe);
  });

  it('fails closed (null) for a metric family it cannot map', () => {
    expect(telemetryProbeFor('anomaly:device_metrics:spike:some_new_metric')).toBeNull();
    expect(telemetryProbeFor('rule:metric:gpuPercent:high')).toBeNull();
  });
});

describe('probeTelemetryFreshness counts only the measurement itself', () => {
  beforeEach(() => { rows.length = 0; executeRows.length = 0; vi.mocked(db.execute).mockClear(); });

  it('queries the family column with IS NOT NULL (a disk_read hold is not proven by CPU/RAM rows)', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    executeRows.push([{ buckets: 0 }]);
    const out = await probeTelemetryFreshness({ deviceId: 'd', from, to, probe: { table: 'device_metrics', column: 'disk_read_bps' } });
    expect(out).toMatchObject({ fresh: false, reason: 'metric_gap' });
    const q = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0]![0] as never);
    expect(q.sql).toContain('"device_metrics"');
    expect(q.sql).toContain('"disk_read_bps" IS NOT NULL');
  });

  it('an unmapped family is metric_unmapped without touching the metrics tables', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: null }))
      .resolves.toEqual({ fresh: false, reason: 'metric_unmapped', coverage: 0 });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('rejects a column outside the allowlist', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: { table: 'device_metrics', column: 'org_id; drop' } }))
      .rejects.toThrow(/not an allowed telemetry column/);
  });
});
