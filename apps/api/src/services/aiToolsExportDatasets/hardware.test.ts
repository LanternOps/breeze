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

import { hardwareEventsAdapter } from './hardware';

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

const hwRow = (n = 1, text = '2026-11-10 08:00:00.123456+00') => ({
  id: id(100 + n), deviceId: D1, occurredAt: new Date('2026-11-10T08:00:00.123Z'), occurredAtText: text,
  componentKey: 'pd:0', componentType: 'physical_disk', componentName: 'Disk 0', model: 'ST1', serial: 'SN1',
  firmware: 'F1', eventType: 'health_changed', fromHealth: 'ok', toHealth: 'warning',
  fromState: 'Online', toState: 'Degraded', detail: { reason: 'smart' },
});

describe('hardware_events', () => {
  it('one keyset query: org, device set as one uuid[] param, 30-day default window, desc order', async () => {
    const { sql, params } = await firstQuery(hardwareEventsAdapter, req({}));
    expect(sql).toContain('from "device_hardware_events"');
    expect(sql).toMatch(/"org_id" = \$\d+/);
    expect(sql).toMatch(/"device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContainEqual([D1]);
    expect(sql).toMatch(/order by .*"occurred_at" desc, .*"id" desc/i);
    expect(params).toContain(new Date('2026-10-14T12:00:00.000Z').toISOString());
    expect(params).toContain(501);
  });

  it('joins the component on device, key and org', async () => {
    const { sql } = await firstQuery(hardwareEventsAdapter, req({}));
    expect(sql).toMatch(/left join "device_hardware_components" .*"component_key".*"org_id"/i);
  });

  it('keyset casts the cursor to timestamptz for a timestamptz column', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery
      .mockResolvedValueOnce([hwRow(1, '2026-11-01 10:00:00.5+00'), hwRow(2, '2026-10-31 10:00:00+00')])
      .mockResolvedValueOnce([]);
    const pager = await hardwareEventsAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toContain('::timestamptz');
    expect(second.params).toContain('2026-11-01 10:00:00.5+00');
  });

  it('row shape and hostname', async () => {
    const [row] = await allRows(hardwareEventsAdapter, [hwRow()]);
    expect(Object.keys(row!)).toEqual([
      'id', 'deviceId', 'hostname', 'occurredAt', 'componentKey', 'componentType', 'componentName', 'model',
      'serial', 'firmware', 'eventType', 'fromHealth', 'toHealth', 'fromState', 'toState', 'detail',
    ]);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.occurredAt).toBe('2026-11-10T08:00:00.123Z');
    expect(row!.detail).toBe('{"reason":"smart"}');
  });

  it('a removed component (no joined row) exports null component columns', async () => {
    const [row] = await allRows(hardwareEventsAdapter, [
      { ...hwRow(), componentName: null, model: null, serial: null, firmware: null },
    ]);
    expect(row).toMatchObject({ componentName: null, model: null, serial: null, firmware: null });
  });

  it('redacts state, name and detail text', async () => {
    const [row] = await allRows(hardwareEventsAdapter, [
      {
        ...hwRow(),
        toState: 'Failed (C:\\Users\\jdoe\\x)',
        componentName: 'C:\\Users\\jdoe\\d',
        detail: { secret: 'x', note: 'ok' },
      },
    ]);
    expect(row!.toState).not.toContain('jdoe');
    expect(row!.componentName).not.toContain('jdoe');
    expect(row!.detail).toContain('[REDACTED]');
    expect(row!.detail).not.toContain('"x"');
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await hardwareEventsAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('a 181-day range is refused before any query', async () => {
    const r = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(hardwareEventsAdapter.createPager(r)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    expect(runExportQuery).not.toHaveBeenCalled();
  });
});
