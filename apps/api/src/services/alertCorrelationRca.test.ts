import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, state, tables } = vi.hoisted(() => {
  const tables = {
    devices: { id: 'devices.id', orgId: 'devices.orgId', hostname: 'devices.hostname', osType: 'devices.osType' },
    alertCorrelations: {
      parentAlertId: 'alert_correlations.parentAlertId',
      childAlertId: 'alert_correlations.childAlertId',
      correlationType: 'alert_correlations.correlationType',
      confidence: 'alert_correlations.confidence',
      createdAt: 'alert_correlations.createdAt',
    },
    brainDeviceContext: {
      id: 'brainDeviceContext.id',
      orgId: 'brainDeviceContext.orgId',
      deviceId: 'brainDeviceContext.deviceId',
      contextType: 'brainDeviceContext.contextType',
      summary: 'brainDeviceContext.summary',
      details: 'brainDeviceContext.details',
      createdAt: 'brainDeviceContext.createdAt',
      resolvedAt: 'brainDeviceContext.resolvedAt',
    },
    deviceChangeLog: {
      id: 'deviceChangeLog.id',
      orgId: 'deviceChangeLog.orgId',
      deviceId: 'deviceChangeLog.deviceId',
      timestamp: 'deviceChangeLog.timestamp',
      changeType: 'deviceChangeLog.changeType',
      changeAction: 'deviceChangeLog.changeAction',
      subject: 'deviceChangeLog.subject',
    },
    deviceEventLogs: {
      id: 'deviceEventLogs.id',
      orgId: 'deviceEventLogs.orgId',
      deviceId: 'deviceEventLogs.deviceId',
      timestamp: 'deviceEventLogs.timestamp',
      level: 'deviceEventLogs.level',
      category: 'deviceEventLogs.category',
      source: 'deviceEventLogs.source',
      eventId: 'deviceEventLogs.eventId',
      message: 'deviceEventLogs.message',
    },
    agentLogs: {
      id: 'agentLogs.id',
      orgId: 'agentLogs.orgId',
      deviceId: 'agentLogs.deviceId',
      timestamp: 'agentLogs.timestamp',
      level: 'agentLogs.level',
      component: 'agentLogs.component',
      message: 'agentLogs.message',
    },
    metricRollups: {
      orgId: 'metricRollups.orgId',
      sourceTable: 'metricRollups.sourceTable',
      deviceId: 'metricRollups.deviceId',
      bucketSeconds: 'metricRollups.bucketSeconds',
      metricName: 'metricRollups.metricName',
      bucketStart: 'metricRollups.bucketStart',
      avgValue: 'metricRollups.avgValue',
      maxValue: 'metricRollups.maxValue',
    },
  };

  type Predicate = { op: string; col?: unknown; val?: unknown; vals?: unknown[]; args?: Predicate[] } | undefined;
  const columnKey = (col: unknown) => String(col).split('.').pop()!;
  const evalPredicate = (row: Record<string, unknown>, predicate: Predicate): boolean => {
    if (!predicate) return true;
    const left = row[columnKey(predicate.col)];
    if (predicate.op === 'eq') return left === predicate.val;
    if (predicate.op === 'inArray') return (predicate.vals ?? []).includes(left);
    if (predicate.op === 'isNull') return left === null || left === undefined;
    if (predicate.op === 'gte') return new Date(left as any).getTime() >= new Date(predicate.val as any).getTime();
    if (predicate.op === 'lte') return new Date(left as any).getTime() <= new Date(predicate.val as any).getTime();
    if (predicate.op === 'and') return (predicate.args ?? []).every((arg) => evalPredicate(row, arg));
    if (predicate.op === 'or') return (predicate.args ?? []).some((arg) => evalPredicate(row, arg));
    return true;
  };

  const state = {
    devices: [] as Array<Record<string, any>>,
    correlations: [] as Array<Record<string, any>>,
    context: [] as Array<Record<string, any>>,
    changes: [] as Array<Record<string, any>>,
    eventLogs: [] as Array<Record<string, any>>,
    agentLogs: [] as Array<Record<string, any>>,
    metricRollups: [] as Array<Record<string, any>>,
  };

  class SelectQuery {
    private predicate: Predicate;
    constructor(private table: unknown, private projection?: Record<string, unknown>) {}
    where(predicate: Predicate) { this.predicate = predicate; return this; }
    orderBy() { return this; }
    limit(limit: number) { return Promise.resolve(this.rows().slice(0, limit)); }
    then(resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) {
      return Promise.resolve(this.rows()).then(resolve, reject);
    }
    private rows() {
      const source = this.table === tables.devices
        ? state.devices
        : this.table === tables.alertCorrelations
          ? state.correlations
          : this.table === tables.brainDeviceContext
            ? state.context
            : this.table === tables.deviceChangeLog
              ? state.changes
              : this.table === tables.deviceEventLogs
                ? state.eventLogs
                : this.table === tables.agentLogs
                  ? state.agentLogs
                  : state.metricRollups;
      const filtered = source.filter((row) => evalPredicate(row, this.predicate));
      if (!this.projection) return filtered;
      return filtered.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(this.projection!)) {
          out[key] = row[columnKey(this.projection![key])];
        }
        return out;
      });
    }
  }

  const dbMock = {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: (table: unknown) => new SelectQuery(table, projection),
    })),
  };

  return { dbMock, state, tables };
});

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  lte: (col: unknown, val: unknown) => ({ op: 'lte', col, val }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
}));

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('../db/schema', () => ({
  agentLogs: tables.agentLogs,
  alertCorrelations: tables.alertCorrelations,
  brainDeviceContext: tables.brainDeviceContext,
  deviceChangeLog: tables.deviceChangeLog,
  deviceEventLogs: tables.deviceEventLogs,
  devices: tables.devices,
  metricRollups: tables.metricRollups,
}));

import { buildAlertCorrelationRca } from './alertCorrelationRca';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ALERT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALERT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('alert correlation RCA evidence builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.devices = [{ id: DEVICE_ID, orgId: ORG_ID, hostname: 'server-1', osType: 'windows' }];
    state.correlations = [{
      parentAlertId: ALERT_1,
      childAlertId: ALERT_2,
      correlationType: 'same_device_temporal',
      confidence: '0.91',
      createdAt: new Date('2026-06-18T12:03:00Z'),
    }];
    state.context = [{
      id: 'ctx-1',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      contextType: 'issue',
      summary: 'Known CPU contention',
      details: { service: 'backup' },
      createdAt: new Date('2026-06-18T11:00:00Z'),
      resolvedAt: null,
    }];
    state.changes = [{
      id: 'change-1',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      timestamp: new Date('2026-06-18T11:30:00Z'),
      changeType: 'service',
      changeAction: 'modified',
      subject: 'Backup service schedule changed',
    }];
    state.eventLogs = [{
      id: 'event-1',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      timestamp: new Date('2026-06-18T12:01:00Z'),
      level: 'error',
      category: 'system',
      source: 'Service Control Manager',
      eventId: '7031',
      message: 'Service terminated unexpectedly',
    }];
    state.agentLogs = [{
      id: 'agent-1',
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      timestamp: new Date('2026-06-18T12:02:00Z'),
      level: 'error',
      component: 'watchdog.service',
      message: 'Watchdog restart threshold exceeded',
    }];
    state.metricRollups = [{
      orgId: ORG_ID,
      sourceTable: 'device_metrics',
      deviceId: DEVICE_ID,
      bucketSeconds: 300,
      metricName: 'cpu_percent',
      bucketStart: new Date('2026-06-18T12:00:00Z'),
      avgValue: 92,
      maxValue: 99,
    }];
  });

  it('builds bounded evidence and likely-cause candidates for grouped alerts', async () => {
    const result = await buildAlertCorrelationRca({
      orgId: ORG_ID,
      groupId: 'group-1',
      groupScore: 0.91,
      windowHours: 4,
      maxEvidenceItems: 20,
      alerts: [
        { id: ALERT_1, orgId: ORG_ID, deviceId: DEVICE_ID, ruleId: 'rule-1', configPolicyId: null, configItemName: null, status: 'active', severity: 'critical', title: 'CPU high', message: 'CPU over 90%', context: {}, triggeredAt: new Date('2026-06-18T12:00:00Z'), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null, suppressedUntil: null, createdAt: new Date('2026-06-18T12:00:00Z') },
        { id: ALERT_2, orgId: ORG_ID, deviceId: DEVICE_ID, ruleId: 'rule-2', configPolicyId: null, configItemName: null, status: 'active', severity: 'high', title: 'Memory high', message: 'RAM over 90%', context: {}, triggeredAt: new Date('2026-06-18T12:02:00Z'), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null, suppressedUntil: null, createdAt: new Date('2026-06-18T12:02:00Z') },
      ],
    });

    expect(result.scope).toMatchObject({
      orgId: ORG_ID,
      deviceIds: [DEVICE_ID],
      alertIds: [ALERT_1, ALERT_2],
    });
    expect(result.timeline.map((item) => item.source)).toEqual(expect.arrayContaining([
      'alert',
      'correlation',
      'device_change',
      'event_log',
      'agent_log',
      'metric_rollup',
    ]));
    expect(result.rootCauseCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ confidence: 0.91 }),
      expect.objectContaining({ confidence: 0.58 }),
      expect.objectContaining({ confidence: 0.52 }),
    ]));
    expect(result.gaps).toEqual([]);
  });

  it('caps RCA evidence windows relative to old incident time instead of now', async () => {
    state.eventLogs = [
      {
        id: 'event-in-window',
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        timestamp: new Date('2026-01-15T12:15:00Z'),
        level: 'error',
        category: 'system',
        source: 'Service Control Manager',
        eventId: '7031',
        message: 'Incident-window service failure',
      },
      {
        id: 'event-today',
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        timestamp: new Date('2026-06-18T12:15:00Z'),
        level: 'error',
        category: 'system',
        source: 'Service Control Manager',
        eventId: '7031',
        message: 'Unrelated recent failure',
      },
    ];

    const result = await buildAlertCorrelationRca({
      orgId: ORG_ID,
      groupId: 'old-group',
      windowHours: 4,
      maxEvidenceItems: 20,
      alerts: [
        { id: ALERT_1, orgId: ORG_ID, deviceId: DEVICE_ID, ruleId: 'rule-1', configPolicyId: null, configItemName: null, status: 'active', severity: 'critical', title: 'CPU high', message: 'CPU over 90%', context: {}, triggeredAt: new Date('2026-01-15T12:00:00Z'), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null, suppressedUntil: null, createdAt: new Date('2026-01-15T12:00:00Z') },
      ],
    });

    expect(result.scope.windowStart).toBe('2026-01-15T08:00:00.000Z');
    expect(result.scope.windowEnd).toBe('2026-01-15T13:00:00.000Z');
    expect(result.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'event_log:event-in-window' }),
    ]));
    expect(result.timeline).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'event_log:event-today' }),
    ]));
  });
});
