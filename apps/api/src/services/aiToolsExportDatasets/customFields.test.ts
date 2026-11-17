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

const readCustomFieldDefinitions = vi.fn();
vi.mock('../aiToolsDevice', () => ({
  readCustomFieldDefinitions: (...a: unknown[]) => readCustomFieldDefinitions(...a),
}));

import { customFieldsAdapter } from './customFields';

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

const def = (key: string, over: Record<string, unknown> = {}) => ({
  id: `def-${key}`, name: `Name ${key}`, fieldKey: key, type: 'text', ...over,
});

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
  readCustomFieldDefinitions.mockReset();
  readCustomFieldDefinitions.mockResolvedValue([def('tier')]);
});
afterEach(() => vi.useRealTimers());

describe('custom_fields', () => {
  it('one keyset query over devices: org, device set as one uuid[] param, id ascending, limit = per-definition page + 1', async () => {
    readCustomFieldDefinitions.mockResolvedValue([def('a'), def('b'), def('c'), def('d')]);
    const { sql, params } = await firstQuery(customFieldsAdapter, req({}, { pageSize: 100 }));
    expect(sql).toContain('from "devices"');
    expect(sql).toMatch(/"devices"\."org_id" = \$\d+/);
    expect(params).toContain('org-1');
    expect(sql).toMatch(/"id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContainEqual([D1]);
    expect(sql).toMatch(/order by "devices"\."id" asc/i);
    // floor(100 / 4) = 25 devices per page, so the query fetches 26
    expect(params).toContain(26);
    expect(params).not.toContain(101);
  });

  it('a definition count above pageSize still pages one device at a time (limit 2)', async () => {
    readCustomFieldDefinitions.mockResolvedValue([def('a'), def('b'), def('c')]);
    const { params } = await firstQuery(customFieldsAdapter, req({}, { pageSize: 2 }));
    expect(params).toContain(2);
  });

  it('calls readCustomFieldDefinitions with the request auth', async () => {
    const r = req();
    await firstQuery(customFieldsAdapter, r);
    expect(readCustomFieldDefinitions).toHaveBeenCalledWith(r.auth);
  });

  it('second page resumes after the last device: "id" > $uuid with the previous last id', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1, D2]));
    runExportQuery
      .mockResolvedValueOnce([{ id: D1, customFields: {} }, { id: D2, customFields: {} }])
      .mockResolvedValueOnce([]);
    const pager = await customFieldsAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(compiled(0).sql).not.toMatch(/"devices"\."id" > /);
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/"devices"\."id" > \$\d+/);
    expect(second.params).toContain(D1);
    expect(second.params).toContain('org-1');
  });

  it('one row per device x definition, exact key order, hostname', async () => {
    readCustomFieldDefinitions.mockResolvedValue([def('tier', { type: 'text' }), def('seats', { type: 'number' })]);
    const rows = await allRows(customFieldsAdapter, [{ id: D1, customFields: { tier: 'gold', seats: 4 } }]);
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]!)).toEqual(['deviceId', 'hostname', 'fieldKey', 'fieldName', 'fieldType', 'value']);
    expect(rows).toEqual([
      { deviceId: D1, hostname: `h-${D1}`, fieldKey: 'tier', fieldName: 'Name tier', fieldType: 'text', value: 'gold' },
      { deviceId: D1, hostname: `h-${D1}`, fieldKey: 'seats', fieldName: 'Name seats', fieldType: 'number', value: 4 },
    ]);
  });

  it('partner-wide definitions (orgId null) produce rows', async () => {
    readCustomFieldDefinitions.mockResolvedValue([def('tier', { orgId: null, partnerId: 'p-1' })]);
    const rows = await allRows(customFieldsAdapter, [{ id: D1, customFields: { tier: 'gold' } }]);
    expect(rows).toEqual([expect.objectContaining({ fieldKey: 'tier', value: 'gold' })]);
  });

  it('string values are redacted, numbers and booleans pass through, objects become JSON text, missing is null', async () => {
    readCustomFieldDefinitions.mockResolvedValue([def('s'), def('n'), def('b'), def('o'), def('m')]);
    const rows = await allRows(customFieldsAdapter, [{
      id: D1,
      customFields: { s: 'note token=abc', n: 0, b: false, o: { k: 'v', password: 'hunter2' } },
    }]);
    const byKey = Object.fromEntries(rows.map((r) => [r.fieldKey, r.value]));
    expect(String(byKey.s)).toContain('[REDACTED]');
    expect(String(byKey.s)).not.toContain('abc');
    expect(byKey.n).toBe(0);
    expect(byKey.b).toBe(false);
    expect(typeof byKey.o).toBe('string');
    expect(String(byKey.o)).toContain('"k"');
    expect(String(byKey.o)).not.toContain('hunter2');
    expect(byKey.m).toBeNull();
  });

  it('a field name is redacted', async () => {
    readCustomFieldDefinitions.mockResolvedValue([def('x', { name: 'Login password=x' })]);
    const [row] = await allRows(customFieldsAdapter, [{ id: D1, customFields: {} }]);
    expect(row!.fieldName).toContain('[REDACTED]');
    expect(row!.fieldName).not.toContain('password=x');
  });

  it('a device with null customFields still yields rows with null values', async () => {
    const [row] = await allRows(customFieldsAdapter, [{ id: D1, customFields: null }]);
    expect(row).toMatchObject({ fieldKey: 'tier', value: null });
  });

  it('no definitions: empty pager, no device query', async () => {
    readCustomFieldDefinitions.mockResolvedValue([]);
    exportDeviceSet.mockResolvedValue(scope([D1]));
    expect(await (await customFieldsAdapter.createPager(req()))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await customFieldsAdapter.createPager(req()))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('no frame but listed deviceIds: exportDeviceSet gets runTargets = deviceIds', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValue([]);
    await customFieldsAdapter.createPager(req({}, { runTargets: null, deviceIds: [D1] }));
    expect((exportDeviceSet.mock.calls[0]![0] as DatasetRequest).runTargets).toEqual([D1]);
  });
});
