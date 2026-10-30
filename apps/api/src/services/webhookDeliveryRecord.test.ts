import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behaviour of the outcome writer.
 *
 * This lived as an anonymous closure inside `index.ts`, which is excluded from
 * coverage — so neither its CAS nor its zero-row branch was reachable by any
 * test. The predicates themselves are pinned as compiled SQL in the sibling
 * `.sql.test.ts`; this file covers what the writer DOES.
 */

interface UpdateCall { table: string; set: Record<string, unknown>; where: unknown }

const state = vi.hoisted(() => ({
  insert: vi.fn(),
  select: vi.fn(),
  updateCalls: [] as UpdateCall[],
  updateResults: [] as Record<string, unknown>[][]
}));

vi.mock('../db', () => {
  const makeUpdate = (table: { _: { name?: string } } | unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (predicate: unknown) => {
        const record = () => {
          const name = (table as { [k: symbol]: unknown; _?: { name?: string } })?._?.name
            ?? 'unknown';
          state.updateCalls.push({ table: name, set: values, where: predicate });
          return state.updateResults.shift() ?? [];
        };
        // `.returning()` when the caller wants rows back; awaiting the builder
        // directly when it does not (the aggregate write).
        return {
          returning: async () => record(),
          then: (res: (v: unknown) => unknown) => Promise.resolve(record()).then(res)
        };
      }
    })
  });
  return {
    db: { update: makeUpdate, insert: state.insert, select: state.select },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn()
  };
});

import { claimDeliveryForExecution, releaseDeliveryClaim, recordDeliveryOutcome, recordWebhookDelivery } from './webhookDeliveryRecord';

const RESULT = {
  deliveryId: 'delivery-1',
  webhookId: 'webhook-1',
  eventId: 'event-1',
  eventType: 'alert.triggered',
  success: true,
  attempts: 1,
  responseStatus: 200,
  responseTimeMs: 12,
  deliveredAt: '2026-09-11T12:00:00.000Z'
};

const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => c.map(String).join(' '));

const structured = (ls: string[], id: string) => {
  const line = ls.find((l) => l.includes(id));
  expect(line, `no console line carried ${id}`).toBeDefined();
  return JSON.parse(line!.slice(line!.indexOf('{'))) as Record<string, unknown>;
};

describe('recordDeliveryOutcome', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.updateCalls = [];
    state.updateResults = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('writes the outcome and clears the execution lease', async () => {
    state.updateResults = [[{ id: 'delivery-1' }], []];

    expect(await recordDeliveryOutcome({ ...RESULT } as never)).toBe(true);

    expect(state.updateCalls[0]!.set).toMatchObject({
      status: 'delivered',
      attempts: 1,
      responseStatus: 200,
      nextRetryAt: null,
      failedAt: null
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when the write matches nothing — someone else resolved the row', async () => {
    state.updateResults = [[], []];

    expect(await recordDeliveryOutcome({ ...RESULT, success: false } as never)).toBe(false);

    const payload = structured(lines(warnSpy), 'WEBHOOK_DELIVERY_OUTCOME_WRITE_SKIPPED');
    expect(payload).toMatchObject({
      deliveryId: 'delivery-1',
      attemptedStatus: 'failed'
    });
  });

  it.each([true, false])('does not count an outcome again when the CAS misses (success %s)', async success => {
    state.updateResults = [[], []];
    expect(await recordDeliveryOutcome({ ...RESULT, success })).toBe(false);
    expect(state.updateCalls).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WEBHOOK_DELIVERY_OUTCOME_WRITE_SKIPPED'));
  });

  it('persists the next attempt as scheduled and still counts a failure', async () => {
    const nextAttemptAt = new Date('2026-09-11T12:01:00Z');
    state.updateResults = [[{ id: 'delivery-1' }], []];
    expect(await recordDeliveryOutcome({ ...RESULT, success: false, nextAttemptAt })).toBe(true);
    expect(state.updateCalls[0]!.set).toMatchObject({ status: 'scheduled', nextRetryAt: nextAttemptAt, failedAt: null });
    expect(state.updateCalls[1]!.set).toHaveProperty('failureCount');
  });

  it('persists terminal failures with no next attempt', async () => {
    state.updateResults = [[{ id: 'delivery-1' }], []];
    expect(await recordDeliveryOutcome({ ...RESULT, success: false, nextAttemptAt: null })).toBe(true);
    expect(state.updateCalls[0]!.set).toMatchObject({ status: 'failed', nextRetryAt: null, failedAt: expect.any(Date) });
  });

  it.each([0, 3])('releases only the matching claim for attempt %i', async attemptsMade => {
    state.updateResults = [[{ id: 'delivery-1' }]];
    expect(await releaseDeliveryClaim({ deliveryId: 'delivery-1', attemptsMade })).toBe(true);
    expect(state.updateCalls[0]!.set).toEqual({ status: attemptsMade === 0 ? 'pending' : 'scheduled', nextRetryAt: null });
    const compiled = new PgDialect().sqlToQuery(state.updateCalls[0]!.where as SQL);
    expect(compiled.params).toEqual(['delivery-1', 'retrying', attemptsMade]);
  });

  it('reports a lost claim release without changing another attempt', async () => {
    expect(await releaseDeliveryClaim({ deliveryId: 'delivery-1', attemptsMade: 3 })).toBe(false);
  });

  it('returns the claimed persisted delivery and stamps an execution lease', async () => {
    const delivery = { orgId: 'org-1', id: 'delivery-1', webhookId: 'webhook-1', attempts: 3, payloadVersion: 1 };
    state.updateResults = [[delivery]];
    expect(await claimDeliveryForExecution({ deliveryId: 'delivery-1', attemptsMade: 3 })).toEqual({ claimed: true, delivery });
    expect(state.updateCalls[0]!.set).toMatchObject({ status: 'retrying', nextRetryAt: expect.any(Date) });
  });

  it.each([
    [{ status: 'scheduled', attempts: 3, dueInMs: '90000' }, { observedStatus: 'scheduled', observedAttempts: 3, dueInMs: 90000 }],
    [{ status: 'pending', attempts: 0, dueInMs: null }, { observedStatus: 'pending', observedAttempts: 0, dueInMs: null }],
    [undefined, { observedStatus: null, observedAttempts: null, dueInMs: null }]
  ])('reads the lost claim once and coerces its DB-clock delay', async (row, observed) => {
    state.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => row ? [row] : [] }) }) });
    expect(await claimDeliveryForExecution({ deliveryId: 'delivery-1', attemptsMade: 3 })).toEqual({ claimed: false, ...observed });
    const delaySql = state.select.mock.calls.at(-1)![0].dueInMs as SQL;
    expect(new PgDialect().sqlToQuery(delaySql).sql).toBe(
      `CEIL(EXTRACT(EPOCH FROM ("webhook_deliveries"."next_retry_at" - (now() AT TIME ZONE 'UTC'))) * 1000)::float8`
    );
  });

});

describe('recordWebhookDelivery wire identity', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['invalid', 'x'.repeat(150), 123, { unexpected: true }, null])('warns once for an invalid present timestamp %j', async timestamp => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const values = vi.fn(() => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 'delivery-1' }] }) }));
    state.insert.mockReturnValue({ values });
    await recordWebhookDelivery({ id: 'hook-1', orgId: 'org-1', partnerId: null, approvalGeneration: 1, payloadVersion: 2 }, {
      id: 'event-1', orgId: 'org-1', type: 'alert.triggered', payload: {}, metadata: { timestamp }
    } as never);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ eventTimestamp: null }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(structured(lines(warn), 'WEBHOOK_DELIVERY_EVENT_TIMESTAMP_INVALID')).toEqual({
      errorId: 'WEBHOOK_DELIVERY_EVENT_TIMESTAMP_INVALID', eventId: 'event-1', webhookId: 'hook-1',
      timestamp: JSON.stringify(timestamp).slice(0, 100)
    });
  });

  it('does not warn when the timestamp is absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.insert.mockReturnValue({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 'delivery-1' }] }) }) });
    await recordWebhookDelivery({ id: 'hook-1', orgId: 'org-1', partnerId: null, approvalGeneration: 1, payloadVersion: 1 }, {
      id: 'event-1', orgId: 'org-1', type: 'device.offline', payload: {}, metadata: {}
    } as never);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['2026-10-28T12:00:00.000Z', 'invalid', undefined])('stores version, payload and event timestamp %s', async timestamp => {
    const values = vi.fn(() => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 'delivery-1' }] }) }));
    state.insert.mockReturnValue({ values });
    const payload = { alertId: 'alert-1', status: 'active' };
    await recordWebhookDelivery({ id: 'hook-1', orgId: 'org-1', partnerId: null, approvalGeneration: 1, payloadVersion: 2 }, { id: 'event-1', orgId: 'org-1', type: 'alert.triggered', payload, metadata: { timestamp } } as never);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', webhookGeneration: 1, payloadVersion: 2, payload, eventTimestamp: timestamp?.startsWith('2026') ? new Date(timestamp) : null, replayRootEventId: null }));
  });
});
