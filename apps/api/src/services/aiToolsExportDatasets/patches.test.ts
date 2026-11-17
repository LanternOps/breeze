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

import {
  patchStateAdapter,
  patchAttemptsAdapter,
  PATCH_STATE_CURRENT_NOTE,
  PATCH_STATE_TIME_RANGE_NOTE,
  PATCH_ATTEMPTS_NO_OUTPUT_NOTE,
} from './patches';
import { EXPORT_DATASET_REQUIREMENTS } from '../aiToolsExportPermissions';
import { TOOL_PERMISSIONS } from '../aiGuardrails';

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

const P1 = id(500);
const P2 = id(501);
const stateRow = (over: Record<string, unknown> = {}) => ({
  id: id(200), deviceId: D1, patchId: P1, source: 'microsoft', externalId: 'KB5034441', title: '2026-11 Cumulative Update',
  severity: 'critical', category: 'Security Updates', releaseDate: '2026-11-11', requiresReboot: true, status: 'pending',
  installedAt: null, installedVersion: null, availableVersion: '10.0.1', lastCheckedAt: new Date('2026-11-12T08:00:00.000Z'),
  failureCount: 0, lastError: null,
  ...over,
});
const attemptRow = (n = 1, over: Record<string, unknown> = {}) => ({
  id: id(300 + n), jobId: id(400), jobName: 'Patch Tuesday', deviceId: D1, patchId: P1, patchTitle: 'KB update',
  patchExternalId: 'KB5034441', status: 'failed', startedAt: new Date('2026-11-05T01:00:00.000Z'),
  completedAt: new Date('2026-11-05T01:10:00.000Z'), exitCode: 1603, rebootRequired: false, rebootedAt: null,
  errorMessage: 'install failed', createdAt: new Date('2026-11-05T00:59:00.123Z'), createdAtText: '2026-11-05 00:59:00.123456',
  ...over,
});

describe('patch_state', () => {
  it('excludes tombstones with a literal, scopes org and device set, keys on (device_id, patch_id)', async () => {
    const { sql, params } = await firstQuery(patchStateAdapter, req({}));
    expect(sql).toMatch(/from "device_patches" inner join "patches" on "patches"\."id" = "device_patches"\."patch_id"/i);
    expect(sql).toContain(`"device_patches"."status" <> 'missing'`);
    expect(sql).toMatch(/"device_patches"\."org_id" = \$\d+/);
    expect(sql).toMatch(/"device_patches"\."device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(sql).toMatch(/order by "device_patches"\."device_id" asc, "device_patches"\."patch_id" asc/i);
    expect(params).toContain('org-1');
    expect(params).toContainEqual([D1]);
    expect(params).not.toContain('missing');
    expect(params).toContain(501);
  });

  it('uses the effective severity/category overlay', async () => {
    const { sql } = await firstQuery(patchStateAdapter, req({}));
    expect(sql).toContain('"device_patches"."reported_severity"');
    expect(sql).toContain('"device_patches"."reported_category"');
  });

  it('never selects install/uninstall/detect scripts, the description, download URL or metadata', async () => {
    const { sql } = await firstQuery(patchStateAdapter, req({}));
    for (const col of ['install_command', 'uninstall_command', 'detect_script', 'description', 'download_url', 'metadata', 'kb_article_url']) {
      expect(sql).not.toContain(`"${col}"`);
    }
  });

  it('lastError: secret straddling the cut is redacted, URL reduced, <= 2000', async () => {
    const [row] = await allRows(patchStateAdapter, [stateRow({ lastError: `${'e'.repeat(1990)} password=hunter2 https://dl.example/x.msi?sig=S` })]);
    expect(row!.lastError).not.toMatch(/hunt|sig=S/);
    expect(Array.from(row!.lastError as string).length).toBeLessThanOrEqual(2000);
  });

  it('lastError keeps the origin and drops profile paths', async () => {
    const [row] = await allRows(patchStateAdapter, [stateRow({ lastError: 'download https://dl.example/x.msi?sig=S to C:\\Users\\jdoe\\Temp failed' })]);
    expect(row!.lastError).toBe('download https://dl.example to C:\\Users\\[REDACTED]\\Temp failed');
  });

  it('title, category and externalId are redacted and cut', async () => {
    const long = 'z'.repeat(2500);
    const [row] = await allRows(patchStateAdapter, [stateRow({
      title: `t token=t1 ${long}`, category: `c token=t2 ${long}`, externalId: `/home/jdoe/pkg token=t3 ${long}`,
    })]);
    for (const col of ['title', 'category', 'externalId'] as const) {
      expect(row![col]).not.toMatch(/t[123]\b/);
      expect(Array.from(row![col] as string).length).toBeLessThanOrEqual(2000);
    }
    expect(row!.externalId).not.toContain('jdoe');
  });

  it('version columns keep dotted versions intact (no address-shape redaction) but drop secrets', async () => {
    const [row] = await allRows(patchStateAdapter, [stateRow({ installedVersion: '8.8.8.8', availableVersion: 'v password=p' })]);
    expect(row!.installedVersion).toBe('8.8.8.8');
    expect(row!.availableVersion).toBe('v password=[REDACTED]');
  });

  it('row shape', async () => {
    const [row] = await allRows(patchStateAdapter, [stateRow()]);
    expect(Object.keys(row!)).toEqual([
      'id', 'deviceId', 'hostname', 'patchId', 'source', 'externalId', 'title', 'severity', 'category', 'releaseDate',
      'requiresReboot', 'status', 'installedAt', 'installedVersion', 'availableVersion', 'lastCheckedAt', 'failureCount', 'lastError',
    ]);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.lastCheckedAt).toBe('2026-11-12T08:00:00.000Z');
    expect(row!.installedAt).toBeNull();
    expect(row!.releaseDate).toBe('2026-11-11');
  });

  it('an unknown severity from the overlay becomes other', async () => {
    const [row] = await allRows(patchStateAdapter, [stateRow({ severity: 'weird' })]);
    expect(row!.severity).toBe('other');
  });

  it('filters.status narrows with a subset of the non-tombstone statuses', async () => {
    const { sql, params } = await firstQuery(patchStateAdapter, req({ status: ['failed', 'pending'] }));
    expect(sql).toMatch(/"device_patches"\."status" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(['failed', 'pending']));
  });

  it.each([[['missing']], ['pending'], [['bogus']], [[]], [[1]]])('filters.status %j is refused', async (status) => {
    await expect(patchStateAdapter.createPager(req({ status }))).rejects.toMatchObject({ code: 'invalid_filter' });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('second page starts after (device_id, patch_id)', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([stateRow(), stateRow({ id: id(201), patchId: P2 })]).mockResolvedValueOnce([]);
    const pager = await patchStateAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toContain('("device_patches"."device_id", "device_patches"."patch_id") > ($');
    expect(second.params).toEqual(expect.arrayContaining([D1, P1]));
  });

  it('always notes current state; notes an unapplied timeRange only when one was supplied', async () => {
    const plain = req({});
    exportDeviceSet.mockResolvedValue(scope([D1]));
    await patchStateAdapter.createPager(plain);
    expect(plain.notes).toEqual([PATCH_STATE_CURRENT_NOTE]);
    const ranged = req({ timeRange: { start: '2026-10-01T00:00:00Z' } });
    await patchStateAdapter.createPager(ranged);
    expect(ranged.notes).toEqual([PATCH_STATE_CURRENT_NOTE, PATCH_STATE_TIME_RANGE_NOTE]);
    const { sql } = await firstQuery(patchStateAdapter, req({ timeRange: { start: '2026-10-01T00:00:00Z' } }));
    expect(sql).not.toContain('"last_checked_at" >=');
  });

  it('an invalid timeRange is still refused', async () => {
    await expect(patchStateAdapter.createPager(req({ timeRange: { start: 'nope' } }))).rejects.toMatchObject({ code: 'invalid_time_range' });
  });

  it('empty device set: empty pager, no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await patchStateAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('requirement equals manage_patches.list', () => {
    expect(EXPORT_DATASET_REQUIREMENTS.patch_state.permission)
      .toEqual((TOOL_PERMISSIONS.manage_patches as Record<string, unknown>).list);
    expect(EXPORT_DATASET_REQUIREMENTS.patch_state.sensitiveGate).toBeUndefined();
  });
});

describe('patch_attempts', () => {
  it('NEVER selects patch_job_results.output, nor the job patches/targets', async () => {
    const { sql } = await firstQuery(patchAttemptsAdapter, req({}));
    expect(sql).not.toMatch(/"output"/);
    expect(sql).not.toContain('"patch_jobs"."patches"');
    expect(sql).not.toContain('"targets"');
  });

  it('scopes org through patch_jobs AND the device set (no org_id on the table)', async () => {
    const { sql, params } = await firstQuery(patchAttemptsAdapter, req({}));
    expect(sql).toMatch(/inner join "patch_jobs" on "patch_jobs"\."id" = "patch_job_results"\."job_id"/i);
    expect(sql).toMatch(/left join "patches" on "patches"\."id" = "patch_job_results"\."patch_id"/i);
    expect(sql).toMatch(/"patch_jobs"\."org_id" = \$\d+/);
    expect(sql).toMatch(/"patch_job_results"\."device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContain('org-1');
    expect(params).toContainEqual([D1]);
  });

  it('order, default window and keyset on created_at', async () => {
    const { sql, params } = await firstQuery(patchAttemptsAdapter, req({}));
    expect(sql).toMatch(/order by "patch_job_results"\."created_at" desc, "patch_job_results"\."id" desc/i);
    expect(params).toContain('2026-10-14T12:00:00.000Z');
    expect(params).toContain('2026-11-13T12:00:00.000Z');
    runExportQuery.mockReset();
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([attemptRow(1), attemptRow(2)]).mockResolvedValueOnce([]);
    const pager = await patchAttemptsAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/"patch_job_results"\."created_at" <= \$\d+::timestamp AND \(/);
    expect(second.params).toContain('2026-11-05 00:59:00.123456');
  });

  it('errorMessage redacted, URL reduced, cut', async () => {
    const [row] = await allRows(patchAttemptsAdapter, [attemptRow(1, {
      errorMessage: `failed: password=p1 https://h.example/a?token=t9 C:\\Users\\jdoe\\x ${'q'.repeat(3000)}`,
    })]);
    expect(row!.errorMessage).not.toMatch(/p1\b|token=t9|jdoe/);
    expect(row!.errorMessage as string).toContain('https://h.example');
    expect(Array.from(row!.errorMessage as string).length).toBeLessThanOrEqual(2000);
  });

  it('jobName, patchTitle and patchExternalId are redacted', async () => {
    const [row] = await allRows(patchAttemptsAdapter, [attemptRow(1, {
      jobName: 'job token=j1', patchTitle: 'title token=j2', patchExternalId: 'ext token=j3',
    })]);
    expect(row!.jobName).toBe('job token=[REDACTED]');
    expect(row!.patchTitle).toBe('title token=[REDACTED]');
    expect(row!.patchExternalId).toBe('ext token=[REDACTED]');
  });

  it('a whole-device summary row (patchId null) is kept with null patch columns', async () => {
    const [row] = await allRows(patchAttemptsAdapter, [attemptRow(1, { patchId: null, patchTitle: null, patchExternalId: null })]);
    expect(row!.patchId).toBeNull();
    expect(row!.patchTitle).toBeNull();
    expect(row!.patchExternalId).toBeNull();
  });

  it('row shape', async () => {
    const [row] = await allRows(patchAttemptsAdapter, [attemptRow()]);
    expect(Object.keys(row!)).toEqual([
      'id', 'jobId', 'jobName', 'deviceId', 'hostname', 'patchId', 'patchTitle', 'patchExternalId', 'status', 'startedAt',
      'completedAt', 'exitCode', 'rebootRequired', 'rebootedAt', 'errorMessage', 'createdAt',
    ]);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.createdAt).toBe('2026-11-05T00:59:00.123Z');
    expect(row!.rebootedAt).toBeNull();
  });

  it('notes the no-raw-output rule', async () => {
    const r = req({});
    exportDeviceSet.mockResolvedValue(scope([D1]));
    await patchAttemptsAdapter.createPager(r);
    expect(r.notes).toEqual([PATCH_ATTEMPTS_NO_OUTPUT_NOTE]);
  });

  it('a 181-day range is refused before any query', async () => {
    const r = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(patchAttemptsAdapter.createPager(r)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('empty device set: empty pager, no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await patchAttemptsAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('requirement equals manage_patches.list and device_history', () => {
    const tool = TOOL_PERMISSIONS.manage_patches as Record<string, unknown>;
    expect(EXPORT_DATASET_REQUIREMENTS.patch_attempts.permission).toEqual(tool.list);
    expect(EXPORT_DATASET_REQUIREMENTS.patch_attempts.permission).toEqual(tool.device_history);
  });

  it('both adapters are tier 1 and set-based', () => {
    for (const a of [patchStateAdapter, patchAttemptsAdapter]) {
      expect(a.tier).toBe(1);
      expect(a.deviceScoped).toBe(false);
    }
  });
});
