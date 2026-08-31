import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getJobMock,
  addMock,
  closeMock,
  shouldProduceMlOutputMock,
  persistGroupsMock,
  attachWorkerObservabilityMock,
  isFlappingMock,
  publishEventMock,
  withSystemDbAccessContextMock,
  dbState,
  dbMock,
} = vi.hoisted(() => {
  // Minimal stateful db mock supporting the read chain + an insert(...).values(...).returning()
  // path used by runAlertCorrelationForDevice. `insertReturnsEmpty` simulates an RLS-scoped
  // write that silently matches 0 rows so the `created` counter must not increment.
  const dbState = {
    targetDevice: [] as Array<Record<string, any>>,
    recentAlerts: [] as Array<Record<string, any>>,
    existingLinks: [] as Array<Record<string, any>>,
    recentLogCorrelations: [] as Array<Record<string, any>>,
    // Task 11 (B1): consumed in FIFO order by the post-persist lookups —
    // group row (rootAlertId, memberCount) then that root alert's deviceId,
    // once per entry in persisted.createdGroupIds. Each test pushes exactly
    // the rows it expects those lookups to consume, in call order.
    groupRowQueue: [] as Array<Record<string, any> | undefined>,
    alertDeviceQueue: [] as Array<Record<string, any> | undefined>,
    insertReturnsEmpty: false,
    insertCalls: 0,
    selectCall: 0,
  };

  const dbMock = {
    select: vi.fn((selection?: Record<string, unknown>) => {
      const index = dbState.selectCall;
      dbState.selectCall += 1;
      // Task 11's two post-persist lookups run conditionally (0..N times per created
      // group) after the four fixed pre-scan selects above, so they're distinguished
      // by their `.select({...})` projection shape rather than call-index.
      const keys = selection ? Object.keys(selection) : [];
      const isGroupRowLookup = keys.includes('rootAlertId') && keys.includes('memberCount');
      const isAlertDeviceLookup = keys.length === 1 && keys[0] === 'deviceId';
      const chain: any = {
        from: () => chain,
        leftJoin: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => {
          if (isGroupRowLookup) {
            const row = dbState.groupRowQueue.shift();
            return Promise.resolve(row ? [row] : []);
          }
          if (isAlertDeviceLookup) {
            const row = dbState.alertDeviceQueue.shift();
            return Promise.resolve(row ? [row] : []);
          }
          // Query order: 0=targetDevice, 1=recentAlerts, 3=recentLogCorrelations.
          return Promise.resolve(
            index === 0
              ? dbState.targetDevice
              : index === 1
                ? dbState.recentAlerts
                : index === 3
                  ? dbState.recentLogCorrelations
                  : []
          );
        },
        then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
          // Query order: index 2 = existingLinks (no .limit(); awaited directly).
          Promise.resolve(dbState.existingLinks).then(resolve, reject),
      };
      return chain;
    }),
    insert: vi.fn(() => ({
      values: () => ({
        returning: () => {
          dbState.insertCalls += 1;
          return Promise.resolve(dbState.insertReturnsEmpty ? [] : [{ id: `corr-${dbState.insertCalls}` }]);
        },
      }),
    })),
  };

  return {
    getJobMock: vi.fn(),
    addMock: vi.fn(),
    closeMock: vi.fn(),
    shouldProduceMlOutputMock: vi.fn(),
    persistGroupsMock: vi.fn(),
    attachWorkerObservabilityMock: vi.fn(),
    isFlappingMock: vi.fn(),
    publishEventMock: vi.fn(),
    // F1: a real (not just a `fn()` passthrough) mock so individual tests can
    // override its implementation to record call order relative to
    // publishEventMock — see "publishes ... AFTER withSystemDbAccessContext
    // resolves" below. Default implementation (set in beforeEach) still just
    // awaits and returns `fn()`, matching the real function's contract.
    withSystemDbAccessContextMock: vi.fn(),
    dbState,
    dbMock,
  };
});

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/bullmqUtils', () => ({
  isReusableState: vi.fn((state: string) => ['waiting', 'delayed', 'active'].includes(state)),
}));

vi.mock('../services/mlFeatureFlags', () => ({
  shouldProduceMlOutput: shouldProduceMlOutputMock,
}));

vi.mock('../services/alertCorrelationGroups', () => ({
  persistAlertCorrelationGroupsForAlerts: persistGroupsMock,
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: publishEventMock,
}));

vi.mock('../services/alertCooldown', () => ({
  isFlapping: isFlappingMock,
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock,
}));

vi.mock('../db', () => ({
  db: dbMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../db/schema', () => ({
  alerts: {},
  alertCorrelationGroups: {},
  alertCorrelations: { id: 'alert_correlations.id', parentAlertId: 'alert_correlations.parentAlertId', childAlertId: 'alert_correlations.childAlertId' },
  alertRules: {},
  devices: {},
  logCorrelationRules: {},
  logCorrelations: {},
}));

import {
  buildAlertCorrelationEvidence,
  buildAlertCorrelationJobId,
  enqueueAlertCorrelation,
  findAlertPairFlappingEvidence,
  findAlertPairLogEvidence,
  initializeAlertCorrelationWorker,
  processAlertCorrelationJob,
  runAlertCorrelationForDevice,
  shutdownAlertCorrelationWorker,
} from './alertCorrelation';

const alertAt = (overrides: Partial<Parameters<typeof buildAlertCorrelationEvidence>[0]['newer']>) => ({
  id: 'alert-1',
  deviceId: 'device-1',
  triggeredAt: new Date('2026-06-18T12:00:00.000Z'),
  ruleId: null,
  templateId: null,
  configPolicyId: null,
  configItemName: null,
  siteId: 'site-1',
  ...overrides,
});

describe('alert correlation queue helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    shouldProduceMlOutputMock.mockReset();
    persistGroupsMock.mockReset();
    attachWorkerObservabilityMock.mockReset();
    isFlappingMock.mockReset();
    publishEventMock.mockReset();
    withSystemDbAccessContextMock.mockReset();
    isFlappingMock.mockResolvedValue(false);
    shouldProduceMlOutputMock.mockResolvedValue(true);
    persistGroupsMock.mockResolvedValue({ scanned: 0, groupsWritten: 0, membersWritten: 0, createdGroupIds: [] });
    publishEventMock.mockResolvedValue('event-id');
    // Default: same contract as the real withSystemDbAccessContext — await
    // and return fn()'s result. Individual tests may override this to record
    // call order relative to publishEventMock.
    withSystemDbAccessContextMock.mockImplementation((fn: () => Promise<unknown>) => fn());
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-correlation-job' });
    dbState.targetDevice = [];
    dbState.recentAlerts = [];
    dbState.existingLinks = [];
    dbState.recentLogCorrelations = [];
    dbState.groupRowQueue = [];
    dbState.alertDeviceQueue = [];
    dbState.insertReturnsEmpty = false;
    dbState.insertCalls = 0;
    dbState.selectCall = 0;
    dbMock.select.mockClear();
    dbMock.insert.mockClear();
    await shutdownAlertCorrelationWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id per org/device debounce slot', async () => {
    const jobId = buildAlertCorrelationJobId('org-1', 'device-1');

    const queuedJobId = await enqueueAlertCorrelation({ orgId: 'org-1', deviceId: 'device-1' });

    expect(jobId).toMatch(/^alert-correlation-org-1-device-1-[a-z0-9]+$/);
    expect(queuedJobId).toBe('queued-correlation-job');
    expect(shouldProduceMlOutputMock).toHaveBeenCalledWith('org-1', 'ml.alert_correlation.enabled');
    expect(addMock).toHaveBeenCalledWith(
      'correlate-device-alerts',
      expect.objectContaining({ orgId: 'org-1', deviceId: 'device-1' }),
      expect.objectContaining({ jobId, delay: 5000 }),
    );
  });

  it('reuses an already queued device correlation job in the same slot', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-correlation-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await enqueueAlertCorrelation({ orgId: 'org-1', deviceId: 'device-1' });

    expect(jobId).toBe('existing-correlation-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('suppresses enqueue work when alert correlation is disabled for the org', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(false);

    const jobId = await enqueueAlertCorrelation({ orgId: 'org-1', deviceId: 'device-1' });

    expect(jobId).toBeNull();
    expect(shouldProduceMlOutputMock).toHaveBeenCalledWith('org-1', 'ml.alert_correlation.enabled');
    expect(getJobMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('suppresses worker scans when alert correlation is disabled for the org', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(false);

    const result = await runAlertCorrelationForDevice({ orgId: 'org-1', deviceId: 'device-1' });

    expect(result).toEqual({ scanned: 0, created: 0, createdGroups: [] });
    expect(shouldProduceMlOutputMock).toHaveBeenCalledWith('org-1', 'ml.alert_correlation.enabled');
  });

  it('counts only correlations that the insert actually persisted', async () => {
    dbState.targetDevice = [{ siteId: 'site-1' }];
    dbState.recentAlerts = [
      { id: 'alert-a', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:00:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
      { id: 'alert-b', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:01:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
    ];

    const result = await runAlertCorrelationForDevice({ orgId: 'org-1', deviceId: 'device-1', windowMinutes: 30 });

    expect(dbState.insertCalls).toBe(1);
    expect(result).toEqual({ scanned: 2, created: 1, createdGroups: [] });
    expect(persistGroupsMock).toHaveBeenCalledWith({ orgId: 'org-1', alertIds: ['alert-a', 'alert-b'] });
  });

  // F1 fix (P2-1 second live check): runAlertCorrelationForDevice must build the
  // created-group payloads (still inside the transaction, so its lookups see rows
  // that same transaction just wrote) but never publish them itself — publication
  // moved to the caller (processAlertCorrelationJob), which runs it AFTER
  // withSystemDbAccessContext resolves. See that file's F1 fix comment for why:
  // publishing from inside the transaction raced the local subscriber's
  // synchronous write (on another connection) against this transaction's own
  // as-yet-uncommitted alert_correlation_groups row, FK-violating
  // ai_agent_runs_correlation_group_id_fkey (2/2 reproductions in the live check).
  it('returns createdGroups and does NOT call publishEvent itself', async () => {
    dbState.targetDevice = [{ siteId: 'site-1' }];
    dbState.recentAlerts = [
      { id: 'alert-a', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:00:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
      { id: 'alert-b', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:01:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
    ];
    persistGroupsMock.mockResolvedValue({ scanned: 2, groupsWritten: 1, membersWritten: 3, createdGroupIds: ['g1'] });
    dbState.groupRowQueue = [{ rootAlertId: 'a1', memberCount: 3 }];
    dbState.alertDeviceQueue = [{ deviceId: 'd1' }];

    const result = await runAlertCorrelationForDevice({ orgId: 'org-1', deviceId: 'device-1', windowMinutes: 30 });

    expect(result).toEqual({
      scanned: 2,
      created: 1,
      createdGroups: [{ groupId: 'g1', rootAlertId: 'a1', memberCount: 3, deviceId: 'd1' }],
    });
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('createdGroups carries null rootAlertId/deviceId when the root alert has been hard-deleted (SET NULL FK)', async () => {
    dbState.targetDevice = [{ siteId: 'site-1' }];
    dbState.recentAlerts = [
      { id: 'alert-a', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:00:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
      { id: 'alert-b', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:01:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
    ];
    persistGroupsMock.mockResolvedValue({ scanned: 2, groupsWritten: 1, membersWritten: 3, createdGroupIds: ['g1'] });
    dbState.groupRowQueue = [{ rootAlertId: null, memberCount: 3 }];
    // alertDeviceQueue intentionally left empty — the root-alert lookup must be
    // skipped entirely (not just return an empty row) when rootAlertId is null.

    const result = await runAlertCorrelationForDevice({ orgId: 'org-1', deviceId: 'device-1', windowMinutes: 30 });

    expect(result.createdGroups).toEqual([{ groupId: 'g1', rootAlertId: null, memberCount: 3, deviceId: null }]);
  });

  it('warns and skips the group when the just-created group row cannot be found', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dbState.targetDevice = [{ siteId: 'site-1' }];
    dbState.recentAlerts = [
      { id: 'alert-a', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:00:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
      { id: 'alert-b', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:01:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
    ];
    persistGroupsMock.mockResolvedValue({ scanned: 2, groupsWritten: 1, membersWritten: 3, createdGroupIds: ['g1'] });
    dbState.groupRowQueue = [];

    const result = await runAlertCorrelationForDevice({ orgId: 'org-1', deviceId: 'device-1', windowMinutes: 30 });

    expect(result).toEqual({ scanned: 2, created: 1, createdGroups: [] });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  // F1 fix: the worker's processor (processAlertCorrelationJob) — not
  // runAlertCorrelationForDevice — owns publication, and must do it only AFTER
  // withSystemDbAccessContext's promise has resolved. callOrder proves the
  // sequencing directly: the mocked withSystemDbAccessContext records
  // 'context:resolved' only once its wrapped fn() has settled, and
  // publishEventMock records 'publishEvent:called' — if publication ever moved
  // back inside the transaction (the pre-fix bug), 'publishEvent:called' would
  // land BEFORE 'context:resolved' and this assertion would catch it.
  it('processAlertCorrelationJob publishes once per created group AFTER withSystemDbAccessContext resolves', async () => {
    const callOrder: string[] = [];
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => {
      const result = await fn();
      callOrder.push('context:resolved');
      return result;
    });
    publishEventMock.mockImplementation(async () => {
      callOrder.push('publishEvent:called');
      return 'event-id';
    });
    dbState.targetDevice = [{ siteId: 'site-1' }];
    dbState.recentAlerts = [
      { id: 'alert-a', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:00:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
      { id: 'alert-b', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:01:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
    ];
    persistGroupsMock.mockResolvedValue({ scanned: 2, groupsWritten: 1, membersWritten: 3, createdGroupIds: ['g1'] });
    dbState.groupRowQueue = [{ rootAlertId: 'a1', memberCount: 3 }];
    dbState.alertDeviceQueue = [{ deviceId: 'd1' }];

    const result = await processAlertCorrelationJob({
      orgId: 'org-1',
      deviceId: 'device-1',
      queuedAt: '2026-06-18T12:00:00.000Z',
      windowMinutes: 30,
    });

    expect(result.createdGroups).toEqual([{ groupId: 'g1', rootAlertId: 'a1', memberCount: 3, deviceId: 'd1' }]);
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock).toHaveBeenCalledWith(
      'alert.correlation_group.created',
      'org-1',
      { groupId: 'g1', rootAlertId: 'a1', memberCount: 3, deviceId: 'd1' },
      'alert-correlation'
    );
    expect(callOrder).toEqual(['context:resolved', 'publishEvent:called']);
  });

  it('does not increment created when an insert silently matches 0 rows (RLS scope drop)', async () => {
    dbState.targetDevice = [{ siteId: 'site-1' }];
    dbState.recentAlerts = [
      { id: 'alert-a', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:00:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
      { id: 'alert-b', deviceId: 'device-1', triggeredAt: new Date('2026-06-18T12:01:00.000Z'), ruleId: 'rule-1', templateId: null, configPolicyId: null, configItemName: null, siteId: 'site-1' },
    ];
    dbState.insertReturnsEmpty = true;

    const result = await runAlertCorrelationForDevice({ orgId: 'org-1', deviceId: 'device-1', windowMinutes: 30 });

    expect(dbState.insertCalls).toBe(1);
    expect(result).toEqual({ scanned: 2, created: 0, createdGroups: [] });
  });

  it('attaches worker observability during initialization', async () => {
    await initializeAlertCorrelationWorker();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'alertCorrelationWorker');
  });

  it('builds stronger evidence for alerts from the same rule', () => {
    const evidence = buildAlertCorrelationEvidence({
      older: alertAt({ id: 'older', ruleId: 'rule-1', templateId: 'template-1' }),
      newer: alertAt({ id: 'newer', ruleId: 'rule-1', templateId: 'template-1' }),
      deviceId: 'device-1',
      timeDiffMs: 5 * 60 * 1000,
      maxWindowMs: 30 * 60 * 1000,
    });

    expect(evidence).toMatchObject({
      correlationType: 'same_rule_temporal',
      confidence: 0.98,
      metadata: {
        deviceId: 'device-1',
        parentDeviceId: 'device-1',
        childDeviceId: 'device-1',
        siteId: 'site-1',
        ruleId: 'rule-1',
        templateId: 'template-1',
        evidence: ['same_device', 'time_window', 'same_rule'],
      },
    });
  });

  it('falls back to same-template evidence when rule ids differ', () => {
    const evidence = buildAlertCorrelationEvidence({
      older: alertAt({ id: 'older', ruleId: 'rule-1', templateId: 'template-1' }),
      newer: alertAt({ id: 'newer', ruleId: 'rule-2', templateId: 'template-1' }),
      deviceId: 'device-1',
      timeDiffMs: 6 * 60 * 1000,
      maxWindowMs: 30 * 60 * 1000,
    });

    expect(evidence).toMatchObject({
      correlationType: 'same_template_temporal',
      confidence: 0.9,
      metadata: {
        templateId: 'template-1',
        evidence: ['same_device', 'time_window', 'same_template'],
      },
    });
  });

  it('captures config-policy item evidence for policy alerts', () => {
    const evidence = buildAlertCorrelationEvidence({
      older: alertAt({ id: 'older', configPolicyId: 'policy-1', configItemName: 'disk-low' }),
      newer: alertAt({ id: 'newer', configPolicyId: 'policy-1', configItemName: 'disk-low' }),
      deviceId: 'device-1',
      timeDiffMs: 9 * 60 * 1000,
      maxWindowMs: 30 * 60 * 1000,
    });

    expect(evidence).toMatchObject({
      correlationType: 'same_config_policy_item_temporal',
      confidence: 0.8,
      metadata: {
        configPolicyId: 'policy-1',
        configItemName: 'disk-low',
        evidence: ['same_device', 'time_window', 'same_config_policy_item'],
      },
    });
  });

  it('builds same-site evidence for different-device alert pairs', () => {
    const evidence = buildAlertCorrelationEvidence({
      older: alertAt({ id: 'older', deviceId: 'device-1', siteId: 'site-1' }),
      newer: alertAt({ id: 'newer', deviceId: 'device-2', siteId: 'site-1' }),
      deviceId: 'device-2',
      timeDiffMs: 3 * 60 * 1000,
      maxWindowMs: 30 * 60 * 1000,
    });

    expect(evidence).toMatchObject({
      correlationType: 'same_site_temporal',
      confidence: 0.9,
      metadata: {
        deviceId: 'device-2',
        parentDeviceId: 'device-1',
        childDeviceId: 'device-2',
        siteId: 'site-1',
        evidence: ['same_site', 'time_window'],
      },
    });
  });

  it('adds shared log-correlation evidence for alert pairs on affected devices', () => {
    const older = alertAt({ id: 'older', deviceId: 'device-1', siteId: 'site-1' });
    const newer = alertAt({ id: 'newer', deviceId: 'device-2', siteId: 'site-1' });
    const logEvidence = findAlertPairLogEvidence({
      older,
      newer,
      logCorrelations: [{
        id: 'log-correlation-1',
        ruleId: 'log-rule-1',
        ruleName: 'Service crash burst',
        severity: 'critical',
        pattern: 'service crashed',
        lastSeen: new Date('2026-06-18T12:00:00.000Z'),
        occurrences: 7,
        affectedDevices: [
          { deviceId: 'device-1', hostname: 'host-1', count: 3 },
          { deviceId: 'device-2', hostname: 'host-2', count: 4 },
        ],
        sampleLogs: [
          {
            id: 'sample-log-1',
            deviceId: 'device-1',
            timestamp: '2026-06-18T11:58:00.000Z',
            level: 'error',
            source: 'system',
            message: 'service crashed',
          },
        ],
      }],
    });

    const evidence = buildAlertCorrelationEvidence({
      older,
      newer,
      deviceId: 'device-2',
      timeDiffMs: 12 * 60 * 1000,
      maxWindowMs: 30 * 60 * 1000,
      logEvidence,
    });

    expect(evidence).toMatchObject({
      correlationType: 'same_site_temporal',
      confidence: 0.7,
      metadata: {
        evidence: ['same_site', 'time_window', 'shared_log_correlation'],
        logCorrelationIds: ['log-correlation-1'],
        logCorrelationRuleIds: ['log-rule-1'],
        logCorrelationRuleNames: ['Service crash burst'],
        logPatterns: ['service crashed'],
        logOccurrences: 7,
        logSeverity: 'critical',
        logSampleLogIds: ['sample-log-1'],
        logDeviceIds: ['device-1', 'device-2'],
      },
    });
  });

  it('distinguishes related log-correlation evidence from shared evidence', () => {
    const logEvidence = findAlertPairLogEvidence({
      older: alertAt({ id: 'older', deviceId: 'device-1', siteId: 'site-1' }),
      newer: alertAt({ id: 'newer', deviceId: 'device-2', siteId: 'site-1' }),
      logCorrelations: [{
        id: 'log-correlation-1',
        ruleId: 'log-rule-1',
        ruleName: 'Repeated auth failures',
        severity: 'warning',
        pattern: 'auth failed',
        lastSeen: new Date('2026-06-18T12:00:00.000Z'),
        occurrences: 4,
        affectedDevices: [{ deviceId: 'device-2', hostname: 'host-2', count: 4 }],
        sampleLogs: null,
      }],
    });

    expect(logEvidence).toMatchObject({
      evidenceType: 'related_log_correlation',
      logCorrelationIds: ['log-correlation-1'],
      logDeviceIds: ['device-2'],
    });
  });

  it('adds flapping evidence from existing rule/device transition tracking', () => {
    const older = alertAt({ id: 'older', deviceId: 'device-1', ruleId: 'rule-1', siteId: 'site-1' });
    const newer = alertAt({ id: 'newer', deviceId: 'device-1', ruleId: 'rule-1', siteId: 'site-1' });
    const flappingEvidence = findAlertPairFlappingEvidence({
      older,
      newer,
      flappingKeys: new Set(['rule:rule-1:device-1']),
    });

    const evidence = buildAlertCorrelationEvidence({
      older,
      newer,
      deviceId: 'device-1',
      timeDiffMs: 8 * 60 * 1000,
      maxWindowMs: 30 * 60 * 1000,
      flappingEvidence,
    });

    expect(evidence).toMatchObject({
      correlationType: 'flapping_temporal',
      confidence: 0.99,
      metadata: {
        flappingDetected: true,
        flappingKeys: ['rule:rule-1:device-1'],
        flappingDeviceIds: ['device-1'],
        flappingRuleIds: ['rule-1'],
        evidence: ['same_device', 'time_window', 'same_rule', 'flapping_suppression'],
      },
    });
  });
});
