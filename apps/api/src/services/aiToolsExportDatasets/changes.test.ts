import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';
import type { AnalysisSensitiveGate } from '../../db/schema/aiAgents';
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

import { changeLogAdapter, USER_ACCOUNT_CHANGES_NOTE } from './changes';
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

const changeRow = (n = 1, over: Record<string, unknown> = {}) => ({
  id: id(600 + n), deviceId: D1, timestamp: new Date('2026-11-03T09:00:00.123Z'), timestampText: '2026-11-03 09:00:00.123456',
  changeType: 'software', changeAction: 'added', subject: 'Contoso Agent', beforeValue: null, afterValue: { version: '1.0' },
  details: null,
  ...over,
});
const withGate = (gates: AnalysisSensitiveGate[], filters: Record<string, unknown> = {}) =>
  req(filters, { exportGrants: { datasets: ['change_log'], sensitiveGates: gates } });
const LEGACY_SEVEN = ['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields'];

describe('change_log: user_account_changes gate', () => {
  it('without the gate: user_account rows excluded in SQL (a literal) and the result says so', async () => {
    const r = withGate([]);
    const { sql, params } = await firstQuery(changeLogAdapter, r);
    expect(sql).toContain(`"device_change_log"."change_type" <> 'user_account'`);
    expect(params).not.toContain('user_account');
    expect(r.notes).toEqual([USER_ACCOUNT_CHANGES_NOTE]);
  });

  it('legacy grants (the original seven, no gates) hold no gate', async () => {
    const r = req({}, { exportGrants: { datasets: LEGACY_SEVEN, sensitiveGates: [] } });
    expect((await firstQuery(changeLogAdapter, r)).sql).toContain(`<> 'user_account'`);
  });

  it('the security_events gate is not the user_account_changes gate', async () => {
    const r = withGate(['security_events']);
    expect((await firstQuery(changeLogAdapter, r)).sql).toContain(`<> 'user_account'`);
    expect(r.notes).toEqual([USER_ACCOUNT_CHANGES_NOTE]);
  });

  it('with the gate: no exclusion and no note', async () => {
    const r = withGate(['user_account_changes']);
    const { sql } = await firstQuery(changeLogAdapter, r);
    expect(sql).not.toContain(`'user_account'`);
    expect(r.notes).toEqual([]);
  });

  it('asking only for user_account without the gate: empty export plus note, no query', async () => {
    const r = withGate([], { changeType: ['user_account'] });
    exportDeviceSet.mockResolvedValue(scope([D1]));
    expect(await (await changeLogAdapter.createPager(r))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
    expect(r.notes).toEqual([USER_ACCOUNT_CHANGES_NOTE]);
  });

  it('asking for user_account and another type without the gate: only the other type, with the note', async () => {
    const r = withGate([], { changeType: ['user_account', 'software'] });
    const { sql, params } = await firstQuery(changeLogAdapter, r);
    expect(sql).toContain(`<> 'user_account'`);
    expect(params).toContain('software');
    expect(r.notes).toEqual([USER_ACCOUNT_CHANGES_NOTE]);
  });

  it('with the gate, asking only for user_account queries for it', async () => {
    const r = withGate(['user_account_changes'], { changeType: ['user_account'] });
    const { sql, params } = await firstQuery(changeLogAdapter, r);
    expect(sql).toMatch(/"device_change_log"\."change_type" in \(\$\d+\)/);
    expect(params).toContain('user_account');
  });
});

describe('change_log', () => {
  it('one keyset query: org, device set as one uuid[] param, default window, desc', async () => {
    const { sql, params } = await firstQuery(changeLogAdapter, withGate(['user_account_changes']));
    expect(sql).toContain('from "device_change_log"');
    expect(sql).toMatch(/"device_change_log"\."org_id" = \$\d+/);
    expect(sql).toMatch(/"device_change_log"\."device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContain('org-1');
    expect(params).toContainEqual([D1]);
    expect(params).toContain('2026-10-14T12:00:00.000Z');
    expect(params).toContain('2026-11-13T12:00:00.000Z');
    expect(sql).toMatch(/order by "device_change_log"\."timestamp" desc, "device_change_log"\."id" desc/i);
    expect(params).toContain(501);
  });

  it('never selects fingerprint or created_at', async () => {
    const { sql } = await firstQuery(changeLogAdapter, req({}));
    expect(sql).not.toContain('"fingerprint"');
    expect(sql).not.toContain('"created_at"');
  });

  it('subject and before/after/details are redacted and cut', async () => {
    const [row] = await allRows(changeLogAdapter, [changeRow(1, {
      subject: `svc password=hunter2 ${'s'.repeat(3000)}`,
      beforeValue: { connectionString: 'Server=x;Password=p', path: 'a' }, afterValue: { token: 't' }, details: { apiKey: 'k' },
    })]);
    expect(row!.subject).not.toContain('hunter2');
    expect(Array.from(row!.subject as string).length).toBeLessThanOrEqual(2000);
    expect(row!.beforeValue).toBe(JSON.stringify({ connectionString: '[REDACTED]', path: 'a' }));
    expect(row!.afterValue).toBe(JSON.stringify({ token: '[REDACTED]' }));
    expect(row!.details).toBe(JSON.stringify({ apiKey: '[REDACTED]' }));
  });

  it('paths, user names in paths and URLs inside values are redacted', async () => {
    const [row] = await allRows(changeLogAdapter, [changeRow(1, {
      changeType: 'startup',
      subject: 'C:\\Users\\jdoe\\AppData\\Roaming\\run.exe',
      beforeValue: null,
      afterValue: { command: '/home/jdoe/bin/x --url https://h.example/a?sig=S', share: '\\\\fs01\\finance' },
      details: { url: 'https://u:p@h.example/x?token=t' },
    })]);
    expect(row!.subject).toBe('C:\\Users\\[REDACTED]\\AppData\\Roaming\\run.exe');
    expect(row!.afterValue).not.toMatch(/jdoe|sig=S|fs01/);
    expect(row!.details).not.toMatch(/u:p|token=t/);
  });

  it('a jsonb value over 2000 characters is cut, after redaction', async () => {
    const [row] = await allRows(changeLogAdapter, [changeRow(1, { details: { note: 'x'.repeat(3000), password: 'p' } })]);
    expect(Array.from(row!.details as string).length).toBeLessThanOrEqual(2000);
    expect(row!.details).not.toContain('"p"');
  });

  it('row shape and hostname', async () => {
    const [row] = await allRows(changeLogAdapter, [changeRow()]);
    expect(Object.keys(row!)).toEqual([
      'id', 'deviceId', 'hostname', 'timestamp', 'changeType', 'changeAction', 'subject', 'beforeValue', 'afterValue', 'details',
    ]);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.timestamp).toBe('2026-11-03T09:00:00.123Z');
    expect(row!.beforeValue).toBeNull();
    expect(row!.afterValue).toBe('{"version":"1.0"}');
  });

  it.each([['software'], [['bogus']], [[]], [[1]], [['software', 'nope']]])('filters.changeType %j is refused', async (changeType) => {
    await expect(changeLogAdapter.createPager(req({ changeType }))).rejects.toMatchObject({ code: 'invalid_filter' });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('second page uses keysetBefore on timestamp::text', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([changeRow(1), changeRow(2)]).mockResolvedValueOnce([]);
    const pager = await changeLogAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/"device_change_log"\."timestamp" <= \$\d+::timestamp AND \(/);
    expect(second.params).toContain('2026-11-03 09:00:00.123456');
  });

  it('empty device set: empty pager, no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await changeLogAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('a 181-day range is refused before any query', async () => {
    const r = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(changeLogAdapter.createPager(r)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('requirement carries the gate with the event_logs gate permission', () => {
    expect(EXPORT_DATASET_REQUIREMENTS.change_log).toEqual({
      permission: TOOL_PERMISSIONS.query_change_log,
      sensitiveGate: { gate: 'user_account_changes', permission: { resource: 'devices', action: 'execute' } },
    });
    expect(EXPORT_DATASET_REQUIREMENTS.change_log.sensitiveGate!.permission)
      .toEqual(EXPORT_DATASET_REQUIREMENTS.event_logs.sensitiveGate!.permission);
  });

  it('is tier 1 and set-based', () => {
    expect(changeLogAdapter.tier).toBe(1);
    expect(changeLogAdapter.deviceScoped).toBe(false);
  });
});
