import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
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
  scheduledCandidates: [] as Record<string, unknown>[],
  selectCount: 0,
  updateCalls: [] as UpdateCall[],
  /** Queued FIFO of `.returning()` results, one per update. An Error rejects. */
  updateResults: [] as Array<Record<string, unknown>[] | Error>,
}));

const captureExceptionMock = vi.hoisted(() => vi.fn());
const enqueueWebhookAttemptMock = vi.hoisted(() => vi.fn());
const cutover = vi.hoisted(() => ({ pending: vi.fn(), drain: vi.fn() }));
vi.mock('./webhookLegacyQueueCutover', () => ({ legacyWebhookQueuesPending: cutover.pending, drainLegacyWebhookQueues: cutover.drain }));

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => state.selectCount++ === 0 ? state.candidates : state.scheduledCandidates
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

vi.mock('./webhookDeliveryQueue', () => ({ enqueueWebhookAttempt: enqueueWebhookAttemptMock }));

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

const NOW = new Date('2026-09-11T12:00:00.000Z');

function orphan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    webhookId: 'webhook-1',
    eventId: 'event-1',
    eventType: 'alert.triggered',
    payload: { alertId: 'a-1' },
    status: 'pending',
    attempts: 0,
    payloadVersion: 1, eventTimestamp: null, replayRootEventId: null,
    recoveryAttempts: 0,
    createdAt: new Date(NOW.getTime() - STALE_PENDING_MS - 60_000),
    deliveryOrgId: 'org-1',
    webhookStatus: 'active',
    webhookApprovalGeneration: 1,
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
    state.scheduledCandidates = [];
    state.selectCount = 0;
    state.updateCalls = [];
    state.updateResults = [];
    enqueueWebhookAttemptMock.mockReset();
    enqueueWebhookAttemptMock.mockResolvedValue('delivery-1');
    captureExceptionMock.mockReset();
    cutover.pending.mockReset().mockResolvedValue(false);
    cutover.drain.mockReset().mockResolvedValue({});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-drives a pending row by ids with its persisted attempt count', async () => {
    state.candidates = [orphan({ attempts: 2 })];
    state.updateResults = [claimWon(1)];
    const summary = await runWebhookDeliveryRecoverySweep(NOW);
    expect(summary).toMatchObject({ scanned: 1, requeued: 1 });
    expect(enqueueWebhookAttemptMock).toHaveBeenCalledExactlyOnceWith({ deliveryId: 'delivery-1', webhookId: 'webhook-1', generation: 1, attemptsMade: 2 }, NOW);
  });

  it('re-drives scheduled rows without stamping a lease, even for inactive webhooks', async () => {
    state.scheduledCandidates = [orphan({ status: 'scheduled', attempts: 3, webhookStatus: 'disabled' })];
    const summary = await runWebhookDeliveryRecoverySweep(NOW);
    expect(summary).toMatchObject({ scheduledScanned: 1, scheduledRedriven: 1 });
    expect(enqueueWebhookAttemptMock).toHaveBeenCalledExactlyOnceWith({ deliveryId: 'delivery-1', webhookId: 'webhook-1', generation: 1, attemptsMade: 3 }, NOW);
    expect(state.updateCalls).toEqual([]);
  });

  it.each([true, false])('resolves too-old scheduled rows by status and attempts CAS (landed=%s)', async landed => {
    state.scheduledCandidates = [orphan({ status: 'scheduled', attempts: 3, createdAt: new Date(NOW.getTime() - MAX_RECOVERABLE_AGE_MS - 1) })];
    state.updateResults = [landed ? [{ id: 'delivery-1' }] : []];
    const summary = await runWebhookDeliveryRecoverySweep(NOW);
    expect(summary).toMatchObject({ scheduledTooOld: landed ? 1 : 0, scheduledTerminalWriteLost: landed ? 0 : 1, tooOld: 0, terminalWriteLost: 0, scheduledRedriven: 0 });
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0]!.set).toEqual({ status: 'failed', failedAt: NOW, nextRetryAt: null, errorMessage: 'Retry was not sent before the delivery became too old; abandoned without delivery' });
    const compiled = new PgDialect().sqlToQuery(state.updateCalls[0]!.where as SQL);
    expect(compiled.sql).toContain('"status" =');
    expect(compiled.sql).toContain('"attempts" =');
    expect(compiled.params).toEqual(['delivery-1', 'scheduled', 3]);
    expect(enqueueWebhookAttemptMock).not.toHaveBeenCalled();
  });

  it('counts a scheduled enqueue failure without writing the row', async () => {
    state.scheduledCandidates = [orphan({ status: 'scheduled', attempts: 2 })];
    enqueueWebhookAttemptMock.mockRejectedValueOnce(new Error('Redis down'));
    const summary = await runWebhookDeliveryRecoverySweep(NOW);
    expect(summary).toMatchObject({ scheduledEnqueueFailed: 1, enqueueFailed: 0, scheduledRedriven: 0 });
    expect(state.updateCalls).toEqual([]);
    structured(consoleLines(errorSpy), 'WEBHOOK_DELIVERY_RECOVERY_REQUEUE_FAILED');
  });

  it.each(['pending', 'scheduled'])('keeps the recorded generation for a %s re-drive', async status => {
    const candidate = orphan({ status, webhookGeneration: 3, webhookApprovalGeneration: 4 });
    if (status === 'pending') { state.candidates = [candidate]; state.updateResults = [claimWon(1)]; }
    else state.scheduledCandidates = [candidate];
    await runWebhookDeliveryRecoverySweep(NOW);
    expect(enqueueWebhookAttemptMock.mock.calls[0]![0].generation).toBe(3);
  });

  it.each(['pending', 'scheduled'])('falls back to current generation for legacy NULL %s rows', async status => {
    const candidate = orphan({ status, webhookGeneration: null, webhookApprovalGeneration: 4 });
    if (status === 'pending') { state.candidates = [candidate]; state.updateResults = [claimWon(1)]; }
    else state.scheduledCandidates = [candidate];
    await runWebhookDeliveryRecoverySweep(NOW);
    expect(enqueueWebhookAttemptMock.mock.calls[0]![0].generation).toBe(4);
  });

  it.each([true, false])('drains legacy queues at sweep end only when pending=%s', async pending => {
    cutover.pending.mockResolvedValue(pending);
    await runWebhookDeliveryRecoverySweep(NOW);
    expect(cutover.pending).toHaveBeenCalledOnce();
    expect(cutover.drain).toHaveBeenCalledTimes(pending ? 1 : 0);
  });

  it('captures cut-over failure without failing the sweep', async () => {
    const error = new Error('cut-over failed');
    cutover.pending.mockResolvedValue(true);
    cutover.drain.mockRejectedValue(error);
    await expect(runWebhookDeliveryRecoverySweep(NOW)).resolves.toMatchObject({ scanned: 0 });
    expect(captureExceptionMock).toHaveBeenCalledWith(error);
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
    expect(enqueueWebhookAttemptMock).not.toHaveBeenCalled();
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

    expect(enqueueWebhookAttemptMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ exhausted: 1, requeued: 0 });

    // `failed` specifically: it is the only status the existing per-delivery
    // retry endpoint accepts, so the row stays hand-drivable instead of sitting
    // pending forever.
    const terminal = state.updateCalls[1]!;
    expect(terminal.set).toMatchObject({ failedAt: expect.any(Date), status: 'failed', nextRetryAt: null });
    // Wording matters: a `pending` row proves only that no worker ever CLAIMED
    // it, so the message says that rather than asserting more than we know.
    expect(String(terminal.set.errorMessage)).toContain('Never claimed by a delivery worker');

    structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_RECOVERY_EXHAUSTED');
  });

  it('does not POST to a webhook the customer has disabled, but still resolves the row', async () => {
    state.candidates = [orphan({ webhookStatus: 'disabled' })];
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }]];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(enqueueWebhookAttemptMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ undeliverable: 1 });
    expect(state.updateCalls[1]!.set).toMatchObject({ failedAt: expect.any(Date), status: 'failed' });
    const payload = structured(consoleLines(warnSpy), 'WEBHOOK_DELIVERY_RECOVERY_WEBHOOK_INACTIVE');
    expect(payload).toMatchObject({ webhookStatus: 'disabled' });
  });

  it('leaves the row recoverable when the re-enqueue itself fails', async () => {
    state.candidates = [orphan()];
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }]];
    enqueueWebhookAttemptMock.mockRejectedValueOnce(new Error('enqueue failed again'));

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
    enqueueWebhookAttemptMock.mockRejectedValueOnce(new Error('Redis down'));

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

    expect(enqueueWebhookAttemptMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ tooOld: 1, requeued: 0 });
    expect(state.updateCalls[1]!.set).toMatchObject({ failedAt: expect.any(Date), status: 'failed' });
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
    expect(enqueueWebhookAttemptMock).toHaveBeenCalledTimes(1);
  });

  it('one poisonous row does not abort the rest of the batch', async () => {
    state.candidates = [
      orphan({ id: 'delivery-1' }),
      orphan({ id: 'delivery-2', webhookId: 'webhook-2', eventId: 'event-2' })
    ];
    // claim(1) -> enqueue throws -> attempt REFUND -> claim(2).
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }], claimWon(1)];
    enqueueWebhookAttemptMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('delivery-2');

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary.scanned).toBe(2);
    expect(summary.requeued).toBe(1);
    expect(enqueueWebhookAttemptMock).toHaveBeenCalledTimes(2);
    expect(enqueueWebhookAttemptMock.mock.calls[1]![0].deliveryId).toBe('delivery-2');
  });

  // The former "marks a row terminal when the webhook credentials will not
  // decrypt" test lived here. Site-ceiling gate contract §7E moved ALL
  // decryption out of this sweep and into the delivery worker's send path —
  // this file no longer touches ciphertext at all, so it cannot observe a
  // decrypt failure. The equivalent terminal-outcome behavior (a decrypt
  // failure is recorded as a superseded/failed delivery, never retried) is
  // covered in workers/webhookDelivery.test.ts against
  // `resolveDeliveryWebhookConfig`.

  it('never re-POSTs a delivery a worker had already claimed — outcome unknown', async () => {
    // `retrying` means a worker won the execution claim and then died. The POST
    // may or may not have reached the customer, so this is resolved terminally
    // rather than re-sent: silently repeating a possibly-delivered POST is
    // worse than surfacing one unknown outcome.
    state.candidates = [orphan({ status: 'retrying' })];
    state.updateResults = [claimWon(1), [{ id: 'delivery-1' }]];

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(enqueueWebhookAttemptMock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ abandonedInFlight: 1, requeued: 0 });
    expect(state.updateCalls[1]!.set).toMatchObject({ failedAt: expect.any(Date), status: 'failed' });
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
    expect(enqueueWebhookAttemptMock).toHaveBeenCalledTimes(1);
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
    expect(enqueueWebhookAttemptMock).toHaveBeenCalledTimes(1);
    expect(enqueueWebhookAttemptMock.mock.calls[0]![0].deliveryId).toBe('delivery-2');
    const payload = structured(
      consoleLines(errorSpy),
      'WEBHOOK_DELIVERY_RECOVERY_CANDIDATE_FAILED'
    );
    expect(payload).toMatchObject({ deliveryId: 'delivery-1' });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('says nothing and does nothing when there is no orphan', async () => {
    state.candidates = [];
    state.scheduledCandidates = [];
    state.selectCount = 0;

    const summary = await runWebhookDeliveryRecoverySweep(NOW);

    expect(summary).toMatchObject({ scanned: 0, requeued: 0 });
    expect(enqueueWebhookAttemptMock).not.toHaveBeenCalled();
    // The healthy steady state is silent: this ticks every 5 minutes forever.
    expect(consoleLines(logSpy, warnSpy, errorSpy)).toHaveLength(0);
  });
});
