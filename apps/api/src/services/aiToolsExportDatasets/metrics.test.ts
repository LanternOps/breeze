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

import { metricsAdapter } from './metrics';

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
    runTargets: [D1],
    siteId: null,
    pageSize: 500,
    notes: [],
    exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] },
    ...over,
  };
}
const scope = (ids: string[]) => ({ deviceIds: ids, hostnames: new Map(ids.map((d) => [d, `h-${d}`])) });
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
  return (await (await adapter.createPager(r))(null)).rows;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  exportDeviceSet.mockReset();
  runExportQuery.mockReset();
});
afterEach(() => vi.useRealTimers());

const sample = (deviceId: string, text: string, over: Record<string, unknown> = {}) => ({
  deviceId,
  timestamp: new Date('2026-11-13T11:00:00.123Z'),
  timestampText: text,
  cpuPercent: 10,
  ramPercent: 20,
  ramUsedMb: 3000,
  diskPercent: 40,
  diskUsedGb: 50,
  ...over,
});

describe('metrics', () => {
  it('one keyset query: org, device set as one uuid[] param, device/timestamp ascending, limit pageSize+1', async () => {
    const { sql, params } = await firstQuery(metricsAdapter, req({}, { pageSize: 100 }));
    expect(sql).toContain('from "device_metrics"');
    expect(sql).toMatch(/"device_metrics"\."org_id" = \$\d+/);
    expect(params).toContain('org-1');
    expect(sql).toMatch(/"device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContainEqual([D1]);
    expect(sql).toMatch(/order by "device_metrics"\."device_id" asc, "device_metrics"\."timestamp" asc/i);
    expect(sql).toMatch(/limit \$\d+/);
    expect(params).toContain(101);
  });

  it('calls exportDeviceSet exactly once per pager, whatever the page count', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([sample(D1, '2026-11-13 10:00:00.1'), sample(D1, '2026-11-13 10:00:01.1')]).mockResolvedValueOnce([]);
    const pager = await metricsAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    await pager(first.nextCursor);
    expect(exportDeviceSet).toHaveBeenCalledTimes(1);
  });

  it('second page resumes after the last row: (device_id, timestamp) > ($uuid, $timestamp) with the previous last values', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1, D2]));
    runExportQuery
      .mockResolvedValueOnce([
        sample(D1, '2026-11-13 10:00:00.111111'),
        sample(D2, '2026-11-13 10:30:00.222222'),
      ])
      .mockResolvedValueOnce([]);
    const pager = await metricsAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    // first page has no cursor predicate
    expect(compiled(0).sql).not.toContain('::timestamp)');
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(
      /\("device_metrics"\."device_id", "device_metrics"\."timestamp"\) > \(\$\d+::uuid, \$\d+::timestamp\)/,
    );
    expect(second.params).toContain(D1);
    expect(second.params).toContain('2026-11-13 10:00:00.111111');
    // the since floor and org predicate survive the cursor
    expect(second.sql).toMatch(/"device_metrics"\."timestamp" > \$\d+/);
    expect(second.params).toContain('org-1');
  });

  it('a short page yields a null cursor, a full+1 page yields one encoding the last emitted row', async () => {
    const [row] = await allRows(metricsAdapter, [sample(D1, 'x')], req({}, { pageSize: 5 }));
    expect(row).toBeDefined();
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([sample(D1, 'x')]);
    const page = await (await metricsAdapter.createPager(req({}, { pageSize: 5 })))(null);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    ['absent', {}, 24],
    ['zero', { hoursBack: 0 }, 24],
    ['non-numeric', { hoursBack: 'abc' }, 24],
    ['negative clamps up to 1', { hoursBack: -5 }, 1],
    ['six', { hoursBack: 6 }, 6],
    ['500 clamps to 168', { hoursBack: 500 }, 168],
  ])('hoursBack %s binds a floor of now - %i hours', async (_name, filters, hours) => {
    const { params } = await firstQuery(metricsAdapter, req(filters));
    const expected = new Date(NOW.getTime() - hours * 3_600_000).toISOString();
    expect(params).toContain(expected);
  });

  it('row shape: exact key order, ISO timestamp, hostname from the scope', async () => {
    const [row] = await allRows(metricsAdapter, [sample(D1, 't')]);
    expect(Object.keys(row!)).toEqual([
      'deviceId', 'hostname', 'timestamp', 'cpuPercent', 'ramPercent', 'ramUsedMb', 'diskPercent', 'diskUsedGb',
    ]);
    expect(row).toEqual({
      deviceId: D1, hostname: `h-${D1}`, timestamp: '2026-11-13T11:00:00.123Z',
      cpuPercent: 10, ramPercent: 20, ramUsedMb: 3000, diskPercent: 40, diskUsedGb: 50,
    });
  });

  it('a device missing from the hostname map exports hostname null', async () => {
    exportDeviceSet.mockResolvedValue({ deviceIds: [D1], hostnames: new Map() });
    runExportQuery.mockResolvedValue([sample(D1, 't')]);
    const page = await (await metricsAdapter.createPager(req()))(null);
    expect(page.rows[0]!.hostname).toBeNull();
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await metricsAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('no frame but listed deviceIds: exportDeviceSet gets runTargets = deviceIds', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([]);
    await metricsAdapter.createPager(req({}, { runTargets: null, deviceIds: [D1, D2] }));
    const arg = exportDeviceSet.mock.calls[0]![0] as DatasetRequest;
    expect(arg.runTargets).toEqual([D1, D2]);
  });
});
