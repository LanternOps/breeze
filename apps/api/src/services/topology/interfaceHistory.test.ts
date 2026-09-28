import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { topologyInterfaceHistoryQuerySchema, topologyInterfaceHistoryResponseSchema, type TopologyInterfaceHistoryQuery } from '@breeze/shared';
import type { TopologyRequestContext } from './access';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), authority: vi.fn() }));
vi.mock('../../db', () => ({ db: { execute: mocks.execute, transaction: mocks.transaction } }));
vi.mock('./graphCursor', async (original) => ({ ...await original<object>(), graphAuthority: mocks.authority }));
import {
  buildTopologyInterfaceHistory, getTopologyInterfaceHistory, planTopologyInterfaceHistory,
  type HistoryRawSample, type HistoryRollupRow, type HistorySource,
} from './interfaceHistory';

const IF = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const SOURCE_B = '22222222-2222-4222-8222-333333333333';
const NOW = Date.parse('2026-11-02T12:00:00Z');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const query = (over: Partial<TopologyInterfaceHistoryQuery> & { from: string; to: string }) =>
  topologyInterfaceHistoryQuerySchema.parse({ series: ['in_bps'], ...over });

function raw(atMs: number, octets: number, over: Partial<HistoryRawSample> = {}, readings: Record<string, unknown> = {}): HistoryRawSample {
  return {
    interfaceEpoch: 'gen:1', sourceId: SOURCE, producerEpoch: 'p1', sampledAt: new Date(atMs),
    readings: { v: 1, expectedIntervalSeconds: 60, counterWidth: 64, inOctets: String(octets), outOctets: '0', inErrors: '0', outErrors: '0', inDiscards: '0', outDiscards: '0',
      capacityBps: '1000000', discontinuityTicks: '0', deviceUptimeTicks: String(1_000_000 + Math.floor(atMs / 10)), adminStatus: 'up', operStatus: 'up', ...readings },
    ...over,
  };
}
/** One sample per minute at 1,000 bps (7,500 octets/min). */
const steady = (fromMs: number, toMs: number, over: Partial<HistoryRawSample> = {}) => {
  const out: HistoryRawSample[] = [];
  for (let t = fromMs; t <= toMs; t += MIN) out.push(raw(t, 7500 * ((t - fromMs) / MIN), over));
  return out;
};
const sources: HistorySource[] = [{ id: SOURCE, kind: 'snmp', revoked: false, rollupDirtyFrom: null }, { id: SOURCE_B, kind: 'unifi', revoked: true, rollupDirtyFrom: null }];
const build = (q: TopologyInterfaceHistoryQuery, data: { raw?: HistoryRawSample[]; rollups?: HistoryRollupRow[] }, extra: { sources?: HistorySource[] } = {}) => {
  const plan = planTopologyInterfaceHistory(q, new Date(NOW));
  const response = buildTopologyInterfaceHistory({ plan, query: q, interfaceId: IF, interfaceEpoch: 'gen:1', rawSamples: data.raw ?? [], rollupRows: data.rollups ?? [],
    sources: extra.sources ?? sources, now: new Date(NOW) });
  const parsed = topologyInterfaceHistoryResponseSchema.safeParse(response);
  expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
  return response;
};

describe('planTopologyInterfaceHistory', () => {
  it('auto-selects the finest retained resolution that satisfies the range and bucket cap', () => {
    const plan = (fromAgo: number, toAgo = 0, over: Partial<TopologyInterfaceHistoryQuery> = {}) =>
      planTopologyInterfaceHistory(query({ from: iso(NOW - fromAgo), to: iso(NOW - toAgo), ...over }), new Date(NOW));
    expect(plan(HOUR)).toMatchObject({ resolution: 'raw', bucketMs: 30_000 });
    expect(plan(2 * DAY)).toMatchObject({ resolution: '5m', bucketMs: 300_000 });
    expect(plan(20 * DAY)).toMatchObject({ resolution: '1h', bucketMs: HOUR });
    // 60 days: only hourly is retained that far back; buckets grow in whole hours to stay under 1,000.
    const long = plan(60 * DAY);
    expect(long.resolution).toBe('1h');
    expect(long.bucketMs % HOUR).toBe(0);
    expect(long.buckets).toBeLessThanOrEqual(1000);
    // An old window within 5m's range length but outside its retention falls back to hourly.
    expect(plan(40 * DAY, 39 * DAY)).toMatchObject({ resolution: '1h' });
  });

  it('keeps explicit raw requests raw and enlarges buckets on the raw grid to honor the cap', () => {
    const plan = planTopologyInterfaceHistory(query({ from: iso(NOW - 7 * DAY), to: iso(NOW), resolution: 'raw' }), new Date(NOW));
    expect(plan.resolution).toBe('raw');
    expect(plan.bucketMs % 30_000).toBe(0);
    expect(plan.buckets).toBeLessThanOrEqual(1000);
    const capped = planTopologyInterfaceHistory(query({ from: iso(NOW - HOUR), to: iso(NOW), maxBuckets: 10 }), new Date(NOW));
    expect(capped.buckets).toBeLessThanOrEqual(10);
    expect(capped.from % capped.bucketMs).toBe(0);
  });

  it('never serves the future and records a clamp', () => {
    const plan = planTopologyInterfaceHistory(query({ from: iso(NOW - HOUR), to: iso(NOW + HOUR) }), new Date(NOW));
    expect(plan.to).toBeLessThanOrEqual(NOW + plan.bucketMs);
    expect(plan.reasons).toContain('range_clamped_to_now');
  });
});

describe('buildTopologyInterfaceHistory (raw)', () => {
  it('serves duration-weighted buckets with unit, epoch, source, coverage and gaps on every series', () => {
    const response = build(query({ from: iso(NOW - 30 * MIN), to: iso(NOW), series: ['in_bps', 'in_utilization_pct'] }), { raw: steady(NOW - 40 * MIN, NOW) });
    expect(response.resolution).toBe('raw');
    const bps = response.series.find(s => s.name === 'in_bps')!;
    expect(bps).toMatchObject({ unit: 'bits_per_second', interfaceEpoch: 'gen:1', sourceId: SOURCE, sourceKind: 'snmp', producerEpoch: 'p1', coverage: 'complete', gaps: [] });
    expect(bps.points.every(p => p.value === 1000 && p.min === 1000 && p.max === 1000)).toBe(true);
    expect(response.series.find(s => s.name === 'in_utilization_pct')!.points[0]!.value).toBeCloseTo(0.1);
    expect(response.epochs).toEqual([expect.objectContaining({ interfaceEpoch: 'gen:1', current: true, sourceState: 'active' })]);
    expect(response.coverage).toBe('complete');
  });

  it('breaks the series at an interface generation change and never computes a rate across it', () => {
    const before = steady(NOW - 30 * MIN, NOW - 15 * MIN, { interfaceEpoch: 'gen:1' });
    const after = steady(NOW - 14 * MIN, NOW, { interfaceEpoch: 'gen:2' }).map(s => ({ ...s, readings: { ...s.readings, inOctets: String(BigInt(s.readings.inOctets as string) * 4n) } }));
    const response = build(query({ from: iso(NOW - 30 * MIN), to: iso(NOW) }), { raw: [...before, ...after] });
    const series = response.series.filter(s => s.name === 'in_bps');
    expect(series.map(s => s.interfaceEpoch).sort()).toEqual(['gen:1', 'gen:2']);
    const gen2 = series.find(s => s.interfaceEpoch === 'gen:2')!;
    expect(gen2.points.filter(p => p.value !== null).every(p => p.value === 4000)).toBe(true);
    // No value in either series spans the boundary minute.
    for (const s of series) for (const p of s.points) if (p.value !== null) expect([1000, 4000]).toContain(p.value);
    expect(response.epochs.find(e => e.interfaceEpoch === 'gen:1')!.current).toBe(true);
    expect(response.epochs.find(e => e.interfaceEpoch === 'gen:2')!.current).toBe(false);
    for (const s of series) expect(s.coverage).toBe('partial');
  });

  it('keeps sparse buckets as null with gap reasons, never zero', () => {
    const samples = [...steady(NOW - 30 * MIN, NOW - 20 * MIN), ...steady(NOW - 5 * MIN, NOW).map(s => ({ ...s, readings: { ...s.readings, deviceUptimeTicks: String(9_000_000_000 + Date.parse(s.sampledAt.toISOString()) / 10) } }))];
    const response = build(query({ from: iso(NOW - 30 * MIN), to: iso(NOW), maxBuckets: 30, resolution: 'raw' }), { raw: samples });
    const bps = response.series.find(s => s.name === 'in_bps')!;
    const nulls = bps.points.filter(p => p.value === null);
    expect(nulls.length).toBeGreaterThan(0);
    expect(nulls.every(p => p.reasons.length > 0 && p.validDurationMs === 0)).toBe(true);
    expect(bps.gaps.length).toBeGreaterThan(0);
    expect(bps.gaps[0]!.reason).toBe('gap');
    expect(bps.coverage).toBe('partial');
  });

  it('reports one-sided data and stopped sources honestly', () => {
    const response = build(query({ from: iso(NOW - 30 * MIN), to: iso(NOW) }), { raw: steady(NOW - 30 * MIN, NOW - 20 * MIN, { sourceId: SOURCE_B }) });
    expect(response.series[0]).toMatchObject({ sourceKind: 'unifi', coverage: 'partial' });
    expect(response.epochs[0]).toMatchObject({ sourceState: 'stopped' });
    expect(build(query({ from: iso(NOW - 30 * MIN), to: iso(NOW) }), {})).toMatchObject({ series: [], epochs: [], coverage: 'none', reasons: ['no_measurements'] });
  });

  it('bounds represented epochs and says so', () => {
    const samples = Array.from({ length: 10 }, (_, i) => steady(NOW - (30 - i * 3) * MIN, NOW - (28 - i * 3) * MIN, { producerEpoch: `p${i}` })).flat();
    const response = build(query({ from: iso(NOW - 30 * MIN), to: iso(NOW) }), { raw: samples });
    expect(response.epochs).toHaveLength(8);
    expect(response.reasons).toContain('epochs_truncated');
    expect(response.epochs.map(e => e.producerEpoch)).not.toContain('p0');
  });
});

describe('buildTopologyInterfaceHistory (rollups)', () => {
  const rollup = (atMs: number, mean: number, over: Partial<HistoryRollupRow> = {}): HistoryRollupRow => ({
    interfaceEpoch: 'gen:1', sourceId: SOURCE, producerEpoch: 'p1', bucketStart: new Date(atMs), validDurationMs: 300_000, sampleCount: 5, gapDurationMs: 0,
    readings: { v: 1, kind: 'rollup', bucketMs: 300_000, series: { in_bps: { min: mean - 10, max: mean + 10, mean, validMs: 300_000 } }, capacityBps: null, adminStatus: 'up', operStatus: 'up', stateChanges: 0, invalid: {} },
    ...over,
  });
  it('merges stored buckets by duration without inventing raw values', () => {
    const start = NOW - 2 * DAY;
    const rows = [rollup(start, 100), rollup(start + 300_000, 300)];
    const response = build(query({ from: iso(start), to: iso(NOW), resolution: '5m', maxBuckets: 288 }), { rollups: rows });
    expect(response.resolution).toBe('5m');
    expect(response.interval.bucketSeconds).toBe(600);
    const first = response.series[0]!.points[0]!;
    expect(first).toMatchObject({ value: 200, min: 90, max: 310, validDurationMs: 600_000, sampleCount: 10, gapDurationMs: 0 });
  });

  it('marks not-yet-rolled buckets of an active source as pending, not missing', () => {
    const start = NOW - 2 * DAY;
    const response = build(query({ from: iso(start), to: iso(NOW), resolution: '5m' }), { rollups: [rollup(start, 100)] },
      { sources: [{ id: SOURCE, kind: 'snmp', revoked: false, rollupDirtyFrom: new Date(NOW - HOUR) }] });
    const gaps = response.series[0]!.gaps;
    expect(gaps.at(-1)!.reason).toBe('rollup_pending');
  });
});

describe('getTopologyInterfaceHistory', () => {
  const ORG = '10000000-0000-4000-8000-000000000001';
  const SITE = '20000000-0000-4000-8000-000000000001';
  const ctx = { scope: { orgId: ORG, siteId: SITE } } as unknown as TopologyRequestContext;
  const dialect = new PgDialect();
  const text = (call: unknown[]) => dialect.sqlToQuery(call[0] as Parameters<PgDialect['sqlToQuery']>[0]);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockReset();
    mocks.transaction.mockImplementation((fn) => fn({ execute: mocks.execute }));
    mocks.authority.mockResolvedValue({ digest: 'd', physical: true, interfaceHealth: true, canEdit: false });
  });

  it('verifies the interface in the exact site before reading any sample, and never writes', async () => {
    mocks.execute.mockResolvedValueOnce([]);
    await expect(getTopologyInterfaceHistory(ctx, IF, query({ from: iso(Date.now() - HOUR), to: iso(Date.now()) }))).rejects.toMatchObject({ status: 404 });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const lookup = text(mocks.execute.mock.calls[0]!);
    expect(lookup.params).toEqual(expect.arrayContaining([ORG, SITE, IF]));
    expect(lookup.sql).toMatch(/topology_nodes/);
  });

  it('refuses when interface measurement is not exposed, before any SQL', async () => {
    mocks.authority.mockResolvedValue({ digest: 'd', physical: true, interfaceHealth: false, canEdit: false });
    await expect(getTopologyInterfaceHistory(ctx, IF, query({ from: iso(Date.now() - HOUR), to: iso(Date.now()) }))).rejects.toMatchObject({ status: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid query or interface id before authority or SQL', async () => {
    await expect(getTopologyInterfaceHistory(ctx, 'nope', query({ from: iso(Date.now() - HOUR), to: iso(Date.now()) }))).rejects.toMatchObject({ status: 400 });
    await expect(getTopologyInterfaceHistory(ctx, IF, { series: Array(9).fill('in_bps'), from: iso(0), to: iso(1) } as never)).rejects.toMatchObject({ status: 400 });
    expect(mocks.authority).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('reads only scoped rows with an explicit projection and no writes', async () => {
    const now = Date.now();
    mocks.execute.mockResolvedValueOnce([{ id: IF, epoch: 'gen:1' }])
      .mockResolvedValueOnce(steady(now - 20 * MIN, now - MIN).map(s => ({ interface_epoch: s.interfaceEpoch, source_id: s.sourceId, producer_epoch: s.producerEpoch, sampled_at: s.sampledAt.toISOString(), readings: s.readings })))
      .mockResolvedValueOnce([{ id: SOURCE, producer_kind: 'snmp', revoked: false, rollup_dirty_from: null }]);
    const response = await getTopologyInterfaceHistory(ctx, IF, query({ from: iso(now - 15 * MIN), to: iso(now) }));
    expect(topologyInterfaceHistoryResponseSchema.safeParse(response).success).toBe(true);
    expect(response.series[0]!.points.some(p => p.value === 1000)).toBe(true);
    for (const call of mocks.execute.mock.calls) {
      const q = text(call);
      expect(q.sql).not.toMatch(/\b(insert|update|delete)\b/i);
      expect(q.sql).not.toMatch(/device_commands|select \*/i);
      expect(q.params).toEqual(expect.arrayContaining([ORG, SITE]));
    }
  });
});
