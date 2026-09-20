import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Monitor delivery, default-row routing, and independent escalation through resolveDelivery. */

const { channelEligibilityMock, selectQueue, queueAddBulkMock, queueAddMock, queueDelayedMock } = vi.hoisted(() => ({
  channelEligibilityMock: vi.fn(),
  selectQueue: [] as unknown[][],
  queueAddBulkMock: vi.fn(),
  queueDelayedMock: vi.fn(),
  queueAddMock: vi.fn()
}));

vi.mock('../db', () => {
  const makeSelect = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (value: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(selectQueue.shift() ?? []).then(resolve, reject)
    };
    return chain;
  };
  return {
    db: { select: vi.fn((fields?: Record<string, unknown>) => {
      if (fields && 'enabled' in fields && 'orgId' in fields && 'partnerId' in fields) {
        return { from: () => ({ where: () => channelEligibilityMock() }) };
      }
      return makeSelect();
    }) },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn())
  };
});

vi.mock('bullmq', () => ({
  Queue: class {
    addBulk = queueAddBulkMock;
    add = queueAddMock;
    getDelayed = queueDelayedMock;
  },
  Worker: class {},
  Job: class {}
}));

vi.mock('./redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  isRedisAvailable: vi.fn(() => false),
  getRedis: vi.fn(() => ({}))
}));

vi.mock('./rate-limit', () => ({
  rateLimiter: vi.fn()
}));

vi.mock('./notificationThrottle', () => ({
  checkNotificationThrottle: vi.fn()
}));

vi.mock('./auditService', () => ({
  createAuditLogAsync: vi.fn()
}));

vi.mock('./alertConditions', () => ({
  interpolateTemplate: vi.fn((template: string) => template)
}));

vi.mock('./notificationChannelSecrets', () => ({
  decryptNotificationChannelConfig: vi.fn((_type: string, config: unknown) => config)
}));

const sendInAppNotificationMock = vi.hoisted(() => vi.fn());
const webhookTotalAttemptsMock = vi.hoisted(() => vi.fn(() => 3));

vi.mock('./notificationSenders', () => ({
  sendEmailNotification: vi.fn(),
  getEmailRecipients: vi.fn(),
  sendWebhookNotification: vi.fn(),
  webhookTotalAttempts: webhookTotalAttemptsMock,
  sendInAppNotification: sendInAppNotificationMock,
  sendPagerDutyNotification: vi.fn(),
  sendPushoverNotification: vi.fn()
}));

vi.mock('./notificationSenders/smsSender', () => ({
  sendSmsNotification: vi.fn()
}));

import { processAlertNotifications, cancelAlertEscalations } from './notificationDispatcher';

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    ruleId: null,
    deviceId: 'device-1',
    orgId: 'org-1',
    configPolicyId: null,
    configItemName: null,
    monitorId: null,
    status: 'active',
    severity: 'high',
    title: 'CPU High',
    message: 'CPU usage above threshold',
    context: null,
    triggeredAt: new Date('2026-09-11T00:00:00.000Z'),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    suppressedUntil: null,
    dismissedAt: null,
    dismissedBy: null,
    createdAt: new Date('2026-09-10T00:00:00.000Z'),
    ...overrides
  };
}

function makeJobStub(id: string, state: string = 'waiting') {
  return { id, getState: vi.fn().mockResolvedValue(state), retry: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  selectQueue.length = 0;
  queueDelayedMock.mockReset().mockResolvedValue([]);
  channelEligibilityMock.mockReset().mockResolvedValue(
    ['aaaaaaaa-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-000000000013', 'aaaaaaaa-0000-4000-8000-000000000014']
      .map(id => ({ id, orgId: 'org-1', partnerId: null, enabled: true })),
  );
  queueAddBulkMock.mockReset().mockImplementation(async (jobs: unknown[]) =>
    jobs.map((_, i) => makeJobStub(`bulk-job-${i}`))
  );
  queueAddMock.mockReset().mockImplementation(async () => makeJobStub('job-1'));
  sendInAppNotificationMock.mockReset().mockResolvedValue({ success: true, notificationCount: 1 });
  webhookTotalAttemptsMock.mockReset().mockReturnValue(3);
});

const ORG_LOOKUP = [{ partnerId: null }];
const DEFAULT_ROW = {
  id: 'default-row', orgId: 'org-1', partnerId: null, name: 'Everything else', priority: 1000000,
  conditions: {}, channelIds: ['aaaaaaaa-0000-4000-8000-000000000014'], enabled: true, escalationPolicyId: null, isDefault: true,
};

describe('processAlertNotifications monitor delivery (#5290, on resolveDelivery since W05b)', () => {
  it("routes a rule-less monitor alert to the monitor's own channels and schedules its escalation policy", async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })], // 1 alert
      [{ id: 'device-1', displayName: 'Server-1' }], // 2 device
      ORG_LOOKUP, // 4 org (dispatcher)
      ORG_LOOKUP, // 5 org (resolver)
      [{ kind: 'cpu', deliveryMode: 'channels', deliveryChannelIds: ['aaaaaaaa-0000-4000-8000-000000000011'], escalationPolicyId: 'ep1' }], // 6 monitor
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }], // 8 validChannels (baseline)
      [{ id: 'ep1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000011'] }] }], // 9 escalation policy
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }] // 9 validChannels (escalation)
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000011']);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'aaaaaaaa-0000-4000-8000-000000000011', escalationStep: 1 });
  });

  it('delivery_mode none is inbox only: no channel send, no routing lookup, no escalation', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'none', deliveryChannelIds: [], escalationPolicyId: 'ep1' }],
      // Poison: consumed only on a regression (routing rows, validChannels).
      [DEFAULT_ROW],
      [{ id: 'should-not-be-used' }]
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(0);
    expect(result.inAppSent).toBe(true);
    expect(queueAddBulkMock).not.toHaveBeenCalled();
    expect(queueAddMock).not.toHaveBeenCalled(); // 'none' drops the monitor's escalation too
    expect(selectQueue).toHaveLength(2);
  });

  it('delivery_mode inherit resolves through routing rows and ends at the Everything else row', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null }],
      [DEFAULT_ROW], // 7 routing rows: only the default row
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000014' }] // 8 validChannels
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000014']);
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('inherit with no routing rows and no Everything else row is inbox only — the all-channels fallback is gone', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null }],
      [], // routing rows
      [{ id: 'should-not-be-used' }] // poison: the old fallback query
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(0);
    expect(queueAddBulkMock).not.toHaveBeenCalled();
    expect(selectQueue).toHaveLength(1);
  });

  it('inherit + monitor escalation policy schedules escalation even when delivery is inbox only', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: 'ep1' }],
      [], // routing rows → source 'none'
      [{ id: 'ep1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000011'] }] }], // escalation policy
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }] // validChannels (escalation)
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(0);
    expect(queueAddBulkMock).not.toHaveBeenCalled();
    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });

  it('an alert with both ruleId and monitorId resolves from the MONITOR, not the compiled rule\'s overrideSettings', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: 'rule-1', monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ overrideSettings: { notificationChannelIds: ['stale-compiled'] }, managedByMonitorId: 'monitor-1' }], // 3 rule (managed)
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'channels', deliveryChannelIds: ['aaaaaaaa-0000-4000-8000-000000000011'], escalationPolicyId: null }],
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }]
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000011']);
  });

  it('an UNMANAGED rule keeps its overrideSettings (transitional legacy override, W05b → W05d)', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: 'rule-1', monitorId: null })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ overrideSettings: { notificationChannelIds: ['aaaaaaaa-0000-4000-8000-000000000013'] }, managedByMonitorId: null }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000013' }] // validChannels — no monitor read, no routing read
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    expect(queueAddMock).not.toHaveBeenCalled();
    expect(selectQueue).toHaveLength(0);
  });

  it('inherit escalation survives filtering all disabled baseline channels', async () => {
    channelEligibilityMock.mockResolvedValueOnce([{ id: 'aaaaaaaa-0000-4000-8000-000000000014', orgId: 'org-1', partnerId: null, enabled: false }]);
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }], ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: 'ep1' }],
      [DEFAULT_ROW],
      [{ id: 'ep1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000011'] }] }],
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }],
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(0);
    expect(queueAddBulkMock).not.toHaveBeenCalled();
    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });
});

it('cancels channel and user repetitions but leaves baseline jobs alone', async () => {
  const jobs = [
    { type: 'send', alertId: 'alert-1', channelId: 'c', escalationStep: 11 },
    { type: 'escalation-user', alertId: 'alert-1', userId: 'u', escalationStep: 21 },
    { type: 'send', alertId: 'alert-1', channelId: 'c' },
  ].map(data => ({ data, remove: vi.fn(async () => {}) }));
  queueDelayedMock.mockResolvedValue(jobs);
  expect(await cancelAlertEscalations('alert-1')).toBe(2);
  expect(jobs[2]!.remove).not.toHaveBeenCalled();
});
