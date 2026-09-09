import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, insertCalls, enqueueAlertCorrelationMock, alertsTable, alertCorrelationsTable } = vi.hoisted(() => {
  const alertsTable = { id: 'alerts.id', ruleId: 'alerts.ruleId', deviceId: 'alerts.deviceId', status: 'alerts.status' };
  const alertCorrelationsTable = { id: 'alert_correlations.id' };
  const selectResults: unknown[][] = [];
  const insertReturnResults: unknown[][] = [];
  const dbMock = {
    _selectResults: selectResults,
    _insertReturnResults: insertReturnResults,
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResults.shift() ?? []),
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve(insertReturnResults.shift() ?? [])),
      })),
      _table: table,
    })),
  };
  return {
    dbMock,
    alertsTable,
    alertCorrelationsTable,
    insertCalls: dbMock.insert,
    enqueueAlertCorrelationMock: vi.fn(() => Promise.resolve('correlation-job-1')),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  isNotNull: (col: unknown) => ({ op: 'isNotNull', col }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
}));

vi.mock('../db', () => ({ db: dbMock }));

vi.mock('../db/schema', () => ({
  alerts: alertsTable,
  alertRules: { id: 'alert_rules.id', templateId: 'alert_rules.templateId' },
  alertTemplates: { id: 'alert_templates.id' },
  alertCorrelations: alertCorrelationsTable,
  devices: {},
  deviceGroups: {},
  deviceGroupMemberships: {},
  sites: {},
  configPolicyAlertRules: {},
}));

vi.mock('./alertConditions', () => ({
  evaluateConditions: vi.fn(),
  evaluateAutoResolveConditions: vi.fn(),
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(() => Promise.resolve(false)),
  setCooldown: vi.fn(() => Promise.resolve()),
  isConfigPolicyRuleCooling: vi.fn(),
  markConfigPolicyRuleCooldown: vi.fn(),
  recordStateTransition: vi.fn(() => Promise.resolve()),
  isFlapping: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./featureConfigResolver', () => ({
  resolveAlertRulesForDevice: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(() => Promise.resolve('site-1')) }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: enqueueAlertCorrelationMock }));

import { publishEvent } from './eventBus';
import { createAlert, createSourcedAlert } from './alertService';

describe('createAlert correlation enqueue boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectResults.length = 0;
    dbMock._insertReturnResults.length = 0;
    dbMock._selectResults.push(
      [{ id: 'rule-1', templateId: 'template-1', overrideSettings: null }],
      [{ id: 'template-1', cooldownMinutes: 5 }],
      [],
    );
    dbMock._insertReturnResults.push([{ id: 'alert-1' }]);
  });

  it('enqueues device correlation instead of inserting correlation links inline', async () => {
    const alertId = await createAlert({
      ruleId: 'rule-1',
      deviceId: 'device-1',
      orgId: 'org-1',
      severity: 'critical',
      title: 'CPU high',
      message: 'CPU high on device',
    });

    expect(alertId).toBe('alert-1');
    expect(enqueueAlertCorrelationMock).toHaveBeenCalledWith({ orgId: 'org-1', deviceId: 'device-1' });
    expect(insertCalls).toHaveBeenCalledTimes(1);
    expect(insertCalls).not.toHaveBeenCalledWith(alertCorrelationsTable);
  });
});

describe('createSourcedAlert (#5241 — rule-less alert sources publish alert.triggered)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectResults.length = 0;
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([{ id: 'alert-9' }]);
  });

  it('inserts a rule-less alert and publishes exactly one alert.triggered carrying the source', async () => {
    const triggeredAt = new Date('2026-01-02T03:04:05.000Z');

    const alertId = await createSourcedAlert({
      deviceId: 'device-1',
      orgId: 'org-1',
      severity: 'high',
      title: 'Edge Ping offline',
      message: 'Monitor Edge Ping is offline',
      context: { source: 'network_monitor', monitorId: 'monitor-1' },
      publisher: 'monitor-worker',
      eventPayload: { source: 'network_monitor', monitorId: 'monitor-1' },
      triggeredAt,
    });

    expect(alertId).toBe('alert-9');
    expect(insertCalls).toHaveBeenCalledTimes(1);
    expect(insertCalls).toHaveBeenCalledWith(alertsTable);

    expect(vi.mocked(publishEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
      'alert.triggered',
      'org-1',
      expect.objectContaining({
        alertId: 'alert-9',
        ruleId: null,
        deviceId: 'device-1',
        severity: 'high',
        title: 'Edge Ping offline',
        message: 'Monitor Edge Ping is offline',
        source: 'network_monitor',
        monitorId: 'monitor-1',
      }),
      'monitor-worker',
      { siteId: 'site-1' },
    );

    expect(enqueueAlertCorrelationMock).toHaveBeenCalledWith({ orgId: 'org-1', deviceId: 'device-1' });
  });

  it('returns null and publishes nothing when the insert yields no row', async () => {
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([]);

    const alertId = await createSourcedAlert({
      deviceId: 'device-1',
      orgId: 'org-1',
      severity: 'low',
      title: 't',
      message: 'm',
      context: { source: 'network_monitor' },
      publisher: 'monitor-worker',
    });

    expect(alertId).toBeNull();
    expect(vi.mocked(publishEvent)).not.toHaveBeenCalled();
  });
});
