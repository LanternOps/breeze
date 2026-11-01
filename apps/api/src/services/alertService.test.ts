import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbMock,
  insertCalls,
  deleteCalls,
  captureExceptionMock,
  enqueueAlertCorrelationMock,
  alertsTable,
  alertCorrelationsTable,
} = vi.hoisted(() => {
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
      values: vi.fn(() => {
        const statement = {
          returning: vi.fn(() => Promise.resolve(insertReturnResults.shift() ?? [])),
          onConflictDoNothing: vi.fn(() => statement),
        };
        return statement;
      }),
      _table: table,
    })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({
      returning: () => Promise.resolve(selectResults.shift() ?? []),
    }) }) })),
    execute: vi.fn(() => Promise.resolve(insertReturnResults.shift() ?? [])),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(undefined)),
    })),
  };
  return {
    dbMock,
    alertsTable,
    alertCorrelationsTable,
    insertCalls: dbMock.insert,
    deleteCalls: dbMock.delete,
    captureExceptionMock: vi.fn(),
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
  // #5289: the module graph now reaches schema files that call sql`` at
  // import time (monitorResolver -> db/schema/*), so the drizzle mock has to
  // provide it or the whole suite fails to load.
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
    { join: (...args: unknown[]) => ({ op: 'sqlJoin', args }), raw: (s: string) => ({ op: 'raw', s }) },
  ),
  asc: (col: unknown) => ({ op: 'asc', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
}));

// The monitor branch of getApplicableRules has its own coverage
// (monitorResolver.test.ts + monitorResolver.integration.test.ts); stubbing it
// here keeps this suite's device fixtures from needing policy tables.
vi.mock('./monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: vi.fn(() => Promise.resolve({ kind: 'resolved', monitors: [] })),
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
  monitorDefinitions: { id: 'monitor_definitions.id' },
}));

vi.mock('./alertConditions', () => ({
  evaluateConditions: vi.fn(),
  evaluateAutoResolveConditions: vi.fn(),
  interpolateTemplate: vi.fn((template: string) => template),
}));

vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(() => Promise.resolve(false)),
  setCooldown: vi.fn(() => Promise.resolve()),
  recordStateTransition: vi.fn(() => Promise.resolve()),
  isFlapping: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(() => Promise.resolve('site-1')) }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: enqueueAlertCorrelationMock }));

import { publishEvent } from './eventBus';
import { setCooldown } from './alertCooldown';
import { resolveDeviceSiteId } from './deviceSiteResolver';
import { createAlert, createSourcedAlert, checkAutoResolve, resolveAlert } from './alertService';

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
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1', expect.objectContaining({
      owner: null, ownerKey: 'device:device-1',
    }), 'alert-service', { siteId: 'site-1' });
    expect(enqueueAlertCorrelationMock).toHaveBeenCalledWith({ orgId: 'org-1', deviceId: 'device-1' });
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
    expect(insertCalls).not.toHaveBeenCalledWith(alertCorrelationsTable);
  });
});

describe('createAlert honours alert_rules.is_active (#7626)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectResults.length = 0;
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([{ id: 'alert-1' }]);
  });

  const input = {
    ruleId: 'rule-builtin',
    deviceId: 'device-1',
    orgId: 'org-1',
    severity: 'high' as const,
    title: 'Patch job failed on host-1',
    message: '1 patch(es) failed to install on host-1.',
  };

  it('raises no alert, burns no cooldown and publishes nothing for an inactive rule', async () => {
    dbMock._selectResults.push(
      [{ id: 'rule-builtin', templateId: 'template-1', overrideSettings: null, isActive: false }],
      [{ id: 'template-1', cooldownMinutes: 240 }],
      [],
    );

    const alertId = await createAlert(input);

    expect(alertId).toBeNull();
    expect(dbMock.execute).not.toHaveBeenCalled();
    expect(vi.mocked(publishEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(setCooldown)).not.toHaveBeenCalled();
  });

  it('still raises the alert for an active rule', async () => {
    dbMock._selectResults.push(
      [{ id: 'rule-builtin', templateId: 'template-1', overrideSettings: null, isActive: true }],
      [{ id: 'template-1', cooldownMinutes: 240 }],
      [],
    );

    expect(await createAlert(input)).toBe('alert-1');
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
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
        monitorId: null,
        kind: null,
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
    // The null-check must short-circuit BEFORE the correlation enqueue too —
    // there is no alert to correlate.
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
  });

  it('rolls back the alert row and reports when publishing alert.triggered throws', async () => {
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([{ id: 'alert-9' }]);
    vi.mocked(publishEvent).mockRejectedValueOnce(new Error('redis down'));

    const alertId = await createSourcedAlert({
      deviceId: 'device-1',
      orgId: 'org-1',
      severity: 'high',
      title: 't',
      message: 'm',
      context: { source: 'network_monitor', monitorId: 'monitor-1' },
      publisher: 'monitor-worker',
    });

    // An `active` row nobody was ever notified about is exactly the silent
    // inbox-only alert #5241 exists to remove: it must not survive, or the
    // caller's dedupe would skip re-creating it forever.
    expect(alertId).toBeNull();
    expect(deleteCalls).toHaveBeenCalledWith(alertsTable);
    expect(captureExceptionMock).toHaveBeenCalled();
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
  });
});

describe('createAlert publish rollback (#5325)', () => {
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

  it('rolls the alert row back, skips the cooldown and reports when publishing throws', async () => {
    vi.mocked(publishEvent).mockRejectedValueOnce(new Error('redis down'));

    const alertId = await createAlert({
      ruleId: 'rule-1',
      deviceId: 'device-1',
      orgId: 'org-1',
      severity: 'critical',
      title: 'CPU high',
      message: 'CPU high on device',
    });

    // An `active` row nobody was notified about would be found by this path's
    // own dedupe query forever, so it must not survive the failed publish.
    expect(alertId).toBeNull();
    expect(deleteCalls).toHaveBeenCalledWith(alertsTable);
    expect(captureExceptionMock).toHaveBeenCalled();
    // Burning the cooldown would stop the next evaluation from retrying the
    // whole create+publish.
    expect(vi.mocked(setCooldown)).not.toHaveBeenCalled();
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
  });

  it('sets the cooldown and enqueues correlation once the publish succeeds', async () => {
    const alertId = await createAlert({
      ruleId: 'rule-1',
      deviceId: 'device-1',
      orgId: 'org-1',
      severity: 'critical',
      title: 'CPU high',
      message: 'CPU high on device',
    });

    expect(alertId).toBe('alert-1');
    expect(deleteCalls).not.toHaveBeenCalled();
    expect(vi.mocked(setCooldown)).toHaveBeenCalledWith('rule-1', 'device-1', 5, undefined);
    expect(enqueueAlertCorrelationMock).toHaveBeenCalledWith({ orgId: 'org-1', deviceId: 'device-1' });
  });
});

describe('alert.triggered monitor identity and kind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectResults.length = 0;
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([{ id: 'alert-kind' }]);
  });
  const input = { deviceId: 'device-1', orgId: 'org-1', severity: 'high' as const, title: 'CPU', message: 'High CPU' };
  it('publishes the supplied compiled-monitor kind and keeps ruleId', async () => {
    dbMock._selectResults.push(
      [{ id: 'rule-1', templateId: 'template-1', managedByMonitorId: 'monitor-1' }],
      [{ cooldownMinutes: 5 }], [],
    );
    await createAlert({ ...input, ruleId: 'rule-1', monitorId: 'monitor-1', kind: 'cpu' });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1',
      expect.objectContaining({ ruleId: 'rule-1', monitorId: 'monitor-1', kind: 'cpu' }),
      'alert-service', { siteId: 'site-1' });
  });
  it('resolves a sourced monitor kind when the recurrence producer only knows its id', async () => {
    dbMock._selectResults.push([{ kind: 'disk' }]);
    await createSourcedAlert({ ...input, monitorId: 'monitor-1', context: { source: 'monitor_recurrence' }, publisher: 'monitor-escalation' });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1',
      expect.objectContaining({ ruleId: null, monitorId: 'monitor-1', kind: 'disk' }),
      'monitor-escalation', { siteId: 'site-1' });
  });
  it('sourced payload extras cannot replace canonical monitor identity', async () => {
    await createSourcedAlert({ ...input, monitorId: 'monitor-1', kind: 'memory',
      context: { source: 'monitor_recurrence' }, publisher: 'monitor-escalation',
      eventPayload: { monitorId: 'wrong', kind: 'cpu' } });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1',
      expect.objectContaining({ monitorId: 'monitor-1', kind: 'memory' }),
      'monitor-escalation', { siteId: 'site-1' });
  });
  it('feature-sourced alerts have explicit nulls and retain source-specific context', async () => {
    await createSourcedAlert({ ...input, context: { source: 'network_monitor', monitorId: 'legacy-check' },
      publisher: 'monitor-worker', eventPayload: { monitorId: 'legacy-check' } });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1',
      expect.objectContaining({ monitorId: null, kind: null, source: 'network_monitor' }),
      'monitor-worker', { siteId: 'site-1' });
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});


describe('createSourcedAlert workload ownership', () => {
  const input = {
    deviceId: null, owner: { kind: 'backup_workload' as const, ref: 'workload-1' },
    orgId: 'org-1', severity: 'high' as const, title: 'Backup failed', message: 'Backup failed',
    context: { source: 'backup_provider' }, publisher: 'backup-sync',
  };
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectResults.length = 0;
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([{ id: 'alert-workload' }]);
  });
  it('inserts the workload owner with a null device', async () => {
    expect(await createSourcedAlert(input)).toBe('alert-workload');
    expect(insertCalls.mock.results[0]?.value.values).toHaveBeenCalledWith(expect.objectContaining({
      ownerKind: 'backup_workload', ownerRef: 'workload-1', deviceId: null,
    }));
  });
  it('publishes authoritative owner identity with null device and site', async () => {
    await createSourcedAlert({ ...input, siteId: 'wrong-site',
      eventPayload: { deviceId: 'wrong-device', owner: null, ownerKey: 'wrong-key' } });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1', expect.objectContaining({
      deviceId: null, owner: input.owner, ownerKey: 'backup_workload:workload-1',
    }), 'backup-sync', { siteId: null });
  });
  it('never resolves a device site or enqueues correlation for a workload', async () => {
    await createSourcedAlert(input);
    expect(resolveDeviceSiteId).not.toHaveBeenCalled();
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
  });
  it('logs a dedupe with owner identity without publishing or reporting an error', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([]);
    expect(await createSourcedAlert(input)).toBeNull();
    expect(publishEvent).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.any(String), { orgId: 'org-1', ownerKind: 'backup_workload', ownerRef: 'workload-1' });
    info.mockRestore();
  });
  it('reports an insert exception with owner identity and preserves the rejection', async () => {
    const error = new Error('insert unavailable');
    dbMock.insert.mockImplementationOnce(() => ({
      values: vi.fn(() => {
        const statement = {
          returning: vi.fn(() => Promise.reject(error)),
          onConflictDoNothing: vi.fn(() => statement),
        };
        return statement;
      }),
      _table: alertsTable,
    }));
    await expect(createSourcedAlert(input)).rejects.toBe(error);
    expect(captureExceptionMock).toHaveBeenCalledWith(error, undefined, expect.objectContaining({
      orgId: 'org-1', ownerKind: 'backup_workload', ownerRef: 'workload-1',
    }));
    expect(publishEvent).not.toHaveBeenCalled();
  });
  it('keeps device owner identity and device correlation', async () => {
    await createSourcedAlert({ ...input, deviceId: 'device-1', owner: undefined });
    expect(publishEvent).toHaveBeenCalledWith('alert.triggered', 'org-1', expect.objectContaining({
      owner: null, ownerKey: 'device:device-1', deviceId: 'device-1',
    }), 'backup-sync', { siteId: 'site-1' });
    expect(enqueueAlertCorrelationMock).toHaveBeenCalledWith({ orgId: 'org-1', deviceId: 'device-1' });
  });
  it('rolls back a workload alert when publish fails', async () => {
    vi.mocked(publishEvent).mockRejectedValueOnce(new Error('redis down'));
    expect(await createSourcedAlert(input)).toBeNull();
    expect(deleteCalls).toHaveBeenCalledWith(alertsTable);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), undefined, {
      errorId: 'alert-triggered-publish-failed', alertId: 'alert-workload',
      alertSource: 'backup_provider', orgId: 'org-1', ownerKind: 'backup_workload', ownerRef: 'workload-1',
    });
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
  });
});


describe('rule-only alert device guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectResults.length = 0;
    dbMock._selectResults.push([{ id: 'invalid-rule-alert', orgId: 'org-1', ownerKind: 'backup_workload', ownerRef: 'workload-1', ruleId: 'rule-1', deviceId: null, status: 'active', triggeredAt: new Date(), resolvedAt: new Date() }]);
  });
  it('rejects a rule alert without a device before auto-resolution evaluation', async () => {
    await expect(checkAutoResolve('invalid-rule-alert')).rejects.toThrow('alert_has_no_device');
  });
  it.each([false, true])('resolves a device-less rule alert and publishes when deferSubjectEffects=%s', async (deferSubjectEffects) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = dbMock._selectResults[0]![0] as Record<string, unknown>;
    row.subjectKey = 'historical-subject';
    try {
      await expect(resolveAlert('invalid-rule-alert', 'fixed', 'user-1', deferSubjectEffects)).resolves.toBe(true);
      expect(setCooldown).not.toHaveBeenCalled();
      expect(dbMock.select).not.toHaveBeenCalled();
      expect(publishEvent).toHaveBeenCalledExactlyOnceWith('alert.resolved', 'org-1', expect.objectContaining({
        alertId: 'invalid-rule-alert', deviceId: null, resolutionNote: 'fixed',
      }), 'alert-service', { siteId: null });
      expect(warn).toHaveBeenCalledWith(expect.any(String), {
        alertId: 'invalid-rule-alert', orgId: 'org-1', ownerKind: 'backup_workload', reason: 'alert_has_no_device',
      });
    } finally { warn.mockRestore(); }
  });
});
