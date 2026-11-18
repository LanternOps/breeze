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

import { serviceChecksAdapter } from './serviceChecks';

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

const checkRow = (n = 1, text = '2026-11-10 08:00:00.123456') => ({
  id: id(100 + n), deviceId: D1, timestamp: new Date('2026-11-10T08:00:00.123Z'), timestampText: text,
  watchType: 'service', name: 'Spooler', status: 'stopped', cpuPercent: null, memoryMb: null, pid: null,
  autoRestartAttempted: true, autoRestartSucceeded: false,
});

describe('service_checks', () => {
  it('one keyset query: org, device set as one uuid[] param, 30-day default window, desc order', async () => {
    const { sql, params } = await firstQuery(serviceChecksAdapter, req({}));
    expect(sql).toContain('from "service_process_check_results"');
    expect(sql).toMatch(/"org_id" = \$\d+/);
    expect(sql).toMatch(/"device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContainEqual([D1]);
    expect(sql).toMatch(/order by .*"timestamp" desc, .*"id" desc/i);
    expect(params).toContain(new Date('2026-10-14T12:00:00.000Z').toISOString());
    expect(params).toContain(501);
  });

  it('excludes running checks with the literal the partial index is built on', async () => {
    const { sql, params } = await firstQuery(serviceChecksAdapter, req({}));
    expect(sql).toContain(`"status" <> 'running'`);
    expect(params).not.toContain('running');
  });

  it('never selects details', async () => {
    expect((await firstQuery(serviceChecksAdapter, req({}))).sql).not.toContain('"details"');
  });

  it('notes the running-check exclusion', async () => {
    const r = req({});
    exportDeviceSet.mockResolvedValue(scope([D1]));
    await serviceChecksAdapter.createPager(r);
    expect(r.notes).toEqual([
      'service_checks lists checks that were not running (stopped, not_found, error); running checks are not exported.',
    ]);
  });

  it('cursor carries timestamp::text and the next page uses keysetBefore', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([checkRow(1), checkRow(2, '2026-11-09 08:00:00')]).mockResolvedValueOnce([]);
    const pager = await serviceChecksAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/<= \$\d+::timestamp AND \(/);
    expect(second.params).toContain('2026-11-10 08:00:00.123456');
  });

  it('row shape, hostname and redacted name', async () => {
    const [row] = await allRows(serviceChecksAdapter, [{ ...checkRow(), name: 'svc password=hunter2' }]);
    expect(Object.keys(row!)).toEqual([
      'id', 'deviceId', 'hostname', 'timestamp', 'watchType', 'name', 'status', 'cpuPercent', 'memoryMb',
      'pid', 'autoRestartAttempted', 'autoRestartSucceeded',
    ]);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.timestamp).toBe('2026-11-10T08:00:00.123Z');
    expect(row!.name).not.toContain('hunter2');
  });

  it('a process watch named by its full path drops the profile user name', async () => {
    const [row] = await allRows(serviceChecksAdapter, [{ ...checkRow(), watchType: 'process', name: 'C:\\Users\\jdoe\\AppData\\tool.exe' }]);
    expect(row!.name).toBe('C:\\Users\\[REDACTED]\\AppData\\tool.exe');
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await serviceChecksAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('a 181-day range is refused before any query', async () => {
    const r = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(serviceChecksAdapter.createPager(r)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    expect(runExportQuery).not.toHaveBeenCalled();
  });
});
