import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 3.5c (#4085) notification-ordering hardening: `cancelAlertEscalations`
 * only removes jobs that are DELAYED at the moment it runs — it is an
 * optimization, not the correctness mechanism. Under queue delivery,
 * `alert.resolved` can process before a retried `alert.triggered` delivery,
 * which would otherwise re-fan-out a baseline send or re-schedule
 * escalations nobody will cancel. These tests cover the durable status
 * guards and stable jobIds in `processAlertNotifications` and
 * `scheduleEscalation`. `processSendNotification`'s own escalation-step
 * guard is covered alongside its other branches in the sibling
 * `notificationDispatcher.test.ts` (same mock harness already lives there).
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

vi.mock('./notificationSenders', () => ({
  sendEmailNotification: vi.fn(),
  getEmailRecipients: vi.fn(),
  sendWebhookNotification: vi.fn(),
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

beforeEach(() => {
  selectQueue.length = 0;
  queueAddBulkMock.mockReset();
  queueAddMock.mockReset();
  sendInAppNotificationMock.mockReset().mockResolvedValue({ success: true, notificationCount: 1 });
});

describe('processAlertNotifications status guard (a)', () => {
  it('no-ops (no addBulk, no in-app send lookups) when the loaded alert is resolved', async () => {
    selectQueue.push([makeAlert({ status: 'resolved' })]);

    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(result).toEqual({ queued: 0, inAppSent: false, durationMs: expect.any(Number) });
    expect(queueAddBulkMock).not.toHaveBeenCalled();
    expect(queueAddMock).not.toHaveBeenCalled();
    // A resolved alert must not even attempt the baseline in-app notification.
    expect(sendInAppNotificationMock).not.toHaveBeenCalled();
  });

  it('still fans out the baseline for an acknowledged alert (only escalations are cancelled on ack)', async () => {
    selectQueue.push(
      [makeAlert({ status: 'acknowledged' })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ partnerId: null }], // org (partnerIdForOrg)
      [], // routing rules (no match)
      [{ id: 'channel-1' }], // org channels fallback
      [{ id: 'channel-1' }] // validChannels
    );

    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(result.queued).toBe(1);
    expect(queueAddBulkMock).toHaveBeenCalledTimes(1);
  });
});

describe('processAlertNotifications baseline send jobId (c)', () => {
  it('enqueues baseline sends with a stable jobId so a retried process-alert cannot duplicate the fan-out', async () => {
    selectQueue.push(
      [makeAlert({ status: 'active' })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ partnerId: null }], // org (partnerIdForOrg)
      [], // routing rules (no match)
      [{ id: 'channel-1' }], // org channels fallback
      [{ id: 'channel-1' }] // validChannels
    );

    await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(queueAddBulkMock).toHaveBeenCalledTimes(1);
    const jobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ opts?: { jobId?: string } }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.opts?.jobId).toBe('alert-send-alert-1-channel-1-0');
  });
});

describe('scheduleEscalation job options (carried Task 8 review handoff)', () => {
  it('gives escalation send jobs attempts/backoff/removal options so a transport failure gets retried instead of permanently occupying the jobId', async () => {
    selectQueue.push(
      [makeAlert({ status: 'active', ruleId: 'rule-1' })], // alert
      [{ id: 'device-1', displayName: 'Server-1' }], // device
      [{ overrideSettings: { notificationChannelIds: ['channel-1'], escalationPolicyId: 'policy-1' } }], // rule
      [{ partnerId: null }], // org (partnerIdForOrg)
      [{ id: 'channel-1' }], // validChannels (baseline)
      [{ id: 'policy-1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['channel-1'] }] }], // escalation policy
      [{ id: 'channel-1' }] // validChannels (escalation)
    );

    await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queueAddMock.mock.calls[0]!;
    expect(name).toBe('send');
    expect(data).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'channel-1', escalationStep: 1 });
    expect(opts).toEqual({
      delay: 5 * 60 * 1000,
      jobId: 'escalation-alert-1-step1-channel-1',
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: { age: 3600 }
    });
  });
});
