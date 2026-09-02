import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `processSendNotification`'s send-identity state machine (wave 3.5c,
 * #4085): (alertId, channelId, escalationStep) is a durable per-channel send
 * identity backed by a unique index (migration
 * 2026-09-11-f-alert-notifications-send-identity.sql). The CLAIM/SUCCESS CAS
 * predicate is asserted as COMPILED SQL in the sibling
 * `notificationDispatcher.claimCasSql.test.ts` — this file mocks `../db`, so
 * a `where` assertion here can only structurally compare the predicate
 * object built by the real (unmocked) drizzle-orm; it cannot prove what SQL
 * it compiles to (vacuous-Drizzle-assertion rule).
 */

const {
  selectResults,
  selectWheres,
  insertValuesMock,
  insertConflictMock,
  insertReturningMock,
  updateSetMock,
  updateWhereMock,
  updateReturningMock,
  sendWebhookNotificationMock,
  isRedisAvailableMock,
  getRedisMock,
  rateLimiterMock,
  checkNotificationThrottleMock,
  createAuditLogAsyncMock
} = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  selectWheres: [] as unknown[],
  insertValuesMock: vi.fn(),
  insertConflictMock: vi.fn(),
  insertReturningMock: vi.fn(),
  updateSetMock: vi.fn(),
  updateWhereMock: vi.fn(),
  updateReturningMock: vi.fn(),
  sendWebhookNotificationMock: vi.fn(),
  isRedisAvailableMock: vi.fn(() => false),
  getRedisMock: vi.fn(() => ({})),
  rateLimiterMock: vi.fn(),
  checkNotificationThrottleMock: vi.fn(),
  createAuditLogAsyncMock: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: (w: unknown) => {
          selectWheres.push(w);
          return { limit: () => Promise.resolve(selectResults.shift() ?? []) };
        }
      })
    })),
    insert: vi.fn(() => ({
      values: (...args: unknown[]) => {
        insertValuesMock(...args);
        return {
          onConflictDoNothing: (config: unknown) => {
            insertConflictMock(config);
            return { returning: insertReturningMock };
          }
        };
      }
    })),
    update: vi.fn(() => ({
      set: (...args: unknown[]) => {
        updateSetMock(...args);
        return {
          where: (...whereArgs: unknown[]) => {
            updateWhereMock(...whereArgs);
            // Some call sites chain `.returning()`, others just `await` the
            // `where(...)` result directly — support both, matching the real
            // Drizzle builder.
            const chain: Record<string, unknown> = { returning: updateReturningMock };
            chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
            return chain;
          }
        };
      }
    }))
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn()
}));

vi.mock('./redis', () => ({
  getRedis: getRedisMock,
  getBullMQConnection: vi.fn(() => ({})),
  // Rate limiting requires Redis; disabled by default so most tests stay
  // focused on the send-identity state machine rather than the rate-limit
  // branch. Individual tests flip this on to exercise that branch.
  isRedisAvailable: isRedisAvailableMock
}));

vi.mock('./rate-limit', () => ({
  rateLimiter: rateLimiterMock
}));

vi.mock('./notificationThrottle', () => ({
  checkNotificationThrottle: checkNotificationThrottleMock
}));

vi.mock('./auditService', () => ({
  createAuditLogAsync: createAuditLogAsyncMock
}));

vi.mock('./notificationChannelSecrets', () => ({
  decryptNotificationChannelConfig: vi.fn((_type: string, config: unknown) => config)
}));

vi.mock('./notificationSenders', () => ({
  sendEmailNotification: vi.fn(),
  getEmailRecipients: vi.fn(),
  sendWebhookNotification: sendWebhookNotificationMock,
  sendInAppNotification: vi.fn(),
  sendPagerDutyNotification: vi.fn(),
  sendPushoverNotification: vi.fn()
}));

vi.mock('./notificationSenders/smsSender', () => ({
  sendSmsNotification: vi.fn()
}));

import { alertNotifications } from '../db/schema';
import {
  processSendNotification,
  buildAlertNotificationClaimCas,
  type SendNotificationJobData
} from './notificationDispatcher';

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

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'channel-1',
    orgId: 'org-1',
    partnerId: null,
    name: 'Webhook Channel',
    type: 'webhook',
    config: {},
    templates: null,
    enabled: true,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestError: null,
    throttleMaxPerWindow: null,
    throttleWindowSeconds: 3600,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides
  };
}

function makeNotificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    alertId: 'alert-1',
    channelId: 'channel-1',
    escalationStep: 0,
    status: 'pending',
    sentAt: null,
    errorMessage: null,
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    ...overrides
  };
}

const baseData: SendNotificationJobData = {
  type: 'send',
  alertId: 'alert-1',
  channelId: 'channel-1'
};

/** Queues the alert/org/channel selects every prepare-phase run needs. */
function queuePrepareSelects(alert = makeAlert(), org: unknown = { partnerId: null }, channel = makeChannel()) {
  selectResults.push([alert], [org], [channel]);
}

/** Queues the device + org selects made after the send-identity row is settled. */
function queueDeviceOrgSelects(device: unknown[] = [], org: unknown[] = []) {
  selectResults.push(device, org);
}

beforeEach(() => {
  selectResults.length = 0;
  selectWheres.length = 0;
  insertValuesMock.mockReset();
  insertConflictMock.mockReset();
  insertReturningMock.mockReset();
  updateSetMock.mockReset();
  updateWhereMock.mockReset();
  updateReturningMock.mockReset();
  sendWebhookNotificationMock.mockReset();
  isRedisAvailableMock.mockReset().mockReturnValue(false);
  getRedisMock.mockReset().mockReturnValue({});
  rateLimiterMock.mockReset();
  checkNotificationThrottleMock.mockReset();
  createAuditLogAsyncMock.mockReset();
});

describe('processSendNotification send-identity state machine', () => {
  it('(a) first invocation inserts pending with escalationStep collapsed via ?? 0, even for an explicit null', async () => {
    queuePrepareSelects();
    insertReturningMock.mockResolvedValueOnce([makeNotificationRow()]);
    queueDeviceOrgSelects([{ id: 'device-1', displayName: 'Server-1' }], [{ id: 'org-1', name: 'Acme' }]);
    sendWebhookNotificationMock.mockResolvedValue({ success: true });

    // BullMQ round-trips job data through Redis as JSON; an explicit
    // `escalationStep: null` must still collapse onto step 0 — a schema
    // column default alone would not stop it, since Drizzle sends the
    // literal null rather than omitting the key.
    const data = { ...baseData, escalationStep: null } as unknown as SendNotificationJobData;

    const result = await processSendNotification(data);

    expect(result.success).toBe(true);
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledWith({
      alertId: 'alert-1',
      channelId: 'channel-1',
      escalationStep: 0,
      status: 'pending'
    });
  });

  it('(a2) an explicit escalationStep is preserved as-is', async () => {
    queuePrepareSelects();
    insertReturningMock.mockResolvedValueOnce([makeNotificationRow({ escalationStep: 2 })]);
    queueDeviceOrgSelects();
    sendWebhookNotificationMock.mockResolvedValue({ success: true });

    await processSendNotification({ ...baseData, escalationStep: 2 });

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ escalationStep: 2 })
    );
  });

  it('(b) a retry after a crashed pending row REUSES that row: no second insert, claim targets the identity triple', async () => {
    queuePrepareSelects();
    // Insert conflicts: a row for this identity already exists.
    insertReturningMock.mockResolvedValueOnce([]);
    // Existing row is the orphaned 'pending' row from a prior crashed attempt.
    const existing = makeNotificationRow({ id: 'notif-existing', status: 'pending' });
    selectResults.push([existing]);
    // Claim succeeds.
    const claimed = { ...existing, status: 'pending', errorMessage: null };
    updateReturningMock.mockResolvedValueOnce([claimed]);
    queueDeviceOrgSelects();
    sendWebhookNotificationMock.mockResolvedValue({ success: true });

    const result = await processSendNotification(baseData);

    expect(result.success).toBe(true);
    // No second insert — the row is reused, not duplicated.
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    // The onConflictDoNothing target is the exact send-identity triple —
    // real (unmocked) schema columns, so a dropped/reordered column fails
    // this comparison by reference.
    expect(insertConflictMock).toHaveBeenCalledWith({
      target: [alertNotifications.alertId, alertNotifications.channelId, alertNotifications.escalationStep]
    });
    // Two update calls total: the claim, then the final success CAS below.
    // The claim update's WHERE is the claim CAS for the EXISTING row's id —
    // compiled-SQL assertion for this predicate lives in the sql.test.ts
    // sibling; here we only prove the state machine calls the shared builder
    // with the right id, not some other predicate.
    expect(updateWhereMock).toHaveBeenCalledTimes(2);
    expect(updateWhereMock.mock.calls[0]![0]).toEqual(buildAlertNotificationClaimCas('notif-existing'));
    expect(updateSetMock.mock.calls[0]![0]).toEqual({ status: 'pending', errorMessage: null });
  });

  it('(c) an existing sent row is a dedupe skip: job completes, NO egress call', async () => {
    queuePrepareSelects();
    insertReturningMock.mockResolvedValueOnce([]);
    selectResults.push([makeNotificationRow({ id: 'notif-existing', status: 'sent' })]);

    const result = await processSendNotification(baseData);

    expect(result.success).toBe(true);
    expect(sendWebhookNotificationMock).not.toHaveBeenCalled();
    // Dedupe win — never touches the row again (no claim update).
    expect(updateWhereMock).not.toHaveBeenCalled();
  });

  it('(c2) losing the claim race (row reaches sent between select and claim) is treated the same as an already-sent skip', async () => {
    queuePrepareSelects();
    insertReturningMock.mockResolvedValueOnce([]);
    selectResults.push([makeNotificationRow({ id: 'notif-existing', status: 'pending' })]);
    // The CAS update matches zero rows: some other attempt already reached 'sent'.
    updateReturningMock.mockResolvedValueOnce([]);

    const result = await processSendNotification(baseData);

    expect(result.success).toBe(true);
    expect(sendWebhookNotificationMock).not.toHaveBeenCalled();
  });

  it('rate-limit CAS: losing the race (another attempt already delivered) skips silently instead of reporting rate-limited failure', async () => {
    isRedisAvailableMock.mockReturnValue(true);
    rateLimiterMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date('2026-09-11T01:00:00.000Z')
    });
    queuePrepareSelects();
    const record = makeNotificationRow();
    insertReturningMock.mockResolvedValueOnce([record]);
    queueDeviceOrgSelects();
    // Zero rows: the CAS excludes only 'sent' — another attempt already
    // delivered this exact send identity between our claim and this write.
    updateReturningMock.mockResolvedValueOnce([]);

    const result = await processSendNotification(baseData);

    expect(result).toEqual({ success: true, channelType: 'webhook', durationMs: expect.any(Number) });
    expect(sendWebhookNotificationMock).not.toHaveBeenCalled();
    expect(updateWhereMock.mock.calls[0]![0]).toEqual(buildAlertNotificationClaimCas('notif-1'));
  });

  it('throttle CAS: losing the race (another attempt already delivered) skips silently, no misleading audit log', async () => {
    checkNotificationThrottleMock.mockResolvedValue({
      allowed: false,
      currentCount: 10,
      windowExpiresAt: Date.parse('2026-09-11T01:00:00.000Z')
    });
    const channel = makeChannel({ throttleMaxPerWindow: 5 });
    queuePrepareSelects(makeAlert(), { partnerId: null }, channel);
    const record = makeNotificationRow();
    insertReturningMock.mockResolvedValueOnce([record]);
    queueDeviceOrgSelects();
    // Zero rows: another attempt already delivered this exact send identity —
    // nothing was actually suppressed by this throttle check.
    updateReturningMock.mockResolvedValueOnce([]);

    const result = await processSendNotification(baseData);

    expect(result).toEqual({ success: true, channelType: 'webhook', durationMs: expect.any(Number) });
    expect(sendWebhookNotificationMock).not.toHaveBeenCalled();
    // No audit log for a suppression that didn't actually happen.
    expect(createAuditLogAsyncMock).not.toHaveBeenCalled();
    expect(updateWhereMock.mock.calls[0]![0]).toEqual(buildAlertNotificationClaimCas('notif-1'));
  });

  it('(d) a transport failure CASes the row to failed (guarded, status <> sent) AND throws (so BullMQ actually retries)', async () => {
    queuePrepareSelects();
    const record = makeNotificationRow();
    insertReturningMock.mockResolvedValueOnce([record]);
    queueDeviceOrgSelects();
    sendWebhookNotificationMock.mockResolvedValue({ success: false, error: 'endpoint unreachable' });
    // The CAS matches (this attempt still holds the claim) — one row written.
    updateReturningMock.mockResolvedValueOnce([{ ...record, status: 'failed' }]);

    await expect(processSendNotification(baseData)).rejects.toThrow('endpoint unreachable');

    // sentAt: null guards against a failed row reading as failed-with-sentAt
    // (only relevant if it was ever set, but keeps the row's shape honest).
    expect(updateSetMock).toHaveBeenCalledWith({
      status: 'failed',
      sentAt: null,
      errorMessage: 'endpoint unreachable'
    });
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
    // Same predicate as the success CAS — NOT a bare `eq(id, ...)`. Two
    // concurrent attempts can share one row id after the conflict-claim
    // path, so an unguarded write here could stomp a 'sent' row written by
    // the other (winning) attempt back to 'failed', and a subsequent retry
    // would then re-claim and RE-SEND. Compiled-SQL proof of what this
    // predicate actually means lives in notificationDispatcher.claimCasSql.test.ts.
    expect(updateWhereMock.mock.calls[0]![0]).toEqual(buildAlertNotificationClaimCas('notif-1'));
  });

  it('(d2) losing the failure-write CAS (another attempt already delivered) resolves success instead of throwing', async () => {
    queuePrepareSelects();
    const record = makeNotificationRow();
    insertReturningMock.mockResolvedValueOnce([record]);
    queueDeviceOrgSelects();
    sendWebhookNotificationMock.mockResolvedValue({ success: false, error: 'endpoint unreachable' });
    // Zero rows: the CAS excludes only 'sent', so this can only mean the
    // OTHER concurrent attempt already delivered this exact send identity
    // between our claim and this write.
    updateReturningMock.mockResolvedValueOnce([]);

    const result = await processSendNotification(baseData);

    // A spurious 'failed' job here would only trigger a pointless BullMQ
    // retry (the dedupe skip would just no-op it again) — resolve success
    // instead of throwing.
    expect(result).toEqual({
      success: true,
      channelType: 'webhook',
      error: undefined,
      durationMs: expect.any(Number)
    });
  });

  it('(e) success CASes the row to sent, guarded by status <> sent', async () => {
    queuePrepareSelects();
    const record = makeNotificationRow();
    insertReturningMock.mockResolvedValueOnce([record]);
    queueDeviceOrgSelects();
    sendWebhookNotificationMock.mockResolvedValue({ success: true });

    const result = await processSendNotification(baseData);

    expect(result.success).toBe(true);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'sent', errorMessage: null })
    );
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
    expect(updateWhereMock.mock.calls[0]![0]).toEqual(buildAlertNotificationClaimCas('notif-1'));
  });

  it('channel not found is still a deliberate skip (unchanged): no insert attempted', async () => {
    selectResults.push([makeAlert()], [{ partnerId: null }], []);

    const result = await processSendNotification(baseData);

    expect(result.success).toBe(false);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  describe('(b) escalation status guard — reloads the alert at fire time', () => {
    it('skips egress and touches no alert_notifications row when the alert is no longer active (acknowledged)', async () => {
      // Only the alert re-load is consumed — the guard fires before the
      // channel lookup, the send-identity insert/claim, or any DB write.
      selectResults.push([makeAlert({ status: 'acknowledged' })]);

      const result = await processSendNotification({ ...baseData, escalationStep: 1 });

      expect(result.success).toBe(true);
      expect(sendWebhookNotificationMock).not.toHaveBeenCalled();
      expect(insertValuesMock).not.toHaveBeenCalled();
      expect(updateWhereMock).not.toHaveBeenCalled();
      expect(selectWheres).toHaveLength(1);
    });

    it('skips egress when the alert has since resolved', async () => {
      selectResults.push([makeAlert({ status: 'resolved' })]);

      const result = await processSendNotification({ ...baseData, escalationStep: 2 });

      expect(result.success).toBe(true);
      expect(sendWebhookNotificationMock).not.toHaveBeenCalled();
      expect(insertValuesMock).not.toHaveBeenCalled();
    });

    it('still sends an escalation step when the alert is active', async () => {
      queuePrepareSelects(makeAlert({ status: 'active' }));
      insertReturningMock.mockResolvedValueOnce([makeNotificationRow({ escalationStep: 1 })]);
      queueDeviceOrgSelects();
      sendWebhookNotificationMock.mockResolvedValue({ success: true });

      const result = await processSendNotification({ ...baseData, escalationStep: 1 });

      expect(result.success).toBe(true);
      expect(sendWebhookNotificationMock).toHaveBeenCalledTimes(1);
    });

    it('does not apply the active-status guard to a baseline send (escalationStep 0/undefined)', async () => {
      queuePrepareSelects(makeAlert({ status: 'acknowledged' }));
      insertReturningMock.mockResolvedValueOnce([makeNotificationRow()]);
      queueDeviceOrgSelects();
      sendWebhookNotificationMock.mockResolvedValue({ success: true });

      const result = await processSendNotification(baseData);

      expect(result.success).toBe(true);
      expect(sendWebhookNotificationMock).toHaveBeenCalledTimes(1);
    });
  });
});
