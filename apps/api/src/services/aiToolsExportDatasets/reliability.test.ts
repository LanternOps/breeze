import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';
import { EXPORT_DATASETS } from '../aiToolsExportDatasetNames';

vi.mock('../../db', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  return {
    db: drizzle.mock(),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

const exportDeviceSet = vi.fn();
const runExportQuery = vi.fn();
vi.mock('../aiToolsExportShared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aiToolsExportShared')>();
  return {
    ...actual,
    exportDeviceSet: (...a: unknown[]) => exportDeviceSet(...a),
    runExportQuery: (...a: unknown[]) => runExportQuery(...a),
  };
});

import { reliabilityScoresAdapter, reliabilityHistoryAdapter } from './reliability';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D1 = id(1);
const D2 = id(2);

function req(filters: Record<string, unknown> = {}, over: Partial<DatasetRequest> = {}): DatasetRequest {
  return {
    auth: { orgId: 'org-1' } as unknown as AuthContext,
    orgId: 'org-1',
    filters,
    deviceIds: null,
    runTargets: [D1, D2],
    siteId: null,
    pageSize: 500,
    notes: [],
    exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] },
    ...over,
  };
}
const scope = (ids: string[]) => ({
  deviceIds: ids,
  hostnames: new Map(ids.map((d) => [d, `h-${d}`])),
});
type Compiled = { sql: string; params: unknown[] };
const compiled = (call: number): Compiled =>
  (runExportQuery.mock.calls[call]![0] as { toSQL(): Compiled }).toSQL();

async function firstQuery(adapter: DatasetAdapter, r: DatasetRequest): Promise<Compiled> {
  exportDeviceSet.mockResolvedValue(scope([D1]));
  runExportQuery.mockResolvedValue([]);
  await (await adapter.createPager(r))(null);
  return compiled(0);
}

async function allRows(adapter: DatasetAdapter, fixtures: unknown[], r: DatasetRequest = req()) {
  exportDeviceSet.mockResolvedValue(scope([D1]));
  runExportQuery.mockResolvedValue(fixtures);
  const pager = await adapter.createPager(r);
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  do {
    const page: { rows: Array<Record<string, unknown>>; nextCursor: string | null } = await pager(cursor);
    out.push(...page.rows);
    cursor = null; // the fixture is one page
  } while (cursor);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  exportDeviceSet.mockReset();
  runExportQuery.mockReset();
});
afterEach(() => vi.useRealTimers());

const SCORE_KEYS = [
  'deviceId', 'hostname', 'siteId', 'osType', 'status', 'computedAt', 'reliabilityScore',
  'uptimeScore', 'crashScore', 'hangScore', 'serviceFailureScore', 'hardwareErrorScore',
  'uptime7d', 'uptime30d', 'uptime90d', 'crashCount7d', 'crashCount30d', 'crashCount90d',
  'hangCount7d', 'hangCount30d', 'hangCount90d', 'serviceFailureCount7d', 'serviceFailureCount30d',
  'hardwareErrorCount7d', 'hardwareErrorCount30d', 'mtbfHours', 'trendDirection', 'trendConfidence',
  'provisional', 'topIssues',
];

const scoreRow = (deviceId: string) => ({
  deviceId, siteId: 's1', osType: 'windows', status: 'online',
  computedAt: new Date('2026-11-13T00:00:00Z'), reliabilityScore: 80,
  uptimeScore: 1, crashScore: 2, hangScore: 3, serviceFailureScore: 4, hardwareErrorScore: 5,
  uptime7d: 99, uptime30d: 98, uptime90d: 97, crashCount7d: 0, crashCount30d: 1, crashCount90d: 2,
  hangCount7d: 0, hangCount30d: 1, hangCount90d: 2, serviceFailureCount7d: 0, serviceFailureCount30d: 1,
  hardwareErrorCount7d: 0, hardwareErrorCount30d: 1, mtbfHours: 12.5, trendDirection: 'stable',
  trendConfidence: 0.5, provisional: false, topIssues: [{ type: 'crashes', count: 1, severity: 'error' }],
});

describe('reliability_scores', () => {
  it('reads the frame through reliabilityListWhere, keyset on device_id, pageSize+1', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1, D2]));
    runExportQuery.mockResolvedValue([]);
    await (await reliabilityScoresAdapter.createPager(req({})))(null);
    const { sql, params } = compiled(0);
    expect(sql).toContain('"device_reliability"."org_id" = $');
    expect(params).toEqual(expect.arrayContaining(['org-1', D1, D2, 501]));
    expect(sql).toMatch(/order by "device_reliability"."device_id" asc/i);
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await reliabilityScoresAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('second page starts strictly after the last device id', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1, D2]));
    runExportQuery.mockResolvedValueOnce([scoreRow(D1), scoreRow(D2)]).mockResolvedValueOnce([]);
    const pager = await reliabilityScoresAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/"device_id" > \$\d+::uuid/);
    expect(second.params).toContain(D1);
  });

  it('validates timeRange and notes that it does not apply', async () => {
    const bad = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(reliabilityScoresAdapter.createPager(bad)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    const ok = req({ timeRange: { start: '2026-10-01T00:00:00Z' } });
    exportDeviceSet.mockResolvedValue(scope([D1]));
    await reliabilityScoresAdapter.createPager(ok);
    expect(ok.notes).toEqual(['reliability_scores is current state; timeRange was not applied.']);
  });

  it('adds no note when no timeRange was supplied', async () => {
    const r = req({});
    exportDeviceSet.mockResolvedValue(scope([D1]));
    await reliabilityScoresAdapter.createPager(r);
    expect(r.notes).toEqual([]);
  });

  it('row carries every window and the hostname from the device set', async () => {
    const [row] = await allRows(reliabilityScoresAdapter, [scoreRow(D1)]);
    expect(Object.keys(row!)).toEqual(SCORE_KEYS);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.computedAt).toBe('2026-11-13T00:00:00.000Z');
    expect(row).not.toHaveProperty('details');
  });
});


const historyRow = (n: number, text = '2026-11-10 00:00:00.123456') => ({
  id: id(100 + n), deviceId: D1, collectedAt: new Date('2026-11-10T00:00:00.123Z'), collectedAtText: text,
  bootTime: new Date('2026-11-01T00:00:00Z'), uptimeSeconds: 1000,
  crashCount: 1, appHangCount: 2, serviceFailureCount: 3, hardwareErrorCount: 4,
});

describe('reliability_history', () => {
  it('one keyset query: org, device set as one uuid[] param, 30-day default window, desc order', async () => {
    const { sql, params } = await firstQuery(reliabilityHistoryAdapter, req({}));
    expect(sql).toMatch(/"org_id" = \$\d+/);
    expect(sql).toMatch(/"device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContainEqual([D1]);
    expect(sql).toMatch(/order by .*"collected_at" desc, .*"id" desc/i);
    expect(params).toContain(new Date('2026-10-14T12:00:00.000Z').toISOString());
    expect(params).toContain(501);
  });

  it('counts are guarded against a non-array jsonb and raw_metrics is not selected', async () => {
    const { sql } = await firstQuery(reliabilityHistoryAdapter, req({}));
    expect(sql).toContain('jsonb_typeof');
    expect(sql).not.toContain('"raw_metrics"');
    expect(sql).toContain("jsonb_array_length");
  });

  it('cursor carries collected_at::text and the next page uses keysetBefore', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([historyRow(1), historyRow(2, '2026-11-09 00:00:00')]).mockResolvedValueOnce([]);
    const pager = await reliabilityHistoryAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/<= \$\d+::timestamp AND \(/);
    expect(second.params).toContain('2026-11-10 00:00:00.123456');
  });

  it('row shape and hostname', async () => {
    const [row] = await allRows(reliabilityHistoryAdapter, [historyRow(1)]);
    expect(Object.keys(row!)).toEqual([
      'id', 'deviceId', 'hostname', 'collectedAt', 'bootTime', 'uptimeSeconds',
      'crashCount', 'appHangCount', 'serviceFailureCount', 'hardwareErrorCount',
    ]);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.collectedAt).toBe('2026-11-10T00:00:00.123Z');
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await reliabilityHistoryAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('a 181-day range is refused before any query', async () => {
    const r = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(reliabilityHistoryAdapter.createPager(r)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    expect(runExportQuery).not.toHaveBeenCalled();
  });
});
