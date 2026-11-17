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

const readCatalog = vi.fn();
const readFindingSoftware = vi.fn();
vi.mock('../aiToolsVulnerability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aiToolsVulnerability')>();
  return {
    ...actual,
    readCatalog: (...a: unknown[]) => readCatalog(...a),
    readFindingSoftware: (...a: unknown[]) => readFindingSoftware(...a),
  };
});

import { vulnerabilitiesAdapter } from './vulnerabilities';

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
  readCatalog.mockReset();
  readCatalog.mockResolvedValue([]);
  readFindingSoftware.mockReset();
  readFindingSoftware.mockResolvedValue(new Map());
});
afterEach(() => vi.useRealTimers());

const finding = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(100 + n), deviceId: D1, vulnerabilityId: id(200 + n), status: 'open', riskScore: '80', ...over,
});
const catalogRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(200 + n), cveId: `CVE-2026-${n}`, severity: 'critical', cvssScore: '9.8', epssScore: '0.9',
  knownExploited: true, patchAvailable: true, ...over,
});

describe('vulnerabilities', () => {
  it('one keyset query: org, device set as one uuid[] param, open status, (device_id, id) ascending, limit pageSize+1', async () => {
    const { sql, params } = await firstQuery(vulnerabilitiesAdapter, req({}, { pageSize: 100 }));
    expect(sql).toContain('from "device_vulnerabilities"');
    expect(sql).toMatch(/"device_vulnerabilities"\."org_id" = \$\d+/);
    expect(params).toContain('org-1');
    expect(sql).toMatch(/"device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContainEqual([D1]);
    expect(sql).toMatch(/"device_vulnerabilities"\."status" = \$\d+/);
    expect(params).toContain('open');
    expect(sql).toMatch(/order by "device_vulnerabilities"\."device_id" asc, "device_vulnerabilities"\."id" asc/i);
    expect(params).toContain(101);
  });

  it('status all adds no status predicate', async () => {
    const all = await firstQuery(vulnerabilitiesAdapter, req({ status: 'all' }));
    expect(all.sql).not.toContain('"status" =');
    expect(all.params).not.toContain('open');
    expect(all.params).not.toContain('all');
  });

  it('status patched binds patched, not the open default', async () => {
    const patched = await firstQuery(vulnerabilitiesAdapter, req({ status: 'patched' }));
    expect(patched.sql).toMatch(/"status" = \$\d+/);
    expect(patched.params).toContain('patched');
    expect(patched.params).not.toContain('open');
  });

  it('second page resumes after the last row: (device_id, id) > ($uuid, $uuid) with its values', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1, D2]));
    runExportQuery
      .mockResolvedValueOnce([finding(1), finding(2, { deviceId: D2 })])
      .mockResolvedValueOnce([]);
    readCatalog.mockResolvedValue([catalogRow(1), catalogRow(2)]);
    const pager = await vulnerabilitiesAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(compiled(0).sql).not.toContain('::uuid)');
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(
      /\("device_vulnerabilities"\."device_id", "device_vulnerabilities"\."id"\) > \(\$\d+::uuid, \$\d+::uuid\)/,
    );
    expect(second.params).toContain(D1);
    expect(second.params).toContain(id(101));
    expect(second.params).toContain('org-1');
    expect(second.params).toContain('open');
  });

  it('a finding with no catalog entry is skipped, but the cursor still advances past it', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    // pageSize 1 -> limit 2: the page holds finding 1, finding 2 is the lookahead.
    // Use pageSize 2 with 3 fetched so the LAST page row (finding 2) has no catalog row.
    runExportQuery.mockResolvedValueOnce([finding(1), finding(2), finding(3)]);
    readCatalog.mockResolvedValue([catalogRow(1), catalogRow(3)]);
    const pager = await vulnerabilitiesAdapter.createPager(req({}, { pageSize: 2 }));
    const page = await pager(null);
    expect(page.rows.map((r) => r.id)).toEqual([id(101)]);
    expect(page.nextCursor).not.toBeNull();
    runExportQuery.mockResolvedValueOnce([]);
    await pager(page.nextCursor);
    // cursor encodes the LAST fetched-page row (finding 2, uncatalogued), not the last exported row
    expect(compiled(1).params).toContain(id(102));
    expect(compiled(1).params).not.toContain(id(101));
  });

  it('catalog and software lookups cover the page rows only, once per page', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([finding(1), finding(2)]);
    readCatalog.mockResolvedValue([catalogRow(1), catalogRow(2)]);
    await (await vulnerabilitiesAdapter.createPager(req()))(null);
    expect(readCatalog).toHaveBeenCalledTimes(1);
    expect(readCatalog.mock.calls[0]![0]).toEqual([id(201), id(202)]);
    expect(readFindingSoftware).toHaveBeenCalledTimes(1);
    expect(readFindingSoftware.mock.calls[0]![0]).toBe('org-1');
    expect(readFindingSoftware.mock.calls[0]![1]).toEqual([id(101), id(102)]);
  });

  it('an empty findings page does no catalog or software lookup', async () => {
    await firstQuery(vulnerabilitiesAdapter, req());
    expect(readCatalog).not.toHaveBeenCalled();
    expect(readFindingSoftware).not.toHaveBeenCalled();
  });

  it('row shape: exact key order, hostname, catalog fields', async () => {
    readCatalog.mockResolvedValue([catalogRow(1)]);
    const [row] = await allRows(vulnerabilitiesAdapter, [finding(1)]);
    expect(Object.keys(row!)).toEqual([
      'id', 'deviceId', 'hostname', 'cveId', 'severity', 'cvssScore', 'epssScore', 'riskScore', 'status',
      'knownExploited', 'patchAvailable', 'softwareName', 'softwareVersion', 'softwareVendor',
    ]);
    expect(row).toMatchObject({
      hostname: `h-${D1}`, cveId: 'CVE-2026-1', severity: 'critical', riskScore: '80', status: 'open',
      knownExploited: true, patchAvailable: true,
    });
  });

  it('null catalog flags default to false', async () => {
    readCatalog.mockResolvedValue([catalogRow(1, { knownExploited: null, patchAvailable: null })]);
    const [row] = await allRows(vulnerabilitiesAdapter, [finding(1)]);
    expect(row).toMatchObject({ knownExploited: false, patchAvailable: false });
  });

  it('software is null when unlinked, set when linked', async () => {
    readCatalog.mockResolvedValue([catalogRow(1), catalogRow(2)]);
    readFindingSoftware.mockResolvedValue(new Map([
      [id(101), { vulnerabilityId: id(201), software: { name: 'Google Chrome', version: '129.0', vendor: 'Google LLC' } }],
      [id(102), { vulnerabilityId: id(202), software: null }],
    ]));
    const rows = await allRows(vulnerabilitiesAdapter, [finding(1), finding(2)]);
    expect(rows[0]).toMatchObject({ softwareName: 'Google Chrome', softwareVersion: '129.0', softwareVendor: 'Google LLC' });
    expect(rows[1]).toMatchObject({ softwareName: null, softwareVersion: null, softwareVendor: null });
  });

  it('software text is redacted', async () => {
    readCatalog.mockResolvedValue([catalogRow(1)]);
    readFindingSoftware.mockResolvedValue(new Map([
      [id(101), { vulnerabilityId: id(201), software: { name: 'Tool password=x', version: '1.0 token=abc', vendor: 'Acme password=x' } }],
    ]));
    const [row] = await allRows(vulnerabilitiesAdapter, [finding(1)]);
    expect(row!.softwareName).toContain('[REDACTED]');
    expect(row!.softwareName).not.toContain('password=x');
    expect(row!.softwareVendor).toContain('[REDACTED]');
    expect(row!.softwareVendor).not.toContain('password=x');
    expect(String(row!.softwareVersion)).not.toContain('abc');
  });

  it('empty device set yields nothing and runs no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await vulnerabilitiesAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('no frame but listed deviceIds: exportDeviceSet gets runTargets = deviceIds', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    await vulnerabilitiesAdapter.createPager(req({}, { runTargets: null, deviceIds: [D1] }));
    expect((exportDeviceSet.mock.calls[0]![0] as DatasetRequest).runTargets).toEqual([D1]);
  });
});
