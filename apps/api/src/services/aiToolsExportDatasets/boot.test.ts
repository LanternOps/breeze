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

import { bootPerformanceAdapter } from './boot';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D1 = id(1);

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

const bootRow = (n = 1, text = '2026-11-10 08:00:00.123456') => ({
  id: id(100 + n), deviceId: D1, bootTimestamp: new Date('2026-11-10T08:00:00.123Z'), bootTimestampText: text,
  biosSeconds: 5, osLoaderSeconds: 6, desktopReadySeconds: 7, totalBootSeconds: 18,
  startupItemCount: 1, startupItems: [] as unknown[],
});

describe('boot_performance', () => {
  it('one keyset query: org, device set as one uuid[] param, 30-day default window, desc order', async () => {
    const { sql, params } = await firstQuery(bootPerformanceAdapter, req({}));
    expect(sql).toContain('from "device_boot_metrics"');
    expect(sql).toMatch(/"org_id" = \$\d+/);
    expect(sql).toMatch(/"device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContainEqual([D1]);
    expect(sql).toMatch(/order by .*"boot_timestamp" desc, .*"id" desc/i);
    expect(params).toContain(new Date('2026-10-14T12:00:00.000Z').toISOString());
    expect(params).toContain(501);
  });

  it('cursor carries boot_timestamp::text and the next page uses keysetBefore', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([bootRow(1), bootRow(2, '2026-11-09 08:00:00')]).mockResolvedValueOnce([]);
    const pager = await bootPerformanceAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/<= \$\d+::timestamp AND \(/);
    expect(second.params).toContain('2026-11-10 08:00:00.123456');
  });

  it('row shape and hostname', async () => {
    const [row] = await allRows(bootPerformanceAdapter, [bootRow()]);
    expect(Object.keys(row!)).toEqual([
      'id', 'deviceId', 'hostname', 'bootTimestamp', 'biosSeconds', 'osLoaderSeconds',
      'desktopReadySeconds', 'totalBootSeconds', 'startupItemCount', 'startupItems',
    ]);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.bootTimestamp).toBe('2026-11-10T08:00:00.123Z');
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await bootPerformanceAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('a 181-day range is refused before any query', async () => {
    const r = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(bootPerformanceAdapter.createPager(r)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('redacts startup item paths and names and keeps the top 100 by impact', async () => {
    const items = Array.from({ length: 150 }, (_, n) => ({
      name: `svc${n} password=p`, type: 'service', path: `C:\\Users\\jdoe\\s${n}.exe`,
      enabled: true, cpuTimeMs: 1, diskIoBytes: 1, impactScore: n,
    }));
    const [row] = await allRows(bootPerformanceAdapter, [{ ...bootRow(), startupItems: items }]);
    const out = row!.startupItems as Array<{ impactScore: number }>;
    expect(out).toHaveLength(100);
    expect(out[0]!.impactScore).toBe(149);
    expect(JSON.stringify(out)).not.toMatch(/jdoe|password=p/);
    expect(Object.keys(out[0]!)).toEqual(['itemId', 'name', 'type', 'path', 'enabled', 'cpuTimeMs', 'diskIoBytes', 'impactScore']);
  });

  it('a malformed startup_items value exports as an empty list, not an error', async () => {
    const [a, b] = await allRows(bootPerformanceAdapter, [
      { ...bootRow(1), startupItems: { not: 'an array' } },
      { ...bootRow(2), startupItems: [null, 3, { name: 'ok', impactScore: 'high' }] },
    ]);
    expect(a!.startupItems).toEqual([]);
    expect(b!.startupItems).toEqual([
      { itemId: null, name: 'ok', type: null, path: null, enabled: null, cpuTimeMs: null, diskIoBytes: null, impactScore: null },
    ]);
  });
});
