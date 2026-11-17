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

import { alertsAdapter, ALERTS_DEVICE_OWNED_NOTE } from './alerts';
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

const alertRow = (n = 1, over: Record<string, unknown> = {}) => ({
  id: id(100 + n), deviceId: D1, ruleId: id(900), ruleName: 'CPU high', severity: 'high', status: 'active',
  title: 'CPU over 90%', message: 'cpu at 95%', triggeredAt: new Date('2026-11-01T10:00:00.123Z'),
  triggeredAtText: '2026-11-01 10:00:00.123456', acknowledgedAt: null, resolvedAt: null, dismissedAt: null,
  suppressedUntil: null, resolutionReason: null,
  ...over,
});

describe('alerts', () => {
  it('one keyset query: org, device-owned literal, device set as one uuid[] param, default window, desc', async () => {
    const { sql, params } = await firstQuery(alertsAdapter, req({}));
    expect(sql).toContain('from "alerts"');
    expect(sql).toMatch(/"alerts"\."org_id" = \$\d+/);
    expect(sql).toContain(`"alerts"."owner_kind" = 'device'`);
    expect(sql).toMatch(/"alerts"\."device_id" = ANY\(\$\d+::uuid\[\]\)/);
    expect(params).toContain('org-1');
    expect(params).toContainEqual([D1]);
    expect(params).not.toContain('device');
    expect(params).toContain('2026-10-14T12:00:00.000Z');
    expect(params).toContain('2026-11-13T12:00:00.000Z');
    expect(sql).toMatch(/order by "alerts"\."triggered_at" desc, "alerts"\."id" desc/i);
    expect(params).toContain(501);
  });

  it('left-joins the rule only for its name', async () => {
    const { sql } = await firstQuery(alertsAdapter, req({}));
    expect(sql).toMatch(/left join "alert_rules" on "alert_rules"\."id" = "alerts"\."rule_id"/i);
  });

  it('never selects context, resolution_note, subject_key, owner_ref or principal columns', async () => {
    const { sql } = await firstQuery(alertsAdapter, req({}));
    for (const col of ['context', 'resolution_note', 'subject_key', 'owner_ref', 'topology_site_id', 'topology_source_key',
      'acknowledged_by', 'resolved_by', 'dismissed_by', 'acknowledged_by_principal_id', 'resolved_by_principal_id',
      'config_item_name']) {
      expect(sql).not.toContain(`"${col}"`);
    }
  });

  it('message: URL reduced to origin, secret redacted, cut to 2000', async () => {
    const [row] = await allRows(alertsAdapter, [alertRow(1, {
      message: `https://acct.blob.core.windows.net/c?sig=SECRET password=hunter2 ${'x'.repeat(3000)}`,
      title: 'Check https://u:p@host.example/path?token=t failed',
    })]);
    expect(row!.message).not.toMatch(/SECRET|hunter2|sig=/);
    expect(row!.message as string).toContain('https://acct.blob.core.windows.net');
    expect(Array.from(row!.message as string).length).toBeLessThanOrEqual(2000);
    expect(row!.title).toBe('Check https://host.example failed');
  });

  it('a secret straddling the 2000-character cut is redacted, never half-emitted', async () => {
    const [row] = await allRows(alertsAdapter, [alertRow(1, { message: `${'m'.repeat(1990)} password=hunter2` })]);
    expect(row!.message).not.toMatch(/hunt|hunter2/);
  });

  it('title and message drop profile paths, user names in paths and UNC hosts', async () => {
    const [row] = await allRows(alertsAdapter, [alertRow(1, {
      title: 'Process C:\\Users\\jdoe\\AppData\\evil.exe stopped',
      message: 'share \\\\fileserver01\\finance unreachable from /home/jdoe/bin',
    })]);
    expect(row!.title).not.toContain('jdoe');
    expect(row!.message).not.toMatch(/jdoe|fileserver01/);
  });

  it('rule name redacted and cut', async () => {
    const [row] = await allRows(alertsAdapter, [alertRow(1, { ruleName: `rule password=p ${'r'.repeat(2500)}` })]);
    expect(row!.ruleName as string).toMatch(/^rule password=\[REDACTED\]/);
    expect(Array.from(row!.ruleName as string).length).toBeLessThanOrEqual(2000);
  });

  it('resolutionReason: a known reason passes, anything else becomes other, null stays null', async () => {
    const rows = await allRows(alertsAdapter, [
      alertRow(1, { resolutionReason: 'condition_cleared' }),
      alertRow(2, { resolutionReason: 'C:\\Users\\jdoe free text' }),
      alertRow(3, { resolutionReason: null }),
    ]);
    expect(rows.map((r) => r.resolutionReason)).toEqual(['condition_cleared', 'other', null]);
  });

  it('row shape and hostname', async () => {
    const [row] = await allRows(alertsAdapter, [alertRow(1, { resolvedAt: new Date('2026-11-02T00:00:00.000Z') })]);
    expect(Object.keys(row!)).toEqual([
      'id', 'deviceId', 'hostname', 'ruleId', 'ruleName', 'severity', 'status', 'title', 'message', 'triggeredAt',
      'acknowledgedAt', 'resolvedAt', 'dismissedAt', 'suppressedUntil', 'resolutionReason',
    ]);
    expect(row!.hostname).toBe(`h-${D1}`);
    expect(row!.triggeredAt).toBe('2026-11-01T10:00:00.123Z');
    expect(row!.resolvedAt).toBe('2026-11-02T00:00:00.000Z');
    expect(row!.acknowledgedAt).toBeNull();
  });

  it('an alert with no rule (or one the run cannot see) exports a null ruleName', async () => {
    const [row] = await allRows(alertsAdapter, [alertRow(1, { ruleId: null, ruleName: null })]);
    expect(row!.ruleName).toBeNull();
  });

  it('empty device set: empty pager, no query', async () => {
    exportDeviceSet.mockResolvedValue(scope([]));
    expect(await (await alertsAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('second page uses keysetBefore on triggered_at::text', async () => {
    exportDeviceSet.mockResolvedValue(scope([D1]));
    runExportQuery.mockResolvedValueOnce([alertRow(1), alertRow(2)]).mockResolvedValueOnce([]);
    const pager = await alertsAdapter.createPager(req({}, { pageSize: 1 }));
    const first = await pager(null);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    await pager(first.nextCursor);
    const second = compiled(1);
    expect(second.sql).toMatch(/"alerts"\."triggered_at" <= \$\d+::timestamp AND \(/);
    expect(second.params).toContain('2026-11-01 10:00:00.123456');
    expect(second.params).toContain(id(101));
  });

  it('a 181-day range is refused before any query', async () => {
    const r = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    await expect(alertsAdapter.createPager(r)).rejects.toMatchObject({ code: 'invalid_time_range' });
    expect(exportDeviceSet).not.toHaveBeenCalled();
    expect(runExportQuery).not.toHaveBeenCalled();
  });

  it('requirement equals manage_alerts.list', () => {
    expect(EXPORT_DATASET_REQUIREMENTS.alerts.permission)
      .toEqual((TOOL_PERMISSIONS.manage_alerts as Record<string, unknown>).list);
    expect(EXPORT_DATASET_REQUIREMENTS.alerts.sensitiveGate).toBeUndefined();
  });

  it('notes the device-owned rule', async () => {
    const r = req({});
    exportDeviceSet.mockResolvedValue(scope([D1]));
    await alertsAdapter.createPager(r);
    expect(r.notes).toEqual([ALERTS_DEVICE_OWNED_NOTE]);
  });

  it('is tier 1 and not device-scoped (set-based)', () => {
    expect(alertsAdapter.tier).toBe(1);
    expect(alertsAdapter.deviceScoped).toBe(false);
  });
});
