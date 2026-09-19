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
    db: { update: makeUpdate },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn()
  };
});

import { recordDeliveryOutcome } from './webhookDeliveryRecord';

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

    await recordDeliveryOutcome({ ...RESULT } as never);

    expect(state.updateCalls[0]!.set).toMatchObject({
      status: 'delivered',
      attempts: 1,
      responseStatus: 200,
      nextRetryAt: null
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when the write matches nothing — someone else resolved the row', async () => {
    state.updateResults = [[], []];

    await recordDeliveryOutcome({ ...RESULT, success: false } as never);

    const payload = structured(lines(warnSpy), 'WEBHOOK_DELIVERY_OUTCOME_WRITE_SKIPPED');
    expect(payload).toMatchObject({
      deliveryId: 'delivery-1',
      attemptedStatus: 'failed'
    });
  });

  it('skips the row write for a DLQ replay, which has no row, and says so', async () => {
    // Without this branch the zero-row warning fires on EVERY routine replay
    // with a stated cause that is untrue — voiding the warning for the real
    // race it exists to catch.
    state.updateResults = [[]];

    await recordDeliveryOutcome({ ...RESULT, hasDeliveryRow: false } as never);

    // Only the aggregate write ran; no attempt was made against a row that
    // does not exist.
    expect(state.updateCalls).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();

    const payload = structured(lines(logSpy), 'WEBHOOK_DLQ_REPLAY_COMPLETED');
    expect(payload).toMatchObject({
      deliveryId: 'delivery-1',
      delivered: true,
      responseStatus: 200
    });
  });

  it('still moves the webhook aggregates for a DLQ replay — the POST happened', async () => {
    state.updateResults = [[]];

    await recordDeliveryOutcome({ ...RESULT, hasDeliveryRow: false } as never);

    expect(state.updateCalls).toHaveLength(1);
    expect(Object.keys(state.updateCalls[0]!.set)).toContain('successCount');
  });
});
