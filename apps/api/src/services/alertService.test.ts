import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbMock,
  insertCalls,
  deleteCalls,
  captureExceptionMock,
  enqueueAlertCorrelationMock,
  scheduleStagedAlertDispatchMock,
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
    scheduleStagedAlertDispatchMock: vi.fn(),
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
// #10926 — create stages `alert.triggered` on the row and hands the id to the
// outbox; the after-commit publish and its follow-ups are covered by
// alertPublishAfterCommit.integration.test.ts.
vi.mock('./subjectAlertOutbox', () => ({ scheduleStagedAlertDispatch: scheduleStagedAlertDispatchMock }));

import { publishEvent } from './eventBus';
import { setCooldown } from './alertCooldown';
import { resolveDeviceSiteId } from './deviceSiteResolver';
import { createAlert, createSourcedAlert, checkAutoResolve, resolveAlert } from './alertService';

// create never publishes now, so the `mockRejectedValueOnce` the no-inline-publish
// tests queue is never consumed; clearAllMocks would leave it queued for the
// next test. Reset it so it cannot leak.
afterEach(() => {
  vi.mocked(publishEvent).mockReset();
});

type StagedTrigger = {
  eventId: string;
  eventType: string;
  publisher: string;
  siteId: string | null;
  cooldownMinutes: number;
  payload: Record<string, unknown>;
  occurredAt: string;
  retryOnPublishFailure: boolean;
};

/** The `_subjectDispatch` envelope `createAlert` wrote into its raw INSERT's context param. */
function legacyInsert(): { envelope: StagedTrigger; id: unknown } {
  const calls = dbMock.execute.mock.calls as unknown as Array<[{ values: unknown[] }]>;
  expect(calls).toHaveLength(1);
  const { values } = calls[0]![0];
  const context = values.find((value) => typeof value === 'string' && value.includes('_subjectDispatch'));
  expect(context, 'the INSERT context param carries the outbox envelope').toBeDefined();
  // The `id` param is appended LAST, after `'active', now()`.
  return { envelope: JSON.parse(context as string)._subjectDispatch, id: values[values.length - 1] };
}

/** The `_subjectDispatch` envelope `createSourcedAlert` passed to `.values({ context })`. */
function sourcedInsert(): { envelope: StagedTrigger; id: unknown } {
  expect(insertCalls).toHaveBeenCalledTimes(1);
  const valuesFn = insertCalls.mock.results[0]!.value.values as ReturnType<typeof vi.fn>;
  const row = valuesFn.mock.calls[0]![0] as { id: unknown; context: { _subjectDispatch: StagedTrigger } };
  return { envelope: row.context._subjectDispatch, id: row.id };
}

/** create no longer publishes inline: anything announced goes through the outbox. */
function inlineTriggerPublishes() {
  return vi.mocked(publishEvent).mock.calls.filter((call) => call[0] === 'alert.triggered');
}

/** The staged envelope names the same alert the row was inserted with. */
function expectEnvelopeNamesRow(envelope: StagedTrigger, id: unknown) {
  expect(typeof id).toBe('string');
  expect(envelope.eventId).toBe(id);
  expect(envelope.payload.alertId).toBe(id);
  expect(envelope.occurredAt).toEqual(expect.any(String));
}

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

  it('stages alert.triggered for the outbox and leaves correlation to it, with no inline links', async () => {
    const alertId = await createAlert({
      ruleId: 'rule-1',
      deviceId: 'device-1',
      orgId: 'org-1',
      severity: 'critical',
      title: 'CPU high',
      message: 'CPU high on device',
    });

    expect(alertId).toBe('alert-1');
    expect(inlineTriggerPublishes()).toEqual([]);
    const { envelope, id } = legacyInsert();
    expectEnvelopeNamesRow(envelope, id);
    expect(envelope).toMatchObject({
      eventType: 'alert.triggered',
      publisher: 'alert-service',
      siteId: 'site-1',
      cooldownMinutes: 5,
      retryOnPublishFailure: true,
      payload: expect.objectContaining({ owner: null, ownerKey: 'device:device-1' }),
    });
    expect(scheduleStagedAlertDispatchMock).toHaveBeenCalledExactlyOnceWith('alert-1');
    // Correlation is enqueued by the outbox after the publish, never inline.
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
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
    expect(scheduleStagedAlertDispatchMock).not.toHaveBeenCalled();
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
    expect(scheduleStagedAlertDispatchMock).toHaveBeenCalledExactlyOnceWith('alert-1');
  });
});

describe('createSourcedAlert (#5241 — rule-less alert sources announce alert.triggered)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock._selectResults.length = 0;
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([{ id: 'alert-9' }]);
  });

  it('inserts a rule-less alert and stages exactly one alert.triggered envelope carrying the source', async () => {
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

    expect(inlineTriggerPublishes()).toEqual([]);
    const { envelope, id } = sourcedInsert();
    expectEnvelopeNamesRow(envelope, id);
    expect(envelope).toMatchObject({
      eventType: 'alert.triggered',
      publisher: 'monitor-worker',
      siteId: 'site-1',
      // A sourced alert's cooldown belongs to its caller; the outbox sets none.
      cooldownMinutes: 0,
      retryOnPublishFailure: true,
      payload: expect.objectContaining({
        ruleId: null,
        deviceId: 'device-1',
        severity: 'high',
        title: 'Edge Ping offline',
        message: 'Monitor Edge Ping is offline',
        source: 'network_monitor',
        monitorId: null,
        kind: null,
      }),
    });
    expect(scheduleStagedAlertDispatchMock).toHaveBeenCalledExactlyOnceWith('alert-9');
    // Device correlation is enqueued by the outbox after the publish.
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
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
    // The null-check must short-circuit BEFORE the outbox hand-off — there is
    // no row to announce.
    expect(scheduleStagedAlertDispatchMock).not.toHaveBeenCalled();
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
  });

  it('never publishes inline, so a publishEvent rejection cannot roll the alert back (#10926)', async () => {
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

    // The publish moved to the outbox: the staged envelope is durable on the
    // row and a failed publish is retried there with the row kept. Create has
    // nothing to roll back, delete or report.
    expect(alertId).toBe('alert-9');
    expect(vi.mocked(publishEvent)).not.toHaveBeenCalled();
    expect(deleteCalls).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(scheduleStagedAlertDispatchMock).toHaveBeenCalledExactlyOnceWith('alert-9');
  });
});

describe('createAlert never publishes inline (#5325, #10926)', () => {
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

  it('a publishEvent rejection cannot roll the alert back, because create never publishes', async () => {
    vi.mocked(publishEvent).mockRejectedValueOnce(new Error('redis down'));

    const alertId = await createAlert({
      ruleId: 'rule-1',
      deviceId: 'device-1',
      orgId: 'org-1',
      severity: 'critical',
      title: 'CPU high',
      message: 'CPU high on device',
    });

    // The publish moved to the outbox: the staged envelope is durable on the
    // row and a failed publish is retried there with the row kept. Create has
    // nothing to roll back, delete or report.
    expect(alertId).toBe('alert-1');
    expect(vi.mocked(publishEvent)).not.toHaveBeenCalled();
    expect(deleteCalls).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(scheduleStagedAlertDispatchMock).toHaveBeenCalledExactlyOnceWith('alert-1');
  });

  it('leaves the cooldown and correlation to the outbox drain, carrying the cooldown in the envelope', async () => {
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
    // They run after a successful publish, in the outbox; the drain reads the
    // cooldown from the envelope.
    expect(vi.mocked(setCooldown)).not.toHaveBeenCalled();
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
    expect(legacyInsert().envelope.cooldownMinutes).toBe(5);
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
    expect(inlineTriggerPublishes()).toEqual([]);
    expect(legacyInsert().envelope).toMatchObject({
      eventType: 'alert.triggered', publisher: 'alert-service', siteId: 'site-1', retryOnPublishFailure: true,
      payload: expect.objectContaining({ ruleId: 'rule-1', monitorId: 'monitor-1', kind: 'cpu' }),
    });
  });
  it('resolves a sourced monitor kind when the recurrence producer only knows its id', async () => {
    dbMock._selectResults.push([{ kind: 'disk' }]);
    await createSourcedAlert({ ...input, monitorId: 'monitor-1', context: { source: 'monitor_recurrence' }, publisher: 'monitor-escalation' });
    expect(inlineTriggerPublishes()).toEqual([]);
    expect(sourcedInsert().envelope).toMatchObject({
      eventType: 'alert.triggered', publisher: 'monitor-escalation', siteId: 'site-1', retryOnPublishFailure: true,
      payload: expect.objectContaining({ ruleId: null, monitorId: 'monitor-1', kind: 'disk' }),
    });
  });
  it('sourced payload extras cannot replace canonical monitor identity', async () => {
    await createSourcedAlert({ ...input, monitorId: 'monitor-1', kind: 'memory',
      context: { source: 'monitor_recurrence' }, publisher: 'monitor-escalation',
      eventPayload: { monitorId: 'wrong', kind: 'cpu' } });
    expect(inlineTriggerPublishes()).toEqual([]);
    expect(sourcedInsert().envelope).toMatchObject({
      eventType: 'alert.triggered', publisher: 'monitor-escalation', siteId: 'site-1', retryOnPublishFailure: true,
      payload: expect.objectContaining({ monitorId: 'monitor-1', kind: 'memory' }),
    });
  });
  it('feature-sourced alerts have explicit nulls and retain source-specific context', async () => {
    await createSourcedAlert({ ...input, context: { source: 'network_monitor', monitorId: 'legacy-check' },
      publisher: 'monitor-worker', eventPayload: { monitorId: 'legacy-check' } });
    expect(inlineTriggerPublishes()).toEqual([]);
    expect(sourcedInsert().envelope).toMatchObject({
      eventType: 'alert.triggered', publisher: 'monitor-worker', siteId: 'site-1', retryOnPublishFailure: true,
      payload: expect.objectContaining({ monitorId: null, kind: null, source: 'network_monitor' }),
    });
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
  it('stages authoritative owner identity with null device and site', async () => {
    await createSourcedAlert({ ...input, siteId: 'wrong-site',
      eventPayload: { deviceId: 'wrong-device', owner: null, ownerKey: 'wrong-key' } });
    expect(inlineTriggerPublishes()).toEqual([]);
    expect(sourcedInsert().envelope).toMatchObject({
      eventType: 'alert.triggered', publisher: 'backup-sync', siteId: null, retryOnPublishFailure: true,
      payload: expect.objectContaining({
        deviceId: null, owner: input.owner, ownerKey: 'backup_workload:workload-1',
      }),
    });
  });
  it('never resolves a device site or enqueues correlation for a workload', async () => {
    await createSourcedAlert(input);
    expect(resolveDeviceSiteId).not.toHaveBeenCalled();
    expect(enqueueAlertCorrelationMock).not.toHaveBeenCalled();
    // The row is still announced, by the outbox.
    expect(scheduleStagedAlertDispatchMock).toHaveBeenCalledExactlyOnceWith('alert-workload');
  });
  it('logs a dedupe with owner identity without publishing or reporting an error', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    dbMock._insertReturnResults.length = 0;
    dbMock._insertReturnResults.push([]);
    expect(await createSourcedAlert(input)).toBeNull();
    expect(publishEvent).not.toHaveBeenCalled();
    expect(scheduleStagedAlertDispatchMock).not.toHaveBeenCalled();
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
    expect(scheduleStagedAlertDispatchMock).not.toHaveBeenCalled();
  });
  it('keeps device owner identity in the staged payload and leaves correlation to the outbox', async () => {
    await createSourcedAlert({ ...input, deviceId: 'device-1', owner: undefined });
    expect(inlineTriggerPublishes()).toEqual([]);
    expect(sourcedInsert().envelope).toMatchObject({
      eventType: 'alert.triggered', publisher: 'backup-sync', siteId: 'site-1', retryOnPublishFailure: true,
      payload: expect.objectContaining({ owner: null, ownerKey: 'device:device-1', deviceId: 'device-1' }),
    });
    // Enqueued by the outbox after the publish, not inline.
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
