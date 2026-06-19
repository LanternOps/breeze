import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, state, tables } = vi.hoisted(() => {
  const tables = {
    alerts: {
      id: 'alerts.id',
      orgId: 'alerts.orgId',
      deviceId: 'alerts.deviceId',
    },
    alertCorrelations: {
      parentAlertId: 'alert_correlations.parentAlertId',
      childAlertId: 'alert_correlations.childAlertId',
    },
  };

  type Predicate = { op: string; col?: unknown; val?: unknown; vals?: unknown[]; args?: Predicate[] } | undefined;
  const columnKey = (col: unknown) => String(col).split('.').pop()!;
  const evalPredicate = (row: Record<string, unknown>, predicate: Predicate): boolean => {
    if (!predicate) return true;
    if (predicate.op === 'eq') return row[columnKey(predicate.col)] === predicate.val;
    if (predicate.op === 'inArray') return (predicate.vals ?? []).includes(row[columnKey(predicate.col)]);
    if (predicate.op === 'and') return (predicate.args ?? []).every((arg) => evalPredicate(row, arg));
    return true;
  };

  const state = {
    alerts: [] as Array<Record<string, any>>,
    correlations: [] as Array<Record<string, any>>,
  };

  class SelectQuery {
    private predicate: Predicate;
    constructor(private table: unknown) {}
    where(predicate: Predicate) { this.predicate = predicate; return this; }
    then(resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) {
      const source = this.table === tables.alerts ? state.alerts : state.correlations;
      return Promise.resolve(source.filter((row) => evalPredicate(row, this.predicate))).then(resolve, reject);
    }
  }

  const dbMock = {
    select: vi.fn(() => ({
      from: (table: unknown) => new SelectQuery(table),
    })),
    execute: vi.fn(async (_query?: { strings?: TemplateStringsArray; values?: unknown[] }) => [{ id: '99999999-9999-4999-8999-999999999999' }]),
  };

  return { dbMock, state, tables };
});

vi.mock('drizzle-orm', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
  return {
    and: (...args: unknown[]) => ({ op: 'and', args }),
    eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
    inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
    sql,
  };
});

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('../db/schema', () => ({
  alerts: tables.alerts,
  alertCorrelations: tables.alertCorrelations,
}));

import { persistAlertCorrelationGroupsForAlerts } from './alertCorrelationGroups';

const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';
const ALERT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALERT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALERT_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('alert correlation group materializer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.alerts = [
      { id: ALERT_1, orgId: ORG_1, deviceId: 'device-1', ruleId: 'rule-1', status: 'active', severity: 'critical', title: 'CPU high', triggeredAt: new Date('2026-06-18T12:00:00Z'), createdAt: new Date('2026-06-18T12:00:00Z') },
      { id: ALERT_2, orgId: ORG_1, deviceId: 'device-1', ruleId: 'rule-2', status: 'active', severity: 'high', title: 'Memory high', triggeredAt: new Date('2026-06-18T12:02:00Z'), createdAt: new Date('2026-06-18T12:02:00Z') },
      { id: ALERT_3, orgId: ORG_2, deviceId: 'device-1', ruleId: 'rule-3', status: 'active', severity: 'low', title: 'Other org', triggeredAt: new Date('2026-06-18T12:03:00Z'), createdAt: new Date('2026-06-18T12:03:00Z') },
    ];
    state.correlations = [
      { parentAlertId: ALERT_1, childAlertId: ALERT_2, correlationType: 'same_device_temporal', confidence: '0.91', createdAt: new Date('2026-06-18T12:03:00Z') },
      { parentAlertId: ALERT_1, childAlertId: ALERT_3, correlationType: 'same_device_temporal', confidence: '0.88', createdAt: new Date('2026-06-18T12:04:00Z') },
    ];
  });

  it('upserts one group and scoped members without crossing org boundaries', async () => {
    const result = await persistAlertCorrelationGroupsForAlerts({
      orgId: ORG_1,
      alertIds: [ALERT_1, ALERT_2, ALERT_3],
    });

    expect(result).toEqual({ scanned: 2, groupsWritten: 1, membersWritten: 2 });
    expect(dbMock.execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(dbMock.execute.mock.calls)).toContain('ON CONFLICT');
  });

  it('floors noiseReductionPercent so the suppression claim never overstates (3 members => 66)', async () => {
    const ALERT_4 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    state.alerts = [
      { id: ALERT_1, orgId: ORG_1, deviceId: 'device-1', ruleId: 'rule-1', status: 'active', severity: 'critical', title: 'CPU high', triggeredAt: new Date('2026-06-18T12:00:00Z'), createdAt: new Date('2026-06-18T12:00:00Z') },
      { id: ALERT_2, orgId: ORG_1, deviceId: 'device-1', ruleId: 'rule-2', status: 'active', severity: 'high', title: 'Memory high', triggeredAt: new Date('2026-06-18T12:01:00Z'), createdAt: new Date('2026-06-18T12:01:00Z') },
      { id: ALERT_4, orgId: ORG_1, deviceId: 'device-1', ruleId: 'rule-4', status: 'active', severity: 'medium', title: 'Disk high', triggeredAt: new Date('2026-06-18T12:02:00Z'), createdAt: new Date('2026-06-18T12:02:00Z') },
    ];
    state.correlations = [
      { parentAlertId: ALERT_1, childAlertId: ALERT_2, correlationType: 'same_device_temporal', confidence: '0.91', createdAt: new Date('2026-06-18T12:03:00Z') },
      { parentAlertId: ALERT_2, childAlertId: ALERT_4, correlationType: 'same_device_temporal', confidence: '0.85', createdAt: new Date('2026-06-18T12:04:00Z') },
    ];

    const result = await persistAlertCorrelationGroupsForAlerts({
      orgId: ORG_1,
      alertIds: [ALERT_1, ALERT_2, ALERT_4],
    });

    expect(result).toEqual({ scanned: 3, groupsWritten: 1, membersWritten: 3 });
    // The group upsert is the first execute call; its bound values carry noiseReductionPercent.
    const groupInsert = dbMock.execute.mock.calls.find((call) =>
      JSON.stringify(call[0]?.strings ?? []).includes('noise_reduction_percent')
    );
    expect(groupInsert).toBeDefined();
    // (3 - 1) / 3 * 100 = 66.66...; floor => 66 (Math.round would overstate to 67).
    expect(groupInsert![0]?.values).toContain(66);
  });

  it('skips materialization when fewer than two alerts are in scope', async () => {
    const result = await persistAlertCorrelationGroupsForAlerts({
      orgId: ORG_1,
      alertIds: [ALERT_1],
    });

    expect(result).toEqual({ scanned: 1, groupsWritten: 0, membersWritten: 0 });
    expect(dbMock.execute).not.toHaveBeenCalled();
  });
});
