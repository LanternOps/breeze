import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getJobMock,
  addMock,
  closeMock,
  shouldProduceMlOutputMock,
  persistGroupsMock,
  attachWorkerObservabilityMock,
  isFlappingMock,
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
    insertReturnsEmpty: false,
    insertCalls: 0,
    selectCall: 0,
  };

  const dbMock = {
    select: vi.fn(() => {
      const index = dbState.selectCall;
      dbState.selectCall += 1;
      const chain: any = {
        from: () => chain,
        leftJoin: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () =>
          // Query order: 0=targetDevice, 1=recentAlerts, 3=recentLogCorrelations (all .limit()).
          Promise.resolve(
            index === 0
              ? dbState.targetDevice
              : index === 1
                ? dbState.recentAlerts
                : index === 3
                  ? dbState.recentLogCorrelations
                  : []
          ),
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

vi.mock('../services/alertCooldown', () => ({
  isFlapping: isFlappingMock,
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock,
}));

vi.mock('../db', () => ({
  db: dbMock,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  alerts: {},
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
    isFlappingMock.mockResolvedValue(false);
    shouldProduceMlOutputMock.mockResolvedValue(true);
    persistGroupsMock.mockResolvedValue({ scanned: 0, groupsWritten: 0, membersWritten: 0 });
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queued-correlation-job' });
    dbState.targetDevice = [];
    dbState.recentAlerts = [];
    dbState.existingLinks = [];
    dbState.recentLogCorrelations = [];
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

    expect(result).toEqual({ scanned: 0, created: 0 });
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
    expect(result).toEqual({ scanned: 2, created: 1 });
    expect(persistGroupsMock).toHaveBeenCalledWith({ orgId: 'org-1', alertIds: ['alert-a', 'alert-b'] });
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
    expect(result).toEqual({ scanned: 2, created: 0 });
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
