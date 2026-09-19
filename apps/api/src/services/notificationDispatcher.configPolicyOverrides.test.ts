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

const { selectQueue, queueAddBulkMock, queueAddMock } = vi.hoisted(() => ({
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
    db: { select: vi.fn(() => makeSelect()) },
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
  queueAddBulkMock.mockReset().mockImplementation(async (jobs: unknown[]) =>
    jobs.map((_, i) => makeJobStub(`bulk-job-${i}`))
  );
  queueAddMock.mockReset().mockImplementation(async () => makeJobStub('job-1'));
  sendInAppNotificationMock.mockReset().mockResolvedValue({ success: true, notificationCount: 1 });
  webhookTotalAttemptsMock.mockReset().mockReturnValue(3);
});

describe('processAlertNotifications config-policy delivery overrides (#5289 Task 9)', () => {
  it('routes to the config-policy rule channels and schedules its escalation policy', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: 'cpar1' })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ escalationPolicyId: 'e1', notificationChannelIds: ['c1'] }], // config_policy_alert_rules row
      [{ partnerId: null }], // org (partnerIdForOrg)
      // channelIds came from the cpRule (['c1']) so no routing-rule lookup
      // and no org-default-channels fallback query happens here.
      [{ id: 'c1' }], // validChannels (baseline)
      [{ id: 'e1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['c1'] }] }], // escalation policy
      [{ id: 'c1' }] // validChannels (escalation)
    );

    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(result.queued).toBe(1);
    expect(queueAddBulkMock).toHaveBeenCalledTimes(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['c1']);

    // scheduleEscalation is not exported — observe it through its effect:
    // it looks up the escalation policy by id and then schedules a step via
    // queue.add (baseline sends always go through addBulk, never add()).
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [name, data] = queueAddMock.mock.calls[0]!;
    expect(name).toBe('send');
    expect(data).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'c1', escalationStep: 1 });
  });

  it('falls back to routing/org channels and skips escalation when the config-policy rule has no delivery overrides', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: 'cpar2' })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ escalationPolicyId: null, notificationChannelIds: null }], // config_policy_alert_rules row, no overrides
      [{ partnerId: null }], // org (partnerIdForOrg)
      [], // routing rules (no match)
      [{ id: 'org-default-channel' }], // org channels fallback
      [{ id: 'org-default-channel' }] // validChannels
    );

    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['org-default-channel']);

    // No escalationPolicyId → scheduleEscalation must never run.
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('leaves the existing rule-based path unaffected', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: 'rule-1', configPolicyId: null })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ overrideSettings: { notificationChannelIds: ['channel-1'], escalationPolicyId: 'policy-1' } }], // rule
      [{ partnerId: null }], // org (partnerIdForOrg)
      [{ id: 'channel-1' }], // validChannels (baseline)
      [{ id: 'policy-1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['channel-1'] }] }], // escalation policy
      [{ id: 'channel-1' }] // validChannels (escalation)
    );

    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['channel-1']);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [, data] = queueAddMock.mock.calls[0]!;
    expect(data).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'channel-1', escalationStep: 1 });
  });
});
