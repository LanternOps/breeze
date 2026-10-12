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
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { inSystemDbContext, probeTelemetryFreshness, readAlertRecovery, telemetryProbeFor, windowElapsed } from './outcomeProbes';

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
    ['rule:metric:cpu:high', { table: 'device_metrics', column: 'cpu_percent' }],
    ['rule:metric:ram:high', { table: 'device_metrics', column: 'ram_percent' }],
    ['rule:metric:memory:high', { table: 'device_metrics', column: 'ram_percent' }],
    ['rule:metric:disk:high', { table: 'device_metrics', column: 'disk_percent' }],
    ['rule:metric:processCount:high', { table: 'device_metrics', column: 'process_count' }],
    ['rule:metric:processes:high', { table: 'device_metrics', column: 'process_count' }],
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

  it('fails closed (null) for a compound rule with a metric/bandwidth/disk-io leaf', () => {
    expect(telemetryProbeFor('rule:and(metric:cpu:high,offline)')).toBeNull();
    expect(telemetryProbeFor('rule:or(bandwidth_high:in,service_stopped)')).toBeNull();
    expect(telemetryProbeFor('rule:and(disk_io_high:read,offline)')).toBeNull();
  });

  it('does not fail closed for a compound rule with no metric/bandwidth/disk-io leaf', () => {
    expect(telemetryProbeFor('rule:and(offline,service_stopped)')).toEqual(CPU);
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

  it('casts device_metrics.timestamp (no tz) to ::timestamp, not ::timestamptz', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    executeRows.push([{ buckets: 40 }]);
    await probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU });
    const q = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0]![0] as never);
    expect(q.sql).toContain('::timestamp ');
    expect(q.sql).not.toContain('::timestamptz');
  });

  it('casts device_process_samples.timestamp (has tz) to ::timestamptz', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    executeRows.push([{ buckets: 40 }]);
    await probeTelemetryFreshness({ deviceId: 'd', from, to, probe: { table: 'device_process_samples', column: 'top_processes' } });
    const q = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0]![0] as never);
    expect(q.sql).toContain('::timestamptz');
  });
});

describe('probeTelemetryFreshness heartbeat boundary (maxHeartbeatAgeMinutes = 30)', () => {
  beforeEach(() => { rows.length = 0; executeRows.length = 0; vi.mocked(db.execute).mockClear(); });
  const edge = to.getTime() - 30 * 60_000;

  it('a heartbeat exactly 30 minutes before hold end is still fresh (strict < comparison)', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date(edge) }]);
    executeRows.push([{ buckets: 48 }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: true, reason: 'ok' });
  });

  it('1ms older than 30 minutes is heartbeat_stale and never reaches the metrics query', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date(edge - 1) }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toEqual({ fresh: false, reason: 'heartbeat_stale', coverage: 0 });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('a device that never reported (lastSeenAt null) is heartbeat_stale', async () => {
    rows.push([{ status: 'online', lastSeenAt: null }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'heartbeat_stale' });
  });
});

describe('probeTelemetryFreshness on unaligned windows (current lenient behaviour, pinned)', () => {
  beforeEach(() => { rows.length = 0; executeRows.length = 0; });
  const seen = (iso: string) => rows.push([{ status: 'online', lastSeenAt: new Date(iso) }]);

  it('expected buckets floors: a 50-minute window expects 1 bucket, so 1 bucket is full coverage', async () => {
    seen('2026-11-01T00:45:00Z');
    executeRows.push([{ buckets: 1 }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to: new Date('2026-11-01T00:50:00Z'), probe: CPU }))
      .resolves.toEqual({ fresh: true, reason: 'ok', coverage: 1 });
  });

  it('a window shorter than one bucket still expects 1 (never divides by zero)', async () => {
    seen('2026-11-01T00:10:00Z');
    executeRows.push([{ buckets: 0 }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to: new Date('2026-11-01T00:10:00Z'), probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'metric_gap', coverage: 0 });
  });

  it('coverage is clamped to 1 when an unaligned window touches more buckets than the floored expectation', async () => {
    seen('2026-11-01T01:10:00Z');
    executeRows.push([{ buckets: 3 }]); // 00:15-01:15 straddles 3 half-hour buckets, expected floor(60/30)=2
    await expect(probeTelemetryFreshness({ deviceId: 'd', from: new Date('2026-11-01T00:15:00Z'), to: new Date('2026-11-01T01:15:00Z'), probe: CPU }))
      .resolves.toEqual({ fresh: true, reason: 'ok', coverage: 1 });
  });

  it('the 0.8 coverage threshold is inclusive (4 of 5 expected buckets is fresh, 3 of 5 is not)', async () => {
    const end = new Date('2026-11-01T02:30:00Z'); // 150 min => 5 buckets
    seen('2026-11-01T02:20:00Z');
    executeRows.push([{ buckets: 4 }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to: end, probe: CPU }))
      .resolves.toMatchObject({ fresh: true, coverage: 0.8 });
    seen('2026-11-01T02:20:00Z');
    executeRows.push([{ buckets: 3 }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to: end, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'metric_gap', coverage: 0.6 });
  });
});

describe('telemetryProbeFor total-direction rules (single column — known limitation, pinned)', () => {
  // A `total` rule fires on in+out; the probe only proves ONE column kept
  // reporting. If this changes to check both columns, update this test.
  it('bandwidth_high:total probes bandwidth_in_bps only', () => {
    expect(telemetryProbeFor('rule:bandwidth_high:total')).toEqual({ table: 'device_metrics', column: 'bandwidth_in_bps' });
  });
  it('disk_io_high:total probes disk_read_bps only', () => {
    expect(telemetryProbeFor('rule:disk_io_high:total')).toEqual({ table: 'device_metrics', column: 'disk_read_bps' });
  });
  it('an unknown direction fails closed', () => {
    expect(telemetryProbeFor('rule:bandwidth_high:sideways')).toBeNull();
  });
});

describe('readAlertRecovery', () => {
  beforeEach(() => { rows.length = 0; });

  it('returns the recovery projection for a resolved alert', async () => {
    const resolvedAt = new Date('2026-11-01T01:00:00Z');
    rows.push([{ status: 'resolved', resolvedAt, resolvedBy: 'u1', resolutionReason: 'auto_recovered' }]);
    await expect(readAlertRecovery('a1')).resolves.toEqual({
      status: 'resolved', resolvedAt, resolvedBy: 'u1', resolutionReason: 'auto_recovered',
    });
  });

  it('returns null when the alert row is gone', async () => {
    rows.push([]);
    await expect(readAlertRecovery('missing')).resolves.toBeNull();
  });

  it('selects only the four recovery columns, filtered by one where and limited to one row', async () => {
    rows.push([]);
    vi.mocked(db.select).mockClear();
    await readAlertRecovery('a1');
    const arg = vi.mocked(db.select).mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(['resolutionReason', 'resolvedAt', 'resolvedBy', 'status']);
    expect((db as unknown as { limit: unknown }).limit).toHaveBeenCalledWith(1);
  });
});

describe('inSystemDbContext', () => {
  beforeEach(() => {
    vi.mocked(getCurrentDbAccessContext).mockReset();
    vi.mocked(runOutsideDbContext).mockClear();
    vi.mocked(withSystemDbAccessContext).mockClear();
  });

  it('reuses an ambient system context: runs fn directly, opens no new context', async () => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValue({ scope: 'system' } as never);
    const fn = vi.fn(async () => 'v');
    await expect(inSystemDbContext(fn, 'label')).resolves.toBe('v');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it.each([
    ['no ambient context', undefined],
    ['an org-scoped ambient context', { scope: 'organization' }],
  ])('opens a fresh system context outside %s, passing the label', async (_n, ctx) => {
    vi.mocked(getCurrentDbAccessContext).mockReturnValue(ctx as never);
    const fn = vi.fn(async () => 'v');
    await expect(inSystemDbContext(fn, 'my-label')).resolves.toBe('v');
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledWith(fn, 'my-label');
  });
});
