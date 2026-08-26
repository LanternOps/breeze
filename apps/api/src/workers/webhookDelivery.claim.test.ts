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
const lpushMock = vi.hoisted(() => vi.fn(async () => 1));
const safeFetchMock = vi.hoisted(() => vi.fn());

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
  getRedisConnection: () => ({ lpush: lpushMock })
}));

vi.mock('../services/urlSafety', () => ({
  safeFetch: safeFetchMock,
  SsrfBlockedError: class SsrfBlockedError extends Error {}
}));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

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

  beforeEach(() => {
    brpopMock.mockReset();
    safeFetchMock.mockReset();
    safeFetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => 'ok'
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not POST when the claim is lost to another copy of the job', async () => {
    brpopMock.mockResolvedValueOnce(['queue', JSON.stringify(JOB)]);
    const claim = vi.fn(async () => false);
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
    const claim = vi.fn(async () => true);
    getWebhookWorker().setDeliveryClaimCallback(claim);
    getWebhookWorker().setDeliveryCallback(async () => {});

    await processOnce();

    expect(claim).toHaveBeenCalledTimes(1);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-claim a retry job, whose row has already left `pending`', async () => {
    // A retry carries attempts > 0 and its row was moved to `failed` by the
    // previous attempt's callback. Re-running the pending-only CAS would reject
    // every legitimate retry and silently kill the whole backoff ladder.
    brpopMock.mockResolvedValueOnce(['queue', JSON.stringify({ ...JOB, attempts: 2 })]);
    const claim = vi.fn(async () => false);
    getWebhookWorker().setDeliveryClaimCallback(claim);
    getWebhookWorker().setDeliveryCallback(async () => {});

    await processOnce();

    expect(claim).not.toHaveBeenCalled();
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});
