import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The EXECUTION CLAIM (#4095).
 *
 * The delivery queue is a plain Redis list with no job identity, so nothing
 * stops one delivery being enqueued twice — and the recovery sweep does exactly
 * that whenever a job turns out to have been merely backlogged rather than
 * lost. Without a claim, recovery would trade a missed POST for a DUPLICATE
 * POST to the customer's endpoint, which is the one externally-visible failure
 * this system treats as unrecoverable.
 */

const brpopMock = vi.hoisted(() => vi.fn());
const lpushMock = vi.hoisted(() => vi.fn(async (_key: string, _payload: string) => 1));
const lindexMock = vi.hoisted(() => vi.fn());
const lremMock = vi.hoisted(() => vi.fn(async () => 1));
const safeFetchMock = vi.hoisted(() => vi.fn());
const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock('../services/eventBus', () => ({
  getEventBus: () => ({ subscribe: vi.fn() }),
  EVENT_TYPES: {}
}));

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn()
}));

vi.mock('../services/redis', () => ({
  createBlockingRedisConnection: () => ({ brpop: brpopMock, status: 'ready' }),
  getRedisConnection: () => ({ lpush: lpushMock, lindex: lindexMock, lrem: lremMock })
}));

vi.mock('../services/urlSafety', () => ({
  safeFetch: safeFetchMock,
  SsrfBlockedError: class SsrfBlockedError extends Error {}
}));

vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

import { getWebhookWorker, type WebhookDeliveryJob } from './webhookDelivery';

const JOB: WebhookDeliveryJob = {
  id: 'delivery-1',
  webhookId: 'webhook-1',
  webhook: {
    id: 'webhook-1',
    orgId: 'org-1',
    name: 'Ops hook',
    url: 'https://example.test/hook',
    events: ['*']
  },
  event: {
    id: 'event-1',
    type: 'alert.triggered',
    orgId: 'org-1',
    source: 'test',
    priority: 'normal',
    payload: {},
    metadata: { timestamp: new Date('2026-09-11T12:00:00.000Z').toISOString() }
  } as WebhookDeliveryJob['event'],
  attempts: 0,
  createdAt: new Date('2026-09-11T12:00:00.000Z').toISOString()
};

/** Reach the private single-iteration pump without starting the infinite loop. */
function processOnce(): Promise<void> {
  const worker = getWebhookWorker() as unknown as { processNextJob: () => Promise<void> };
  return worker.processNextJob();
}

describe('webhook delivery execution claim', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    brpopMock.mockReset();
    captureExceptionMock.mockReset();
    lpushMock.mockClear();
    lindexMock.mockReset();
    safeFetchMock.mockReset();
    safeFetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => 'ok'
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not POST when the claim is lost to another copy of the job', async () => {
    brpopMock.mockResolvedValueOnce(['queue', JSON.stringify(JOB)]);
    const claim = vi.fn(async () => ({ claimed: false as const, observedStatus: 'retrying' }));
    const complete = vi.fn(async () => {});
    getWebhookWorker().setDeliveryClaimCallback(claim);
    getWebhookWorker().setDeliveryCallback(complete);

    await processOnce();

    expect(claim).toHaveBeenCalledTimes(1);
    // The whole point: the customer's endpoint is NOT hit a second time.
    expect(safeFetchMock).not.toHaveBeenCalled();
    // And the losing copy must not overwrite the winner's outcome either.
    expect(complete).not.toHaveBeenCalled();

    const line = warnSpy.mock.calls
      .map((c: unknown[]) => c.map(String).join(' '))
      .find((l: string) => l.includes('WEBHOOK_DELIVERY_DUPLICATE_JOB_SKIPPED'));
    expect(line, 'the dropped duplicate must be reported, not silent').toBeDefined();
    expect(JSON.parse(line!.slice(line!.indexOf('{')))).toMatchObject({
      deliveryId: 'delivery-1',
      webhookId: 'webhook-1',
      eventId: 'event-1'
    });
  });

  it('POSTs when the claim is won', async () => {
    brpopMock.mockResolvedValueOnce(['queue', JSON.stringify(JOB)]);
    const claim = vi.fn(async () => ({ claimed: true as const }));
    getWebhookWorker().setDeliveryClaimCallback(claim);
    getWebhookWorker().setDeliveryCallback(async () => {});

    await processOnce();

    expect(claim).toHaveBeenCalledTimes(1);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('pages when the customer was POSTed but the outcome could not be recorded', async () => {
    // The two sides of the POST are not equally recoverable. A failure BEFORE
    // it leaves the row untouched for the sweep to reclaim; a failure HERE
    // means the customer's endpoint was already called and that fact is now
    // unrecorded — the sweep will later resolve the row as "outcome unknown"
    // and can never repair it. Scrolling past that in a log is not enough.
    brpopMock.mockResolvedValueOnce(['queue', JSON.stringify(JOB)]);
    getWebhookWorker().setDeliveryClaimCallback(async () => ({ claimed: true as const }));
    getWebhookWorker().setDeliveryCallback(async () => {
      throw new Error('db write failed');
    });

    await processOnce();

    expect(safeFetchMock).toHaveBeenCalledTimes(1); // the POST really happened
    expect(captureExceptionMock).toHaveBeenCalled();

    const line = errorSpy.mock.calls
      .map((c: unknown[]) => c.map(String).join(' '))
      .find((l: string) => l.includes('WEBHOOK_DELIVERY_OUTCOME_UNRECORDED'));
    expect(line, 'an unrecorded customer POST must be reported').toBeDefined();
    expect(JSON.parse(line!.slice(line!.indexOf('{')))).toMatchObject({
      deliveryId: 'delivery-1',
      delivered: true,
      responseStatus: 200
    });

  });

  it('does not run the retry ladder when a FAILED outcome could not be recorded', async () => {
    // The failing half of the same rule. Here the ladder really would fire —
    // the POST failed and retries remain — so re-queueing on top of an outcome
    // we could not record would drive a second attempt whose result we also
    // cannot reconcile. The row stays `retrying` for the sweep to resolve.
    brpopMock.mockResolvedValueOnce(['queue', JSON.stringify(JOB)]);
    safeFetchMock.mockResolvedValueOnce({
      status: 500,
      ok: false,
      text: async () => 'server error'
    });
    getWebhookWorker().setDeliveryClaimCallback(async () => ({ claimed: true as const }));
    getWebhookWorker().setDeliveryCallback(async () => {
      throw new Error('db write failed');
    });

    await processOnce();

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(lpushMock).not.toHaveBeenCalled();

    const line = errorSpy.mock.calls
      .map((c: unknown[]) => c.map(String).join(' '))
      .find((l: string) => l.includes('WEBHOOK_DELIVERY_OUTCOME_UNRECORDED'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(line!.indexOf('{')))).toMatchObject({ delivered: false });
  });

  it('PRODUCES a DLQ replay job that is marked to bypass the claim', async () => {
    // Producer-side pin. The consumer test below asserts the bypass is HONORED,
    // but with nothing asserting it is SET, deleting `skipExecutionClaim: true`
    // from retryFromDLQ was green repo-wide — and that deletion silently eats
    // every operator-triggered replay.
    const entry = JSON.stringify({ job: { ...JOB, id: 'dlq-original' } });
    lindexMock.mockResolvedValueOnce(entry);

    await getWebhookWorker().retryFromDLQ(0);

    expect(lpushMock).toHaveBeenCalledTimes(1);
    const queued = JSON.parse(lpushMock.mock.calls[0]![1]);
    expect(queued.skipExecutionClaim).toBe(true);
    // A fresh id is exactly WHY the bypass is needed: no row exists under it.
    expect(queued.id).not.toBe('dlq-original');
  });

  it('STAMPS the outcome with whether a delivery row exists', async () => {
    // Producer side of the DLQ fix. The outcome writer branches on
    // `hasDeliveryRow`, but with nothing asserting the worker SETS it,
    // hard-coding it to `true` was green — which puts the zero-row warning back
    // on every routine replay with a cause that is untrue.
    const seen: Array<boolean | undefined> = [];
    getWebhookWorker().setDeliveryClaimCallback(async () => ({ claimed: true as const }));
    getWebhookWorker().setDeliveryCallback(async (r) => { seen.push(r.hasDeliveryRow); });

    brpopMock.mockResolvedValueOnce(['queue', JSON.stringify(JOB)]);
    await processOnce();

    brpopMock.mockResolvedValueOnce([
      'queue',
      JSON.stringify({ ...JOB, id: 'dlq-minted', skipExecutionClaim: true })
    ]);
    await processOnce();

    expect(seen).toEqual([true, false]);
  });

  it('names the real cause when a job loses its claim', async () => {
    // "duplicate" is only one of three ways to lose. Collapsing them mislabels
    // the other two — the same mislabeling the DLQ fix removed elsewhere.
    const cases: Array<[string | null, string]> = [
      ['retrying', 'already-claimed'],
      ['delivered', 'already-resolved'],
      [null, 'no-delivery-row']
    ];

    for (const [observedStatus, expectedCause] of cases) {
      warnSpy.mockClear();
      brpopMock.mockResolvedValueOnce(['queue', JSON.stringify(JOB)]);
      getWebhookWorker().setDeliveryClaimCallback(async () => ({
        claimed: false as const,
        observedStatus
      }));
      getWebhookWorker().setDeliveryCallback(async () => {});

      await processOnce();

      const line = warnSpy.mock.calls
        .map((c: unknown[]) => c.map(String).join(' '))
        .find((l: string) => l.includes('WEBHOOK_DELIVERY_DUPLICATE_JOB_SKIPPED'));
      expect(line, `no log for observedStatus=${observedStatus}`).toBeDefined();
      expect(JSON.parse(line!.slice(line!.indexOf('{'))))
        .toMatchObject({ observedStatus, cause: expectedCause });
    }
  });

  it('does not claim a DLQ replay, which has no delivery row to claim', async () => {
    // retryFromDLQ mints a FRESH delivery id with no `webhook_deliveries` row
    // behind it, so a pending-only CAS can never match. Without the bypass the
    // operator's replay is dropped and reported as a "duplicate" — eating the
    // retry and naming the wrong cause.
    brpopMock.mockResolvedValueOnce([
      'queue',
      JSON.stringify({ ...JOB, id: 'brand-new-id', skipExecutionClaim: true })
    ]);
    const claim = vi.fn(async () => ({ claimed: false as const, observedStatus: 'retrying' }));
    getWebhookWorker().setDeliveryClaimCallback(claim);
    getWebhookWorker().setDeliveryCallback(async () => {});

    await processOnce();

    expect(claim).not.toHaveBeenCalled();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-claim a retry job, whose row has already left `pending`', async () => {
    // A retry carries attempts > 0 and its row was moved to `failed` by the
    // previous attempt's callback. Re-running the pending-only CAS would reject
    // every legitimate retry and silently kill the whole backoff ladder.
    brpopMock.mockResolvedValueOnce(['queue', JSON.stringify({ ...JOB, attempts: 2 })]);
    const claim = vi.fn(async () => ({ claimed: false as const, observedStatus: 'retrying' }));
    getWebhookWorker().setDeliveryClaimCallback(claim);
    getWebhookWorker().setDeliveryCallback(async () => {});

    await processOnce();

    expect(claim).not.toHaveBeenCalled();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});
