import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behaviour of the stale-pending sweep (#4095).
 *
 * The PREDICATES are asserted as compiled SQL in the sibling
 * `webhookDeliveryRecovery.sql.test.ts` — the db is mocked here, so a `where`
 * assertion in this file would only see an opaque object and could not tell an
 * `and` from an `or`. This file asserts what the sweep DOES: which rows get
 * re-queued, which get a terminal status, and that neither ever happens
 * silently.
 */

interface UpdateCall {
  set: Record<string, unknown>;
  where: unknown;
}

const state = vi.hoisted(() => ({
  candidates: [] as Record<string, unknown>[],
  updateCalls: [] as UpdateCall[],
  /** Queued FIFO of `.returning()` results, one per update. An Error rejects. */
  updateResults: [] as Array<Record<string, unknown>[] | Error>,
  queueDelivery: null as ReturnType<typeof vi.fn> | null
}));

const captureExceptionMock = vi.hoisted(() => vi.fn());
const queueDeliveryMock = vi.hoisted(() => vi.fn());

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => state.candidates
            })
          })
        })
      })
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (predicate: unknown) => ({
          returning: async () => {
            state.updateCalls.push({ set: values, where: predicate });
            // A queued `Error` REJECTS instead of resolving — the only way to
            // reach the per-candidate catch, since every other failure path is
            // already caught by an inner block.
            const next = state.updateResults.shift();
            if (next instanceof Error) throw next;
            return next ?? [];
          }
        })
      })
    })
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn()
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: () => ({}),
  getRedisConnection: () => ({}),
  createBlockingRedisConnection: () => ({})
}));

vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

vi.mock('../services/webhookConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/webhookConfig')>();
  return { ...actual, toWebhookConfig: vi.fn(actual.toWebhookConfig) };
});

vi.mock('../workers/webhookDelivery', () => ({
  getWebhookWorker: () => ({ queueDelivery: queueDeliveryMock })
}));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import {
  MAX_RECOVERABLE_AGE_MS,
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_COOLDOWN_MS,
  STALE_PENDING_MS,
  buildLeaseHeldCas,
  buildRecoveryClaimCas,
  runWebhookDeliveryRecoverySweep
} from './webhookDeliveryRecovery';
import { toWebhookConfig } from '../services/webhookConfig';

const NOW = new Date('2026-09-11T12:00:00.000Z');

function orphan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    webhookId: 'webhook-1',
    eventId: 'event-1',
    eventType: 'alert.triggered',
    payload: { alertId: 'a-1' },
    status: 'pending',
    recoveryAttempts: 0,
    createdAt: new Date(NOW.getTime() - STALE_PENDING_MS - 60_000),
    webhookOrgId: 'org-1',
    webhookName: 'Ops hook',
    webhookStatus: 'active',
    webhookUrl: 'https://example.test/hook',
    webhookSecret: null,
    webhookEvents: ['*'],
    webhookHeaders: null,
    webhookRetryPolicy: null,
    ...overrides
  };
}

/** A CAS that returns a row = this instance won the claim. */
function claimWon(recoveryAttempts: number) {
  return [{ id: 'delivery-1', recoveryAttempts }];
}

function consoleLines(...spies: Array<{ mock: { calls: unknown[][] } }>): string[] {
  return spies.flatMap((spy) =>
    spy.mock.calls.map((call) => call.map((arg) => String(arg)).join(' '))
  );
}

function structured(lines: string[], errorId: string): Record<string, unknown> {
  const line = lines.find((l) => l.includes(errorId));
  expect(line, `no console line carried ${errorId}`).toBeDefined();
  return JSON.parse(line!.slice(line!.indexOf('{'))) as Record<string, unknown>;
}

describe('webhook delivery recovery sweep', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.candidates = [];
    state.updateCalls = [];
    state.updateResults = [];
    queueDeliveryMock.mockReset();
    queueDeliveryMock.mockResolvedValue('delivery-1');
    captureExceptionMock.mockReset();
    vi.mocked(toWebhookConfig).mockClear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-queues an orphan under its ORIGINAL delivery id and event id', async () => {
    state.candidates = [orphan()];
    state.updateResults = [claimWon(1)];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary).toMatchObject({ scanned: 1, requeued: 1, exhausted: 0, raced: 0 });
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);

    const [config, event, deliveryId] = queueDeliveryMock.mock.calls[0]!;
    // The SAME row is driven, not a new one: the delivery callback updates by
    // this id, and `event.id` goes out as the customer's X-Breeze-Event-Id
    // idempotency key.
    expect(deliveryId).toBe('delivery-1');
    expect((event as { id: string }).id).toBe('event-1');
    expect((event as { type: string }).type).toBe('alert.triggered');
    expect((event as { orgId: string }).orgId).toBe('org-1');
    expect((event as { payload: unknown }).payload).toEqual({ alertId: 'a-1' });
    expect((config as { id: string }).id).toBe('webhook-1');
    expect((config as { url: string }).url).toBe('https://example.test/hook');
  });

  it('leases the row it claimed so a concurrent sweep cannot re-queue it', async () => {
    state.candidates = [orphan()];
    state.updateResults = [claimWon(1)];

    await runWebhookDeliveryRecoverySweep(NOW);

    expect(state.updateCalls).toHaveLength(1);
    // The DEDICATED counter, not `attempts`: the delivery callback overwrites
    // `attempts` with the HTTP attempt count, which would both lose the recovery
    // count and misreport enqueue recoveries as delivery attempts in the UI.
    expect(state.updateCalls[0]!.set).toMatchObject({ recoveryAttempts: 1 });
    expect(state.updateCalls[0]!.set).not.toHaveProperty('attempts');
    expect((state.updateCalls[0]!.set.nextRetryAt as Date).getTime())
      .toBe(NOW.getTime() + RECOVERY_COOLDOWN_MS);
  });

  it('does not enqueue when the CAS is lost to another instance', async () => {
    state.candidates = [orphan()];
    state.updateResults = [[]]; // UPDATE ... RETURNING matched nothing

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    // The whole point of the CAS: N API pods sweep, exactly one POSTs.
    expect(queueDeliveryMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 1, requeued: 0, raced: 1 });

    // Losing the race is an ORDINARY outcome, so it must be a clean skip — not
    // an exception that merely happens to stop short of the enqueue. Without
    // these two, deleting the `continue` after the failed claim still passes:
    // the code then dereferences the undefined claim, throws, and the catch
    // suppresses the enqueue by accident.
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(consoleLines(errorSpy)).toHaveLength(0);
  });

  it('announces every recovery rather than re-delivering silently', async () => {
    state.candidates = [orphan()];
    state.updateResults = [claimWon(1)];

    await runWebhookDeliveryRecoverySweep(NOW);

    const payload = structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_RECOVERED');
    expect(payload).toMatchObject({
      deliveryId: 'delivery-1',
      webhookId: 'webhook-1',
      orgId: 'org-1',
      eventId: 'event-1',
      recoveryAttempt: 1
    });
    expect(payload.unresolvedForMs).toBe(STALE_PENDING_MS + 60_000);
  });

  it('gives up on a row that has burned through its recovery attempts, terminally and loudly', async () => {
    state.candidates = [orphan({ recoveryAttempts: MAX_RECOVERY_ATTEMPTS })];
    state.updateResults = [
      claimWon(MAX_RECOVERY_ATTEMPTS + 1), // the claim
      [{ id: 'delivery-1' }]               // the terminal write
    ];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(queueDeliveryMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ exhausted: 1, requeued: 0 });

    // `failed` specifically: it is the only status the existing per-delivery
    // retry endpoint accepts, so the row stays hand-drivable instead of sitting
    // pending forever.
    const terminal = state.updateCalls[1]!;
    expect(terminal.set).toMatchObject({ status: 'failed', nextRetryAt: null });
    // Wording matters: a `pending` row proves only that no worker ever CLAIMED
    // it, so the message says that rather than asserting more than we know.
    expect(String(terminal.set.errorMessage)).toContain('Never claimed by a delivery worker');

    structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_RECOVERY_EXHAUSTED');
  });

  it('does not POST to a webhook the customer has disabled, but still resolves the row', async () => {
    state.candidates = [orphan({ webhookStatus: 'disabled' })];
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }]];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(queueDeliveryMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ undeliverable: 1 });
    expect(state.updateCalls[1]!.set).toMatchObject({ status: 'failed' });
    const payload = structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_RECOVERY_WEBHOOK_INACTIVE');
    expect(payload).toMatchObject({ webhookStatus: 'disabled' });
  });

  it('leaves the row recoverable when the re-enqueue itself fails', async () => {
    state.candidates = [orphan()];
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }]];
    queueDeliveryMock.mockRejectedValueOnce(new Error('LPUSH failed again'));

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary).toMatchObject({ enqueueFailed: 1, requeued: 0, exhausted: 0 });
    // The row is NOT marked failed, so the lease expires and the next window
    // reconsiders it.
    expect(state.updateCalls.some((c) => c.set.status === 'failed')).toBe(false);
    structured(consoleLines(errorSpy), 'WEBHOOK_DELIVERY_RECOVERY_REQUEUE_FAILED');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('REFUNDS the attempt when the enqueue never used it', async () => {
    // The claim charges an attempt before the enqueue. If the enqueue then
    // fails, that attempt bought nothing — and without a refund a Redis outage
    // spends the whole budget on itself: six consecutive failures (~75 min of
    // downtime) would terminally fail a delivery that was never attempted,
    // charging infrastructure downtime against the customer's delivery.
    state.candidates = [orphan({ recoveryAttempts: 2 })];
    state.updateResults = [claimWon(3), [{ id: 'delivery-1' }]];
    queueDeliveryMock.mockRejectedValueOnce(new Error('Redis down'));

    await runWebhookDeliveryRecoverySweep(NOW);

    const refund = state.updateCalls[1]!;
    expect(refund.set).toMatchObject({ recoveryAttempts: 2 });
    // The lease is deliberately NOT cleared — the next window should still wait
    // out the cooldown rather than hot-loop against a dead Redis.
    expect(refund.set).not.toHaveProperty('nextRetryAt');
    expect(refund.where)
      .toEqual(buildLeaseHeldCas('delivery-1', new Date(NOW.getTime() + RECOVERY_COOLDOWN_MS)));
  });

  it('refuses to send a delivery that is too old, terminally and loudly', async () => {
    // First-deploy insurance: POSTing a months-old payload to a customer's
    // endpoint is its own incident. It must be RESOLVED rather than filtered
    // out of the scan, or it would sit unresolved forever — the bug this file
    // exists to fix.
    state.candidates = [orphan({
      createdAt: new Date(NOW.getTime() - MAX_RECOVERABLE_AGE_MS - 60_000)
    })];
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }]];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(queueDeliveryMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ tooOld: 1, requeued: 0 });
    expect(state.updateCalls[1]!.set).toMatchObject({ status: 'failed' });
    expect(String(state.updateCalls[1]!.set.errorMessage)).toContain('too old');
    structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_RECOVERY_TOO_OLD');
  });

  it('still delivers a row just inside the age ceiling', async () => {
    // Boundary the other way: an off-by-one here silently stops recovering.
    state.candidates = [orphan({
      createdAt: new Date(NOW.getTime() - MAX_RECOVERABLE_AGE_MS + 60_000)
    })];
    state.updateResults = [claimWon(1)];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary).toMatchObject({ requeued: 1, tooOld: 0 });
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
  });

  it('one poisonous row does not abort the rest of the batch', async () => {
    state.candidates = [
      orphan({ id: 'delivery-1' }),
      orphan({ id: 'delivery-2', webhookId: 'webhook-2', eventId: 'event-2' })
    ];
    // claim(1) -> enqueue throws -> attempt REFUND -> claim(2).
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }], claimWon(1)];
    queueDeliveryMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('delivery-2');

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary.scanned).toBe(2);
    expect(summary.requeued).toBe(1);
    expect(queueDeliveryMock).toHaveBeenCalledTimes(2);
    expect(queueDeliveryMock.mock.calls[1]![2]).toBe('delivery-2');
  });

  it('marks a row terminal when the webhook credentials will not decrypt', async () => {
    state.candidates = [orphan()];
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }]];
    vi.mocked(toWebhookConfig).mockImplementationOnce(() => {
      throw new Error('decrypt failed: AAD mismatch');
    });

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    // Delivering with unusable credentials is worse than not delivering — but
    // the row must not stay pending forever either.
    expect(queueDeliveryMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ undeliverable: 1 });
    expect(state.updateCalls[1]!.set).toMatchObject({ status: 'failed' });
    structured(consoleLines(errorSpy), 'WEBHOOK_DELIVERY_RECOVERY_DECRYPT_FAILED');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('never re-POSTs a delivery a worker had already claimed — outcome unknown', async () => {
    // `retrying` means a worker won the execution claim and then died. The POST
    // may or may not have reached the customer, so this is resolved terminally
    // rather than re-sent: silently repeating a possibly-delivered POST is
    // worse than surfacing one unknown outcome.
    state.candidates = [orphan({ status: 'retrying' })];
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }]];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(queueDeliveryMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ abandonedInFlight: 1, requeued: 0 });
    expect(state.updateCalls[1]!.set).toMatchObject({ status: 'failed' });
    expect(String(state.updateCalls[1]!.set.errorMessage)).toContain('outcome unknown');
    structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_RECOVERY_IN_FLIGHT_ABANDONED');
  });

  it('wires the RIGHT predicate to each call site', async () => {
    state.candidates = [orphan({ status: 'retrying' })];
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }]];

    await runWebhookDeliveryRecoverySweep(NOW);

    const leaseUntil = new Date(NOW.getTime() + RECOVERY_COOLDOWN_MS);
    // The compiled-SQL suite proves each builder is individually correct, but
    // nothing there proves the sweep CALLS the right one at the right place.
    // Swapping these two — claiming with the lease-held predicate, or writing
    // the terminal row with the claim predicate — reintroduces exactly the
    // TOCTOU hole the claim exists to close, and every other assertion in this
    // file would still pass.
    expect(state.updateCalls[0]!.where)
      .toEqual(buildRecoveryClaimCas('delivery-1', NOW));
    expect(state.updateCalls[1]!.where)
      .toEqual(buildLeaseHeldCas('delivery-1', leaseUntil));
  });

  it('still requeues at exactly the attempt limit, abandoning only past it', async () => {
    // Boundary: `> MAX` not `>= MAX`. A `>` -> `>=` slip abandons every row one
    // recovery cycle early, which looks like the sweep simply not working.
    state.candidates = [orphan({ recoveryAttempts: MAX_RECOVERY_ATTEMPTS - 1 })];
    state.updateResults = [claimWon(MAX_RECOVERY_ATTEMPTS)];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary).toMatchObject({ requeued: 1, exhausted: 0 });
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
  });

  it('reports a terminal write that lost the lease instead of counting it resolved', async () => {
    // The lease CAS matches the exact instant, so a delivery worker that took
    // the row in between makes this write match nothing. Counting it as
    // `abandonedInFlight` and logging "outcome unknown" would report a
    // resolution that never happened — the quiet miscount #4095 is about.
    state.candidates = [orphan({ status: 'retrying' })];
    state.updateResults = [claimWon(1), []]; // claim won, terminal write lost

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary).toMatchObject({ terminalWriteLost: 1, abandonedInFlight: 0 });
    const payload = structured(
      consoleLines(warnSpy),
      'WEBHOOK_DELIVERY_RECOVERY_TERMINAL_WRITE_LOST'
    );
    expect(payload).toMatchObject({ deliveryId: 'delivery-1' });
    expect(consoleLines(warnSpy).join(' '))
      .not.toContain('WEBHOOK_DELIVERY_RECOVERY_IN_FLIGHT_ABANDONED');
  });

  it('a throwing claim does not abort the rest of the batch', async () => {
    // The per-candidate catch is the sweep's mirror of the fan-out-aborting bug
    // this PR fixes in the subscriber, and the claim UPDATE is the only way to
    // reach it — every other failure path has its own inner catch.
    state.candidates = [
      orphan({ id: 'delivery-1' }),
      orphan({ id: 'delivery-2', webhookId: 'webhook-2', eventId: 'event-2' })
    ];
    state.updateResults = [new Error('claim blew up'), claimWon(1)];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary).toMatchObject({ scanned: 2, requeued: 1 });
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
    expect(queueDeliveryMock.mock.calls[0]![2]).toBe('delivery-2');
    const payload = structured(
      consoleLines(errorSpy),
      'WEBHOOK_DELIVERY_RECOVERY_CANDIDATE_FAILED'
    );
    expect(payload).toMatchObject({ deliveryId: 'delivery-1' });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('says nothing and does nothing when there is no orphan', async () => {
    state.candidates = [];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary).toMatchObject({ scanned: 0, requeued: 0 });
    expect(queueDeliveryMock).not.toHaveBeenCalled();
    // The healthy steady state is silent: this ticks every 5 minutes forever.
    expect(consoleLines(logSpy, warnSpy, errorSpy)).toHaveLength(0);
  });
});
