import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Delivery parity for config-policy alerts (#5289 Task 9, spec §Delivery).
 *
 * An alert raised from a config policy has `ruleId: null` and
 * `configPolicyId` set to the `config_policy_alert_rules` row id (the
 * column name is historical — it does not point at `configuration_policies`
 * directly). Before this fix, `processAlertNotifications` only read
 * channel/escalation overrides from `alertRules.overrideSettings` when
 * `alert.ruleId` was set, so a config-policy alert always fell back to org
 * default channels and never scheduled an escalation, even when its
 * `config_policy_alert_rules` row had `escalationPolicyId`/
 * `notificationChannelIds` configured.
 *
 * Mocking preamble copied from the sibling
 * `notificationDispatcher.orderingGuards.test.ts` (same file, same harness
 * shape already proven against `processAlertNotifications`).
 */

const { channelEligibilityMock, selectQueue, queueAddBulkMock, queueAddMock } = vi.hoisted(() => ({
  channelEligibilityMock: vi.fn(),
  selectQueue: [] as unknown[][],
  queueAddBulkMock: vi.fn(),
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
    getDelayed = async () => [];
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

import { processAlertNotifications } from './notificationDispatcher';

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    ruleId: null,
    deviceId: 'device-1',
    orgId: 'org-1',
    configPolicyId: null,
    configItemName: null,
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

describe('processAlertNotifications config-policy delivery overrides (#5289 Task 9, on resolveDelivery since W05b)', () => {
  it('routes to the config-policy rule channels and schedules its escalation policy (transitional legacy override)', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: 'cpar1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ escalationPolicyId: 'e1', notificationChannelIds: ['aaaaaaaa-0000-4000-8000-000000000012'] }], // 3 config_policy_alert_rules row
      ORG_LOOKUP, ORG_LOOKUP,
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000012' }], // 8 validChannels (baseline)
      [{ id: 'e1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000012'] }] }], // 9 policy
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000012' }] // 9 validChannels (escalation)
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000012']);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'aaaaaaaa-0000-4000-8000-000000000012', escalationStep: 1 });
  });

  it('with no delivery overrides, resolves through routing rows to the Everything else row and skips escalation', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: 'cpar2' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ escalationPolicyId: null, notificationChannelIds: null }],
      ORG_LOOKUP, ORG_LOOKUP,
      [DEFAULT_ROW], // 7 routing rows
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000014' }] // 8 validChannels
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000014']);
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('leaves the unmanaged rule-based path unaffected', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: 'rule-1', configPolicyId: null })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ overrideSettings: { notificationChannelIds: ['aaaaaaaa-0000-4000-8000-000000000013'], escalationPolicyId: 'policy-1' }, managedByMonitorId: null }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000013' }],
      [{ id: 'policy-1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000013'] }] }],
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000013' }]
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'aaaaaaaa-0000-4000-8000-000000000013', escalationStep: 1 });
  });
});
