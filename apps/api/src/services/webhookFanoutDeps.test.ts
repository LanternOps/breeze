import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, eq } from 'drizzle-orm';
import { webhooks } from '../db/schema';

/**
 * `buildWebhookFanoutDeps` — extracted from `index.ts` (wave 3.5d-b, #4086).
 * No prior coverage existed on `index.ts` for this closure; this is fresh
 * coverage for the extracted leaf module.
 */

const {
  selectMock,
  captureExceptionMock,
  recordWebhookDeliveryMock,
  withSystemDbAccessContextMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  recordWebhookDeliveryMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('./webhookDeliveryRecord', () => ({
  recordWebhookDelivery: recordWebhookDeliveryMock,
}));

vi.mock('./sentry', () => ({
  captureException: captureExceptionMock,
}));

import { buildWebhookFanoutDeps } from './webhookFanoutDeps';

function renderSqlQuery(value: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(value as never);
}

function mockRows(rows: unknown[]) {
  selectMock.mockReturnValue({
    from: () => ({
      where: async (condition: unknown) => {
        // Record the condition so tests can assert the compiled SQL, not just
        // that .where() was called (vacuous-Drizzle-assertion memory).
        mockRows.lastCondition = condition;
        return rows;
      },
    }),
  });
}
mockRows.lastCondition = undefined as unknown;

describe('buildWebhookFanoutDeps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRows.lastCondition = undefined;
  });

  it('exposes createDeliveryRecord as recordWebhookDelivery', () => {
    const deps = buildWebhookFanoutDeps();
    expect(deps.createDeliveryRecord).toBe(recordWebhookDeliveryMock);
  });

  describe('getWebhooksForEvent', () => {
    it('queries for org-scoped, active webhooks only (compiled WHERE clause)', async () => {
      mockRows([]);

      const deps = buildWebhookFanoutDeps();
      await deps.getWebhooksForEvent('org-1', 'device.offline');

      const expected = renderSqlQuery(
        and(eq(webhooks.orgId, 'org-1'), eq(webhooks.status, 'active'))
      );
      const actual = renderSqlQuery(mockRows.lastCondition);
      expect(actual).toEqual(expected);
    });

    it('filters to webhooks subscribed to the exact event type', async () => {
      mockRows([
        { id: 'wh-1', orgId: 'org-1', approvalGeneration: 1, events: ['device.offline'] },
        { id: 'wh-2', orgId: 'org-1', approvalGeneration: 1, events: ['device.online'] },
      ]);

      const deps = buildWebhookFanoutDeps();
      const result = await deps.getWebhooksForEvent('org-1', 'device.offline');

      // Site-ceiling gate contract §7E: the returned shape is the lean,
      // UNDECRYPTED WebhookFanoutTarget — id/orgId/approvalGeneration only.
      // `events` is consumed to FILTER but never appears in the output; no
      // decryption happens on this path at all any more.
      expect(result).toEqual([{ id: 'wh-1', orgId: 'org-1', approvalGeneration: 1 }]);
    });

    it('includes wildcard-subscribed webhooks for any event type', async () => {
      mockRows([{ id: 'wh-wild', orgId: 'org-1', approvalGeneration: 1, events: ['*'] }]);

      const deps = buildWebhookFanoutDeps();
      const result = await deps.getWebhooksForEvent('org-1', 'anything.happened');

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('wh-wild');
    });

    it('excludes webhooks with no matching event and no wildcard', async () => {
      mockRows([{ id: 'wh-1', orgId: 'org-1', approvalGeneration: 1, events: ['other.event'] }]);

      const deps = buildWebhookFanoutDeps();
      const result = await deps.getWebhooksForEvent('org-1', 'device.offline');

      expect(result).toEqual([]);
    });

    it('treats a null events column as subscribed to nothing', async () => {
      mockRows([{ id: 'wh-1', orgId: 'org-1', approvalGeneration: 1, events: null }]);

      const deps = buildWebhookFanoutDeps();
      const result = await deps.getWebhooksForEvent('org-1', 'device.offline');

      expect(result).toEqual([]);
    });

    it('never decrypts on this path (site-ceiling gate contract §7E)', async () => {
      // No secret/url/headers columns are even selected any more — decryption
      // happens exactly once, inside the delivery worker at send time. This
      // path cannot throw a decrypt error, so there is nothing to skip/report;
      // the old "skips a row whose decrypt throws" behavior no longer applies.
      mockRows([{ id: 'wh-1', orgId: 'org-1', approvalGeneration: 3, events: ['device.offline'] }]);

      const deps = buildWebhookFanoutDeps();
      const result = await deps.getWebhooksForEvent('org-1', 'device.offline');

      expect(result).toEqual([{ id: 'wh-1', orgId: 'org-1', approvalGeneration: 3 }]);
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('queries via the system DB access context', async () => {
      mockRows([]);

      const deps = buildWebhookFanoutDeps();
      await deps.getWebhooksForEvent('org-1', 'device.offline');

      expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    });
  });
});
