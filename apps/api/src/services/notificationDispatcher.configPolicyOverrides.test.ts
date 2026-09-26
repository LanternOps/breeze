import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/** Queued legacy alerts use current routing after retirement. */

const { channelEligibilityMock, selectQueue, queueAddBulkMock, queueAddMock, predicates, selectedFields, selectedTables, resolveDeliveryMock } = vi.hoisted(() => ({
  predicates: [] as SQL[],
  selectedFields: [] as Array<Record<string, unknown> | undefined>,
  selectedTables: [] as unknown[],
  resolveDeliveryMock: vi.fn(),
  channelEligibilityMock: vi.fn(),
  selectQueue: [] as unknown[][],
  queueAddBulkMock: vi.fn(),
  queueAddMock: vi.fn()
}));

vi.mock('../db', () => {
  const makeSelect = () => {
    const chain: any = {
      from: (table: unknown) => { selectedTables.push(table); return chain; },
      where: (predicate: SQL) => { predicates.push(predicate); return chain; },
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
      selectedFields.push(fields);
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

vi.mock('./delivery/resolveDelivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./delivery/resolveDelivery')>();
  resolveDeliveryMock.mockImplementation(actual.resolveDelivery);
  return { ...actual, resolveDelivery: resolveDeliveryMock };
});

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

import { alertRules, configPolicyAlertRules } from '../db/schema';
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
  predicates.length = 0;
  selectedFields.length = 0;
  selectedTables.length = 0;
  resolveDeliveryMock.mockClear();
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

describe('processAlertNotifications legacy delivery retirement', () => {
  it.each(['rule', 'policy'] as const)('queued %s alerts use current routing without legacy delivery reads', async axis => {
    selectQueue.push(
      [makeAlert(axis === 'rule' ? { ruleId: 'old-rule' } : { configPolicyId: 'old-policy-rule' })],
      [{ id: 'device-1', siteId: 'site-1' }],
      ...(axis === 'rule' ? [[]] : []), // No compiled monitor identity.
      ORG_LOOKUP, ORG_LOOKUP,
      [DEFAULT_ROW],
      [{ id: DEFAULT_ROW.channelIds[0] }],
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(selectedTables).not.toContain(configPolicyAlertRules);
    expect(selectedFields.some(fields => fields && 'overrideSettings' in fields)).toBe(false);
    if (axis === 'rule') {
      const predicate = predicates.map(p => new PgDialect().sqlToQuery(p).sql).join('\n');
      expect(predicate).toContain('"alert_rules"."managed_by_monitor_id" is not null');
    }
    expect(resolveDeliveryMock).toHaveBeenCalledExactlyOnceWith({
      orgId: 'org-1', severity: 'high', monitorId: null, siteId: 'site-1',
    });
    expect(result.queued).toBe(1);
    expect(queueAddBulkMock.mock.calls[0]![0][0].data.channelId).toBe(DEFAULT_ROW.channelIds[0]);
    expect(queueAddMock).not.toHaveBeenCalled();
    expect(selectQueue).toHaveLength(0);
  });

  it('uses an existing monitor identity without reading either legacy source', async () => {
    resolveDeliveryMock.mockResolvedValueOnce({ channelIds: [], skippedChannelIds: [], escalationPolicyId: null, source: 'monitor_none' });
    selectQueue.push(
      [makeAlert({ ruleId: 'compiled-rule', configPolicyId: 'old-policy-rule', monitorId: 'monitor-1' })],
      [{ id: 'device-1', siteId: 'site-1' }], ORG_LOOKUP,
    );
    await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(selectedTables).not.toContain(alertRules);
    expect(selectedTables).not.toContain(configPolicyAlertRules);
    expect(resolveDeliveryMock).toHaveBeenCalledExactlyOnceWith({
      orgId: 'org-1', severity: 'high', monitorId: 'monitor-1', siteId: 'site-1',
    });
  });
});
