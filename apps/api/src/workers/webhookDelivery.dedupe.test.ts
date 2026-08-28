import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queueDeliveryMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn(async () => {}));
const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  db: {},
  // webhookDelivery.ts:12 builds its own runWithSystemDbAccess around this
  // export; keep it a pass-through so the handler body actually runs.
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn()
}));

vi.mock('../services/redis', () => ({
  createBlockingRedisConnection: () => ({}),
  getRedisConnection: () => ({})
}));

vi.mock('../services/sentry', () => ({
  captureException: captureExceptionMock
}));

import { configureWebhookFanout, handleWebhookFanoutEvent, getWebhookWorker } from './webhookDelivery';

const EVENT = {
  id: 'event-1',
  type: 'alert.triggered',
  orgId: 'org-1',
  source: 'test',
  priority: 'normal' as const,
  payload: {},
  metadata: { correlationId: 'c1', timestamp: new Date().toISOString() }
};

const WEBHOOK = { id: 'webhook-1', orgId: 'org-1', url: 'https://example.test/hook' };
const WEBHOOK_B = { id: 'webhook-2', orgId: 'org-1', url: 'https://example.test/hook-b' };

const recorded = (deliveryId: string) => ({ created: true as const, deliveryId });
const deduped = (existing: {
  id: string;
  status: string;
  attempts: number;
  createdAt: Date;
} | null) => ({ created: false as const, existing });

/** Every console line this module emitted, flattened to searchable strings. */
function consoleLines(...spies: Array<{ mock: { calls: unknown[][] } }>): string[] {
  return spies.flatMap((spy) =>
    spy.mock.calls.map((call) => call.map((arg) => String(arg)).join(' '))
  );
}

/** The JSON blob out of the one structured line carrying `errorId`. */
function structured(lines: string[], errorId: string): Record<string, unknown> {
  const line = lines.find((l) => l.includes(errorId));
  expect(line, `no console line carried ${errorId}`).toBeDefined();
  const json = line!.slice(line!.indexOf('{'));
  return JSON.parse(json) as Record<string, unknown>;
}

describe('webhook delivery is one-per-(webhook, event)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queueDeliveryMock.mockReset();
    captureExceptionMock.mockReset();
    vi.spyOn(getWebhookWorker(), 'queueDelivery').mockImplementation(queueDeliveryMock);
    vi.spyOn(getWebhookWorker(), 'start').mockImplementation(startMock);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not queue a second delivery when the (webhook, event) pair is already recorded', async () => {
    const createDeliveryRecord = vi.fn()
      .mockResolvedValueOnce(recorded('delivery-1'))   // first: this call won the insert
      .mockResolvedValueOnce(deduped({                 // redelivery: unique index rejected it
        id: 'delivery-1',
        status: 'delivered',
        attempts: 1,
        createdAt: new Date('2026-09-11T00:00:00.000Z')
      }));

    configureWebhookFanout({ getWebhooksForEvent: async () => [WEBHOOK] as never, createDeliveryRecord: createDeliveryRecord as never });

    await handleWebhookFanoutEvent(EVENT as never);
    await handleWebhookFanoutEvent(EVENT as never);

    // Two attempts, one outbound POST: the customer's endpoint must not be
    // hit twice for one event.
    expect(createDeliveryRecord).toHaveBeenCalledTimes(2);
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
  });

  it('still queues blind when no delivery-record creator is configured', async () => {
    configureWebhookFanout({ getWebhooksForEvent: async () => [WEBHOOK] as never });

    await handleWebhookFanoutEvent(EVENT as never);

    // No creator means no dedupe surface exists; skipping here would drop the
    // delivery entirely rather than de-duplicate it.
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // #4095: the skip must be OBSERVABLE. Before this, `continue` emitted nothing,
  // so in production you could not tell "dedupe working as designed" from
  // "dedupe eating deliveries" — and once #4085 makes delivery at-least-once
  // that skip is what suppresses a (webhook, event) pair forever.
  // ---------------------------------------------------------------------------

  it('reports the skipped duplicate, naming the delivery that already owns the event', async () => {
    const createDeliveryRecord = vi.fn().mockResolvedValue(deduped({
      id: 'delivery-1',
      status: 'delivered',
      attempts: 1,
      createdAt: new Date('2026-09-11T00:00:00.000Z')
    }));

    configureWebhookFanout({ getWebhooksForEvent: async () => [WEBHOOK] as never, createDeliveryRecord: createDeliveryRecord as never });

    await handleWebhookFanoutEvent(EVENT as never);

    expect(queueDeliveryMock).not.toHaveBeenCalled();

    const payload = structured(
      consoleLines(logSpy, warnSpy, errorSpy),
      'WEBHOOK_DELIVERY_DUPLICATE_SKIPPED'
    );
    expect(payload).toMatchObject({
      errorId: 'WEBHOOK_DELIVERY_DUPLICATE_SKIPPED',
      webhookId: 'webhook-1',
      orgId: 'org-1',
      eventId: 'event-1',
      eventType: 'alert.triggered',
      existingDeliveryId: 'delivery-1',
      existingStatus: 'delivered'
    });
    // The OTHER half of the severity split. Without this, emptying
    // BENIGN_DUPLICATE_STATUSES entirely — routing every routine dedupe to warn
    // and drowning the real signal — stayed green.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a `failed` original is a benign dedupe too, not a warn', async () => {
    // `failed` is terminal: the original owns the event's outcome and the retry
    // ladder (or a hand retry) drives it. Only the UNRESOLVED statuses warn.
    const createDeliveryRecord = vi.fn().mockResolvedValue(deduped({
      id: 'delivery-1',
      status: 'failed',
      attempts: 3,
      createdAt: new Date('2026-09-11T00:00:00.000Z')
    }));

    configureWebhookFanout({ getWebhooksForEvent: async () => [WEBHOOK] as never, createDeliveryRecord: createDeliveryRecord as never });

    await handleWebhookFanoutEvent(EVENT as never);

    const payload = structured(consoleLines(logSpy), 'WEBHOOK_DELIVERY_DUPLICATE_SKIPPED');
    expect(payload).toMatchObject({ existingStatus: 'failed' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('escalates to warn when the row it deferred to is still pending — that is an orphan, not a dedupe', async () => {
    const createDeliveryRecord = vi.fn().mockResolvedValue(deduped({
      id: 'delivery-1',
      status: 'pending',
      attempts: 0,
      createdAt: new Date('2026-09-11T00:00:00.000Z')
    }));

    configureWebhookFanout({ getWebhooksForEvent: async () => [WEBHOOK] as never, createDeliveryRecord: createDeliveryRecord as never });

    await handleWebhookFanoutEvent(EVENT as never);

    // A `delivered` original is a benign dedupe; a `pending` one means the
    // original may never have been enqueued at all, and the recovery sweep —
    // not this subscriber — has to drive it. Severity is the signal that
    // separates the two, so it must not collapse to console.log.
    const warnPayload = structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_DUPLICATE_SKIPPED');
    expect(warnPayload).toMatchObject({ existingStatus: 'pending' });
  });

  it('treats a `retrying` original as unresolved too, not as a benign dedupe', async () => {
    // `retrying` is one of the two statuses the recovery sweep treats as
    // UNRESOLVED, so a duplicate deferring to one is deferring to a delivery
    // that may itself be stuck. Logging it at info would bury it next to
    // genuinely delivered rows.
    const createDeliveryRecord = vi.fn().mockResolvedValue(deduped({
      id: 'delivery-1',
      status: 'retrying',
      attempts: 1,
      createdAt: new Date('2026-09-11T00:00:00.000Z')
    }));

    configureWebhookFanout({ getWebhooksForEvent: async () => [WEBHOOK] as never, createDeliveryRecord: createDeliveryRecord as never });

    await handleWebhookFanoutEvent(EVENT as never);

    const payload = structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_DUPLICATE_SKIPPED');
    expect(payload).toMatchObject({ existingStatus: 'retrying' });
  });

  it('reports the skip even when the conflicting row cannot be read back', async () => {
    // The insert lost the race but the row is gone by the time we look it up
    // (erasure, or a future retention job). Emitting nothing here would restore
    // exactly the silent drop #4095 is about.
    const createDeliveryRecord = vi.fn().mockResolvedValue(deduped(null));

    configureWebhookFanout({ getWebhooksForEvent: async () => [WEBHOOK] as never, createDeliveryRecord: createDeliveryRecord as never });

    await handleWebhookFanoutEvent(EVENT as never);

    expect(queueDeliveryMock).not.toHaveBeenCalled();
    const payload = structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_DUPLICATE_SKIPPED');
    expect(payload).toMatchObject({ existingDeliveryId: null, existingStatus: null });
  });

  // ---------------------------------------------------------------------------
  // #4085/#4095: the whole-event lookup failure now RETHROWS (queue-mode
  // dispatch retries on it) instead of the old silent `return`.
  // ---------------------------------------------------------------------------

  it('rethrows when the webhook lookup fails, reporting the whole-event fan-out loss', async () => {
    configureWebhookFanout({ getWebhooksForEvent: async () => { throw new Error('db exploded'); } });

    await expect(handleWebhookFanoutEvent(EVENT as never)).rejects.toThrow('db exploded');

    expect(queueDeliveryMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);

    const payload = structured(consoleLines(errorSpy), 'WEBHOOK_EVENT_ROUTING_FAILED');
    expect(payload).toMatchObject({
      eventId: 'event-1',
      orgId: 'org-1',
      eventType: 'alert.triggered',
      transient: false
    });
    expect(String(payload.impact)).toContain('lost');
  });

  it('does not claim a transient DB error will be retried locally — it also rethrows', async () => {
    configureWebhookFanout({
      getWebhooksForEvent: async () => { throw new Error('CONNECTION_DESTROYED while querying'); }
    });

    await expect(handleWebhookFanoutEvent(EVENT as never)).rejects.toThrow('CONNECTION_DESTROYED');

    const payload = structured(consoleLines(errorSpy), 'WEBHOOK_EVENT_ROUTING_FAILED');
    expect(payload).toMatchObject({ transient: true });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // #4095: the try/catch used to sit OUTSIDE the `for (const webhook of webhooks)`
  // loop, so one webhook's failure aborted delivery for webhooks N+1… of the
  // same event. Combined with the dedupe, a retry then skips the webhooks that
  // already had a row while the rest proceed — permanently dropping the
  // failing one. #4085: failures now collect and throw an AGGREGATE after the
  // loop instead of being swallowed.
  // ---------------------------------------------------------------------------

  it('keeps delivering to the remaining webhooks after one webhook fails to record, then throws an aggregate', async () => {
    const createDeliveryRecord = vi.fn()
      .mockRejectedValueOnce(new Error('insert blew up'))
      .mockResolvedValueOnce(recorded('delivery-2'));

    configureWebhookFanout({
      getWebhooksForEvent: async () => [WEBHOOK, WEBHOOK_B] as never,
      createDeliveryRecord: createDeliveryRecord as never
    });

    await expect(handleWebhookFanoutEvent(EVENT as never)).rejects.toThrow(
      /webhook fan-out failed for 1\/2 webhooks: webhook-1/
    );

    expect(createDeliveryRecord).toHaveBeenCalledTimes(2);
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
    expect((queueDeliveryMock.mock.calls[0]![0] as { id: string }).id).toBe('webhook-2');

    const payload = structured(consoleLines(errorSpy), 'WEBHOOK_DELIVERY_ROUTING_FAILED');
    expect(payload).toMatchObject({ webhookId: 'webhook-1', eventId: 'event-1' });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering to the remaining webhooks when one enqueue fails, then throws an aggregate', async () => {
    const createDeliveryRecord = vi.fn()
      .mockResolvedValueOnce(recorded('delivery-1'))
      .mockResolvedValueOnce(recorded('delivery-2'));
    queueDeliveryMock
      .mockRejectedValueOnce(new Error('LPUSH failed'))
      .mockResolvedValueOnce('delivery-2');

    configureWebhookFanout({
      getWebhooksForEvent: async () => [WEBHOOK, WEBHOOK_B] as never,
      createDeliveryRecord: createDeliveryRecord as never
    });

    await expect(handleWebhookFanoutEvent(EVENT as never)).rejects.toThrow(
      /webhook fan-out failed for 1\/2 webhooks: webhook-1/
    );

    // webhook-1 is now a recorded-but-never-enqueued orphan — that is the
    // recovery sweep's job. What must NOT happen is webhook-2 losing its
    // delivery because webhook-1's LPUSH died first.
    expect(queueDeliveryMock).toHaveBeenCalledTimes(2);
    expect((queueDeliveryMock.mock.calls[1]![0] as { id: string }).id).toBe('webhook-2');
  });

  it('does not throw when every webhook in the fan-out succeeds', async () => {
    const createDeliveryRecord = vi.fn()
      .mockResolvedValueOnce(recorded('delivery-1'))
      .mockResolvedValueOnce(recorded('delivery-2'));

    configureWebhookFanout({
      getWebhooksForEvent: async () => [WEBHOOK, WEBHOOK_B] as never,
      createDeliveryRecord: createDeliveryRecord as never
    });

    await expect(handleWebhookFanoutEvent(EVENT as never)).resolves.toBeUndefined();
    expect(queueDeliveryMock).toHaveBeenCalledTimes(2);
  });
});
