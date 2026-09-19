import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Delivery from a rule-less MONITOR alert (#5290).
 *
 * A monitor-sourced alert (the breach-episode / recurrence-escalation path)
 * has `ruleId: null` and `configPolicyId: null`, with `monitorId` set to the
 * `monitor_definitions` row id. Unlike a config-policy alert, there is no
 * `alert_rules`/`config_policy_alert_rules` row to read overrideSettings
 * from, so `processAlertNotifications` sources delivery straight from the
 * monitor definition's own `deliveryMode`:
 *   - 'channels' -> channelIds = monitor.deliveryChannelIds, escalation from
 *     monitor.escalationPolicyId
 *   - 'none' -> inbox-only: suppressChannelFallback skips BOTH the
 *     routing-rule lookup and the org-default-channels fallback
 *   - 'inherit' -> empty channelIds, so the existing routing-rule /
 *     org-default fallbacks run unchanged
 *
 * Mocking preamble and helper style cloned from the sibling
 * `notificationDispatcher.configPolicyOverrides.test.ts` (same `selectQueue`
 * harness, same vi.mock block, same `makeAlert` / `makeJobStub` helpers, same
 * beforeEach).
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
  queueAddBulkMock.mockReset().mockImplementation(async (jobs: unknown[]) =>
    jobs.map((_, i) => makeJobStub(`bulk-job-${i}`))
  );
  queueAddMock.mockReset().mockImplementation(async () => makeJobStub('job-1'));
  sendInAppNotificationMock.mockReset().mockResolvedValue({ success: true, notificationCount: 1 });
  webhookTotalAttemptsMock.mockReset().mockReturnValue(3);
});

describe('processAlertNotifications monitor delivery (#5290)', () => {
  it("routes a rule-less monitor alert to the monitor's own channels and schedules its escalation policy", async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ deliveryMode: 'channels', deliveryChannelIds: ['mc1'], escalationPolicyId: 'ep1' }], // monitor_definitions row
      [{ partnerId: null }], // org (partnerIdForOrg)
      // channelIds came from the monitor (['mc1']) so no routing-rule lookup
      // and no org-default-channels fallback query happens here.
      [{ id: 'mc1' }], // validChannels (baseline)
      [{ id: 'ep1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['mc1'] }] }], // escalation policy
      [{ id: 'mc1' }] // validChannels (escalation)
    );

    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(result.queued).toBe(1);
    expect(queueAddBulkMock).toHaveBeenCalledTimes(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['mc1']);

    // scheduleEscalation is not exported — observe it through its effect:
    // it looks up the escalation policy by id and then schedules a step via
    // queue.add (baseline sends always go through addBulk, never add()).
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [name, data] = queueAddMock.mock.calls[0]!;
    expect(name).toBe('send');
    expect(data).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'mc1', escalationStep: 1 });
  });

  it('delivery_mode none suppresses every channel send and never falls back to org defaults', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ deliveryMode: 'none', deliveryChannelIds: [], escalationPolicyId: null }], // monitor_definitions row
      [{ partnerId: null }], // org (partnerIdForOrg)
      // Poison entries: a real org-default channel primed behind the
      // fallback queries `suppressChannelFallback` must skip. If it
      // regressed to `false`, the routing-rule lookup (empty, no match)
      // and then the org-default-channels lookup below WOULD be reached,
      // consuming these two entries and picking up 'should-not-be-used',
      // which would then resolve through validChannels and get queued —
      // an observable `result.queued === 1` instead of `0`. Under the
      // correct (suppressed) behavior these three entries are never
      // consumed and sit inert in `selectQueue`.
      [], // routing rules — would be consumed only on a regression
      [{ id: 'should-not-be-used' }], // org channels fallback — must never be reached
      [{ id: 'should-not-be-used' }] // validChannels — must never be reached
    );

    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(result.queued).toBe(0);
    expect(queueAddBulkMock).not.toHaveBeenCalled();
    expect(result.inAppSent).toBe(true);
  });

  it('delivery_mode inherit falls back to routing / org default channels', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null }], // monitor_definitions row
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

  it('an alert with a ruleId is unaffected by the monitor branch', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: 'rule-1', monitorId: 'monitor-1' })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ overrideSettings: { notificationChannelIds: ['channel-1'] } }], // rule — the monitorId is never read
      [{ partnerId: null }], // org (partnerIdForOrg)
      [{ id: 'channel-1' }] // validChannels (baseline)
    );

    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['channel-1']);

    // No escalationPolicyId on the rule's overrideSettings → no escalation.
    expect(queueAddMock).not.toHaveBeenCalled();
  });
});
