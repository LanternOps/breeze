import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behaviour of the event-dispatch worker (route-event + deliver-event
 * processing, #4085). The CAS PREDICATES are asserted as compiled SQL in the
 * sibling `eventDispatchWorker.sql.test.ts` — the db is mocked here, so a
 * `where` assertion in this file could only see an opaque object and could
 * not tell an `eq` from a `ne` (vacuous-Drizzle-assertion rule). This file
 * asserts what the processors DO: which receipts get written, which deliver
 * jobs get enqueued, and that the state machine transitions land on the right
 * branch.
 */

const {
  insertValuesMock,
  insertOnConflictMock,
  updateSetMock,
  updateWhereMock,
  updateReturningMock,
  selectLimitMock,
  executeMock,
  addBulkMock,
  getJobCountsMock,
  workerCloseMock,
  workerConstructorMock,
  queueConstructorMock,
  queueGetRepeatableJobsMock,
  queueRemoveRepeatableByKeyMock,
  queueAddMock,
  queueCloseMock,
  sharedBullMQConnection,
  attachWorkerObservabilityMock,
  captureExceptionMock,
  getSubscriberByIdMock,
  eventDispatchModeMock,
  jobScheduleMock,
  redisGetMock,
  redisSetMock,
  redisHgetallMock,
  redisLpushMock,
  redisLtrimMock,
  isShadowSampledEventMock
} = vi.hoisted(() => ({
  insertValuesMock: vi.fn(),
  insertOnConflictMock: vi.fn(),
  updateSetMock: vi.fn(),
  updateWhereMock: vi.fn(),
  updateReturningMock: vi.fn(),
  selectLimitMock: vi.fn(),
  executeMock: vi.fn(),
  addBulkMock: vi.fn(),
  getJobCountsMock: vi.fn(),
  workerCloseMock: vi.fn(),
  workerConstructorMock: vi.fn(),
  queueConstructorMock: vi.fn(),
  queueGetRepeatableJobsMock: vi.fn(),
  queueRemoveRepeatableByKeyMock: vi.fn(),
  queueAddMock: vi.fn(),
  queueCloseMock: vi.fn(),
  // A stable object identity so the Worker-construction test can prove the
  // SAME connection getBullMQConnection() returns is what was passed through,
  // not merely "an object that looks similar".
  sharedBullMQConnection: { host: 'shared-redis', port: 6379 },
  attachWorkerObservabilityMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  getSubscriberByIdMock: vi.fn(),
  eventDispatchModeMock: vi.fn(),
  jobScheduleMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisSetMock: vi.fn(),
  redisHgetallMock: vi.fn(),
  redisLpushMock: vi.fn(),
  redisLtrimMock: vi.fn(),
  isShadowSampledEventMock: vi.fn()
}));

vi.mock('bullmq', () => ({
  Worker: class {
    close = workerCloseMock;
    on = vi.fn();
    constructor(...args: unknown[]) {
      workerConstructorMock(...args);
    }
  },
  Queue: class {
    getRepeatableJobs = queueGetRepeatableJobsMock;
    removeRepeatableByKey = queueRemoveRepeatableByKeyMock;
    add = queueAddMock;
    close = queueCloseMock;
    constructor(...args: unknown[]) {
      queueConstructorMock(...args);
    }
  }
}));

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: (...args: unknown[]) => {
        insertValuesMock(...args);
        return { onConflictDoNothing: insertOnConflictMock };
      }
    })),
    update: vi.fn(() => ({
      set: (...args: unknown[]) => {
        updateSetMock(...args);
        return {
          where: (...whereArgs: unknown[]) => {
            updateWhereMock(...whereArgs);
            return { returning: updateReturningMock };
          }
        };
      }
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: selectLimitMock
        })
      })
    })),
    execute: executeMock
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn()
}));

vi.mock('../config/env', () => ({
  eventDispatchMode: eventDispatchModeMock
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => sharedBullMQConnection),
  getRedisConnection: vi.fn(() => ({
    get: redisGetMock,
    set: redisSetMock,
    hgetall: redisHgetallMock,
    lpush: redisLpushMock,
    ltrim: redisLtrimMock
  }))
}));

vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

vi.mock('../services/eventSubscriberRegistry', () => ({
  getSubscriberById: getSubscriberByIdMock
}));

vi.mock('../services/eventDispatchQueue', () => ({
  EVENT_DISPATCH_QUEUE: 'event-dispatch',
  getEventDispatchQueue: vi.fn(() => ({
    addBulk: addBulkMock,
    getJobCounts: getJobCountsMock
  })),
  isShadowSampledEvent: isShadowSampledEventMock,
  SHADOW_COUNT_PREFIX: 'breeze:event-shadow:count',
  SHADOW_LOCAL_PREFIX: 'breeze:event-shadow:local',
  SHADOW_LOCAL_TTL_SECONDS: 7200
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock
}));

vi.mock('./scheduleRegistry', () => ({
  jobSchedule: jobScheduleMock
}));

import {
  buildReceiptClaimCas,
  buildReceiptDeliveringCas,
  createEventDispatchWorker,
  eventDispatchProcessor,
  initializeEventDispatchWorker,
  processDeliverEvent,
  processRouteEvent,
  shutdownEventDispatchWorker,
  runReceiptRetentionSweep,
  runShadowComparisonSweep
} from './eventDispatchWorker';
import type { BreezeEvent, EventType } from '../services/eventBus';
import type { RouteEventJobData, DeliverEventJobData } from '../services/eventDispatchQueue';

function makeEvent(overrides: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'event-1',
    type: 'device.online' as EventType,
    orgId: 'org-1',
    source: 'unit-test',
    priority: 'normal',
    payload: {},
    metadata: { timestamp: new Date().toISOString() },
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertOnConflictMock.mockResolvedValue(undefined);
  updateReturningMock.mockResolvedValue([{ eventId: 'event-1' }]);
  selectLimitMock.mockResolvedValue([]);
  addBulkMock.mockResolvedValue([]);
  getJobCountsMock.mockResolvedValue({ waiting: 0, delayed: 0, active: 0, paused: 0 });
  eventDispatchModeMock.mockReturnValue('enforce');
  getSubscriberByIdMock.mockReturnValue(undefined);
  workerCloseMock.mockResolvedValue(undefined);
  jobScheduleMock.mockReturnValue('3 15 * * *');
  queueGetRepeatableJobsMock.mockResolvedValue([]);
  queueAddMock.mockResolvedValue(undefined);
  queueCloseMock.mockResolvedValue(undefined);
  redisGetMock.mockResolvedValue(null);
  redisSetMock.mockResolvedValue(undefined);
  redisHgetallMock.mockResolvedValue({});
  redisLpushMock.mockResolvedValue(undefined);
  redisLtrimMock.mockResolvedValue(undefined);
  isShadowSampledEventMock.mockReturnValue(false);
});

describe('processRouteEvent', () => {
  it('empty queueSubscriberIds: successful no-op (not an error)', async () => {
    const data: RouteEventJobData = {
      v: 1,
      mode: 'enforce',
      event: makeEvent(),
      matchedSubscriberIds: [],
      queueSubscriberIds: []
    };

    await processRouteEvent(data);

    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(addBulkMock).not.toHaveBeenCalled();
  });

  it('shadow mode: bulk-inserts planned receipts, stops before addBulk', async () => {
    const event = makeEvent();
    const data: RouteEventJobData = {
      v: 1,
      mode: 'shadow',
      event,
      matchedSubscriberIds: ['webhook-delivery', 'automation-worker'],
      queueSubscriberIds: ['webhook-delivery', 'automation-worker']
    };

    await processRouteEvent(data);

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const rows = insertValuesMock.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { eventId: 'event-1', subscriberId: 'webhook-delivery', orgId: 'org-1', eventType: 'device.online', mode: 'shadow', status: 'planned' },
      { eventId: 'event-1', subscriberId: 'automation-worker', orgId: 'org-1', eventType: 'device.online', mode: 'shadow', status: 'planned' }
    ]);
    expect(insertOnConflictMock).toHaveBeenCalledTimes(1);
    expect(addBulkMock).not.toHaveBeenCalled();
  });

  it('enforce mode: inserts receipts AND addBulk one deliver-event per queue subscriber, with per-subscriber retry policy', async () => {
    const event = makeEvent();
    getSubscriberByIdMock.mockImplementation((id: string) =>
      id === 'webhook-delivery'
        ? { id, eventTypes: '*', handler: vi.fn(), retry: { attempts: 3, backoffMs: 2000 } }
        : undefined
    );
    const data: RouteEventJobData = {
      v: 1,
      mode: 'enforce',
      event,
      matchedSubscriberIds: ['webhook-delivery', 'automation-worker'],
      queueSubscriberIds: ['webhook-delivery', 'automation-worker']
    };

    await processRouteEvent(data);

    expect(insertOnConflictMock).toHaveBeenCalledTimes(1);
    expect(addBulkMock).toHaveBeenCalledTimes(1);
    const jobs = addBulkMock.mock.calls[0]![0] as Array<{ name: string; data: DeliverEventJobData; opts: Record<string, unknown> }>;
    expect(jobs).toHaveLength(2);

    expect(jobs[0]).toMatchObject({
      name: 'deliver-event',
      data: { v: 1, subscriberId: 'webhook-delivery', event },
      opts: {
        jobId: 'event-deliver-webhook-delivery-event-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 }
      }
    });
    // jobId is hyphen-only (BullMQ jobId rule).
    expect((jobs[0]!.opts.jobId as string)).not.toContain(':');

    // Unregistered subscriber at route time still gets a deliver job, using
    // default retry policy — the snapshot is trusted verbatim; the unknown
    // subscriber is handled at delivery time instead.
    expect(jobs[1]).toMatchObject({
      name: 'deliver-event',
      data: { v: 1, subscriberId: 'automation-worker', event },
      opts: {
        jobId: 'event-deliver-automation-worker-event-1',
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 }
      }
    });
  });
});

describe('processDeliverEvent', () => {
  it('unknown subscriberId: terminal — logs, captures, CASes the receipt straight to failed (claim-free), does not throw', async () => {
    getSubscriberByIdMock.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const expectedCas = buildReceiptClaimCas('event-1', 'webhook-delivery');

    const data: DeliverEventJobData = { v: 1, subscriberId: 'webhook-delivery', event: makeEvent() };
    await expect(processDeliverEvent(data)).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    // A `planned` row left untouched would be invisible to the retention
    // sweep's partial index (`WHERE status IN ('delivered','failed')`) — this
    // path must actively move it to `failed` rather than just logging.
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock.mock.calls[0]![0]).toMatchObject({ status: 'failed', lastError: 'unknown subscriber' });
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
    expect(updateWhereMock.mock.calls[0]![0]).toEqual(expectedCas);
    // Claim-free: no `.returning()` result is ever consulted for this path,
    // so there is nothing to claim/reclaim — the handler is never invoked.
    errorSpy.mockRestore();
  });

  it('receipt already delivered: idempotent skip, handler never called', async () => {
    const handler = vi.fn();
    getSubscriberByIdMock.mockReturnValue({ id: 'webhook-delivery', eventTypes: '*', handler });
    // Claim CAS returns zero rows...
    updateReturningMock.mockResolvedValueOnce([]);
    // ...and the read-back finds an existing (necessarily delivered) row.
    selectLimitMock.mockResolvedValueOnce([{ status: 'delivered' }]);

    const data: DeliverEventJobData = { v: 1, subscriberId: 'webhook-delivery', event: makeEvent() };
    await processDeliverEvent(data);

    expect(handler).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('no receipt row at all: inserts planned then reclaims (route/deliver race), then proceeds to the handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    getSubscriberByIdMock.mockReturnValue({ id: 'webhook-delivery', eventTypes: '*', handler });
    // First claim attempt: zero rows (no receipt exists yet).
    updateReturningMock.mockResolvedValueOnce([]);
    // Read-back finds nothing.
    selectLimitMock.mockResolvedValueOnce([]);
    // Reclaim after the fallback insert succeeds.
    updateReturningMock.mockResolvedValueOnce([{ eventId: 'event-1' }]);
    // Final delivered write.
    updateReturningMock.mockResolvedValueOnce([{ eventId: 'event-1' }]);

    const event = makeEvent();
    await processDeliverEvent({ v: 1, subscriberId: 'webhook-delivery', event });

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        subscriberId: 'webhook-delivery',
        orgId: 'org-1',
        eventType: 'device.online',
        mode: 'enforce',
        status: 'planned'
      })
    );
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('claim CAS: the claim update() where() receives buildReceiptClaimCas\'s output directly (compiled SQL itself asserted in eventDispatchWorker.sql.test.ts)', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    getSubscriberByIdMock.mockReturnValue({ id: 'webhook-delivery', eventTypes: '*', handler });
    updateReturningMock.mockResolvedValue([{ eventId: 'event-1' }]);
    const expectedCas = buildReceiptClaimCas('event-1', 'webhook-delivery');

    await processDeliverEvent({ v: 1, subscriberId: 'webhook-delivery', event: makeEvent() });

    expect(updateWhereMock).toHaveBeenCalledTimes(2);
    // Same SQL AST shape as a fresh call with the same arguments — proves the
    // claim step calls buildReceiptClaimCas(eventId, subscriberId) rather than
    // some other predicate.
    expect(updateWhereMock.mock.calls[0]![0]).toEqual(expectedCas);
  });

  it('handler throws: CAS delivering -> failed with truncated last_error, then rethrows', async () => {
    const boom = new Error('x'.repeat(600));
    const handler = vi.fn().mockRejectedValue(boom);
    getSubscriberByIdMock.mockReturnValue({ id: 'webhook-delivery', eventTypes: '*', handler });
    updateReturningMock.mockResolvedValue([{ eventId: 'event-1' }]);
    const expectedDeliveringCas = buildReceiptDeliveringCas('event-1', 'webhook-delivery');

    await expect(
      processDeliverEvent({ v: 1, subscriberId: 'webhook-delivery', event: makeEvent() })
    ).rejects.toBe(boom);

    // Two update calls: the claim, then the failed-outcome write.
    expect(updateSetMock).toHaveBeenCalledTimes(2);
    const failedSet = updateSetMock.mock.calls[1]![0] as { status: string; lastError: string };
    expect(failedSet.status).toBe('failed');
    expect(failedSet.lastError).toHaveLength(500);
    // The outcome write must use the DELIVERING cas (calls[1]), not the claim
    // CAS (calls[0]) — swapping the two predicates would let a failure write
    // land on a receipt this attempt never actually held the claim on.
    expect(updateWhereMock).toHaveBeenCalledTimes(2);
    expect(updateWhereMock.mock.calls[1]![0]).toEqual(expectedDeliveringCas);
  });

  it('handler succeeds: CAS delivering -> delivered, with delivered_at set', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    getSubscriberByIdMock.mockReturnValue({ id: 'webhook-delivery', eventTypes: '*', handler });
    updateReturningMock.mockResolvedValue([{ eventId: 'event-1' }]);
    const expectedDeliveringCas = buildReceiptDeliveringCas('event-1', 'webhook-delivery');

    await processDeliverEvent({ v: 1, subscriberId: 'webhook-delivery', event: makeEvent() });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledTimes(2);
    const deliveredSet = updateSetMock.mock.calls[1]![0] as { status: string; deliveredAt: unknown };
    expect(deliveredSet.status).toBe('delivered');
    // Dropping deliveredAt would otherwise pass silently.
    expect(deliveredSet.deliveredAt).toBeDefined();
    expect(updateWhereMock).toHaveBeenCalledTimes(2);
    expect(updateWhereMock.mock.calls[1]![0]).toEqual(expectedDeliveringCas);
  });
});

describe('eventDispatchProcessor', () => {
  it('route-event: schema parse failure is terminal — logs, captures, does NOT throw (no infinite retry)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = { id: 'job-1', name: 'route-event', data: { not: 'valid' } } as never;

    await expect(eventDispatchProcessor(job)).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('deliver-event: schema parse failure is terminal — logs, captures, does NOT throw', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = { id: 'job-2', name: 'deliver-event', data: { subscriberId: 'not-a-real-subscriber' } } as never;

    await expect(eventDispatchProcessor(job)).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(getSubscriberByIdMock).not.toHaveBeenCalled();
    // No `event.id` on this malformed payload — nothing to identify a receipt
    // by, so the CAS-on-parse-failure path (below) must not fire either.
    expect(updateSetMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // Final-review fix (#4085): breezeEventEnvelopeSchema is `.strict()`
  // specifically so a future BreezeEvent field is caught HERE — this proves
  // that failure mode doesn't silently drop the delivery with no terminal
  // receipt state. `event.id`/`subscriberId` are still readable even though
  // parse failed (an unrelated field is what tripped `.strict()`), so the
  // receipt this job was already inserted for (by the route-event job) must
  // be CAS'd to `failed` — same claim-free shape as the unknown-subscriber
  // path — rather than left stuck at `planned`/`delivering` forever.
  it('deliver-event: schema parse failure CASes the already-inserted receipt to failed (claim-free, mirrors unknown-subscriber path)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = {
      id: 'job-2b',
      name: 'deliver-event',
      // Simulates BreezeEvent drift: a genuine new top-level field the
      // `.strict()` envelope schema does not know about yet. event.id and
      // subscriberId are both intact and readable.
      data: {
        v: 1,
        subscriberId: 'webhook-delivery',
        event: { ...makeEvent(), unexpectedNewField: 'drift' }
      }
    } as never;

    await expect(eventDispatchProcessor(job)).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(getSubscriberByIdMock).not.toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', lastError: 'schema validation' })
    );
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
    expect(updateWhereMock.mock.calls[0]![0]).toEqual(buildReceiptClaimCas('event-1', 'webhook-delivery'));
    errorSpy.mockRestore();
  });

  it('deliver-event: schema parse failure with no identifiable event.id/subscriberId skips the CAS silently (beyond the log/capture)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = { id: 'job-2c', name: 'deliver-event', data: { v: 1, event: { id: 'event-1' } } } as never;

    await expect(eventDispatchProcessor(job)).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('dispatches a valid route-event job to processRouteEvent (non-empty plan: receipts inserted + deliver jobs addBulk\'d)', async () => {
    const event = makeEvent();
    const job = {
      id: 'job-3',
      name: 'route-event',
      data: {
        v: 1,
        mode: 'enforce',
        event,
        matchedSubscriberIds: ['webhook-delivery'],
        queueSubscriberIds: ['webhook-delivery']
      }
    } as never;

    await eventDispatchProcessor(job);

    // A processor that ignored route-event entirely (or silently no-op'd)
    // would leave both of these uncalled — this is what a non-empty plan is
    // for; the empty-plan no-op branch has its own dedicated test above.
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledWith([
      expect.objectContaining({ eventId: 'event-1', subscriberId: 'webhook-delivery', status: 'planned' })
    ]);
    expect(addBulkMock).toHaveBeenCalledTimes(1);
  });
});

describe('initializeEventDispatchWorker / shutdownEventDispatchWorker', () => {
  // The module holds `worker` / `maintenanceWorker` / `maintenanceQueue` in
  // module-level state. Since maintenance now registers on EVERY path
  // (including the ones that never start a main worker), a test that leaves
  // it running would leak that state into the next test's close()/construct()
  // counts. Shutting down after every case keeps each `it` independent.
  afterEach(async () => {
    await shutdownEventDispatchWorker();
  });

  /** Worker names passed to attachWorkerObservability, in call order. */
  function observedWorkerNames(): string[] {
    return attachWorkerObservabilityMock.mock.calls.map((call) => (call as [unknown, string])[1]);
  }

  /** BullMQ queue names the Worker constructor was invoked with, in order. */
  function constructedWorkerQueues(): string[] {
    return workerConstructorMock.mock.calls.map((call) => (call as [string, ...unknown[]])[0]);
  }

  it('mode off, empty queue: main worker NOT started, but the maintenance repeatables STILL register (#4124)', async () => {
    eventDispatchModeMock.mockReturnValue('off');
    getJobCountsMock.mockResolvedValue({ waiting: 0, delayed: 0, active: 0, paused: 0 });

    await initializeEventDispatchWorker();

    // Registration is unconditional so residual `event_delivery_receipts`
    // from a completed rollout keep aging out after EVENT_DISPATCH_MODE goes
    // back to 'off' and the queue drains — previously they only aged out the
    // next time the main worker happened to start.
    expect(observedWorkerNames()).toEqual(['eventDispatchMaintenance']);
    expect(constructedWorkerQueues()).toEqual(['event-dispatch-maintenance']);
    expect(queueAddMock.mock.calls.map((call) => call[0])).toEqual([
      'receipt-retention',
      'shadow-compare'
    ]);
  });

  it('mode off, backlog probe throws: does NOT propagate (would permanently pin /ready) — treated as no backlog, main worker not started, maintenance still registers', async () => {
    eventDispatchModeMock.mockReturnValue('off');
    getJobCountsMock.mockRejectedValue(new Error('redis unreachable'));

    await expect(initializeEventDispatchWorker()).resolves.toBeUndefined();

    // Only the probe failure is reported — maintenance registration succeeded.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(observedWorkerNames()).toEqual(['eventDispatchMaintenance']);
    expect(constructedWorkerQueues()).toEqual(['event-dispatch-maintenance']);
    expect(queueAddMock.mock.calls.map((call) => call[0])).toEqual([
      'receipt-retention',
      'shadow-compare'
    ]);
  });

  it('mode off, empty queue, maintenance registration fails: still resolves (a housekeeping job must never pin /ready) and closes what it opened', async () => {
    eventDispatchModeMock.mockReturnValue('off');
    getJobCountsMock.mockResolvedValue({ waiting: 0, delayed: 0, active: 0, paused: 0 });
    const boom = new Error('redis unreachable during repeatable registration');
    queueGetRepeatableJobsMock.mockRejectedValue(boom);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(initializeEventDispatchWorker()).resolves.toBeUndefined();

      // This suppression is swallowed BY DESIGN (a housekeeping job must never
      // pin /ready), and since #4124 it runs on the default mode='off' boot —
      // i.e. on every instance in the fleet, not just the opt-in rollout
      // population. The Sentry report is therefore the ONLY operator-visible
      // trace that retention never got scheduled, so it has to carry the
      // `worker` tag (the triage axis attachWorkerObservability gives every
      // other failure on this worker) and a greppable errorId in the log line.
      expect(captureExceptionMock).toHaveBeenCalledWith(boom, undefined, {
        worker: 'eventDispatchMaintenance'
      });
      expect(
        consoleError.mock.calls.some((call) =>
          call.some(
            (arg) =>
              typeof arg === 'string' &&
              arg.includes('EVENT_DISPATCH_MAINTENANCE_REGISTRATION_FAILED')
          )
        )
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
    }

    // The maintenance worker + queue this path opened are both closed. No main
    // worker exists on this path, so the subsequent shutdown (afterEach) has
    // nothing further to close.
    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('mode off, queue has a backlog: starts the worker anyway to drain it, AND registers the maintenance repeatables', async () => {
    eventDispatchModeMock.mockReturnValue('off');
    getJobCountsMock.mockResolvedValue({ waiting: 2, delayed: 0, active: 0, paused: 0 });

    await initializeEventDispatchWorker();

    // Two workers now: the main event-dispatch worker and the dedicated
    // maintenance worker (retention + shadow-compare).
    expect(attachWorkerObservabilityMock).toHaveBeenCalledTimes(2);
    expect(queueAddMock).toHaveBeenCalledTimes(2);
    await shutdownEventDispatchWorker();
    expect(workerCloseMock).toHaveBeenCalledTimes(2);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('mode shadow/enforce: always starts the worker and registers the maintenance repeatables', async () => {
    eventDispatchModeMock.mockReturnValue('enforce');

    await initializeEventDispatchWorker();

    expect(getJobCountsMock).not.toHaveBeenCalled();
    expect(attachWorkerObservabilityMock).toHaveBeenCalledTimes(2);
    await shutdownEventDispatchWorker();
  });

  it('registers receipt-retention on the scheduleRegistry cron lane and shadow-compare on a 5-minute every:, after clearing any pre-existing repeatables', async () => {
    eventDispatchModeMock.mockReturnValue('enforce');
    queueGetRepeatableJobsMock.mockResolvedValue([{ key: 'stale-repeat-key' }]);
    jobScheduleMock.mockReturnValue('3 15 * * *');

    await initializeEventDispatchWorker();

    expect(queueRemoveRepeatableByKeyMock).toHaveBeenCalledWith('stale-repeat-key');
    expect(jobScheduleMock).toHaveBeenCalledWith('receipt-retention');

    const [retentionCall, shadowCall] = queueAddMock.mock.calls as Array<
      [string, unknown, Record<string, unknown>]
    >;
    expect(retentionCall![0]).toBe('receipt-retention');
    expect(retentionCall![2]).toMatchObject({ repeat: { pattern: '3 15 * * *' } });
    expect(shadowCall![0]).toBe('shadow-compare');
    expect(shadowCall![2]).toMatchObject({ repeat: { every: 5 * 60 * 1000 } });

    await shutdownEventDispatchWorker();
  });

  it('maintenance registration failure: ISOLATED — closes only the maintenance worker/queue, leaves the main worker running, resolves (does not reject), and reports via captureException', async () => {
    eventDispatchModeMock.mockReturnValue('enforce');
    const boom = new Error('redis unreachable during repeatable registration');
    queueGetRepeatableJobsMock.mockRejectedValue(boom);

    // Must NOT reject: index.ts sets workerStatus['eventDispatch'] = true only
    // if this promise resolves, and a maintenance-only failure must not pin
    // /ready to not-ready over a housekeeping job (same lesson as the
    // off-mode backlog-probe guard just above in the same function).
    await expect(initializeEventDispatchWorker()).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    // Tagged `worker` so the report is attributable in Sentry — see the
    // mode='off' sibling case above for why this tag carries the whole triage
    // burden for a failure that is otherwise swallowed.
    expect(captureExceptionMock).toHaveBeenCalledWith(boom, undefined, {
      worker: 'eventDispatchMaintenance'
    });

    // Cleanup closed the maintenance worker (Worker#close, shared mock with
    // the main worker's — see below) and the maintenance queue: one call
    // each so far.
    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);

    // The main worker is genuinely still alive (not nulled out by the catch
    // block): shutdown now closes it too — ONE MORE Worker#close() call.
    // Under the old (buggy) behaviour, the catch block already nulled out
    // `worker` here, so this shutdown call would add ZERO further close()
    // calls and this assertion would catch the regression.
    await shutdownEventDispatchWorker();
    expect(workerCloseMock).toHaveBeenCalledTimes(2);
    // The maintenance queue was already closed and nulled in the catch block
    // — shutdown finds nothing left to close there.
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('createEventDispatchWorker constructs with the shared BullMQ connection and concurrency 5', () => {
    const w = createEventDispatchWorker();
    expect(w).toBeDefined();

    expect(workerConstructorMock).toHaveBeenCalledTimes(1);
    const [queueName, processorFn, opts] = workerConstructorMock.mock.calls[0]! as [string, unknown, Record<string, unknown>];
    expect(queueName).toBe('event-dispatch');
    expect(typeof processorFn).toBe('function');
    // Reference equality: the SAME object getBullMQConnection() returns, not
    // merely a similarly-shaped one — proves the shared connection pool is
    // actually threaded through rather than a fresh one being created.
    expect(opts.connection).toBe(sharedBullMQConnection);
    expect(opts.concurrency).toBe(5);
  });

  it('shutdown is a no-op when no worker was ever started', async () => {
    await expect(shutdownEventDispatchWorker()).resolves.toBeUndefined();
  });
});

describe('runReceiptRetentionSweep', () => {
  it('pass 1 loops until a batch comes back under the 5000 batch size, per-pass compiled WHERE matches the sql.test.ts assertions', async () => {
    executeMock
      .mockResolvedValueOnce({ count: 5000 }) // pass 1, iteration 1: full batch, loop again
      .mockResolvedValueOnce({ count: 1200 }) // pass 1, iteration 2: partial batch, stop
      .mockResolvedValueOnce({ count: 0 }) // pass 2: empty, stop immediately
      .mockResolvedValueOnce([{ count: 0 }]) // pass 3 count: nothing abandoned
      .mockResolvedValueOnce({ count: 0 }); // pass 3 delete: empty, stop immediately

    const summary = await runReceiptRetentionSweep();

    expect(summary).toEqual({ delivered: 6200, shadow: 0, residual: 0, abandonedResidualCount: 0 });
    expect(executeMock).toHaveBeenCalledTimes(5);

    // Each call receives a DIFFERENT compiled query object — proves pass 1
    // does NOT reuse pass 2's or pass 3's predicate.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const dialect = new PgDialect();
    const compiled = (i: number) => dialect.sqlToQuery(executeMock.mock.calls[i]![0]).sql;
    expect(compiled(0)).toContain("status = 'delivered'");
    expect(compiled(0)).toContain("interval '7 days'");
    expect(compiled(2)).toContain("mode = 'shadow'");
    expect(compiled(2)).toContain("interval '48 hours'");
    expect(compiled(3)).toContain("status IN ('failed', 'planned', 'delivering')");
    expect(compiled(3)).toContain("interval '30 days'");
    expect(compiled(4)).toContain("status IN ('failed', 'planned', 'delivering')");
    expect(compiled(4)).toContain("interval '30 days'");
  });

  it('abandoned-warn fires with the count BEFORE the residual pass deletes those rows', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    executeMock
      .mockResolvedValueOnce({ count: 0 }) // pass 1: empty
      .mockResolvedValueOnce({ count: 0 }) // pass 2: empty
      .mockResolvedValueOnce([{ count: 7 }]) // pass 3 count: 7 abandoned rows
      .mockResolvedValueOnce({ count: 7 }); // pass 3 delete: removes them (< batch size, loop stops)

    const summary = await runReceiptRetentionSweep();

    expect(summary.abandonedResidualCount).toBe(7);
    expect(summary.residual).toBe(7);
    const warnCall = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes('EVENT_DISPATCH_RECEIPTS_ABANDONED')
    );
    expect(warnCall).toBeDefined();
    expect(String(warnCall![0])).toContain('"count":7');

    // The warn must be logged before the delete executes — assert call order.
    const warnCallIndex = warnSpy.mock.invocationCallOrder[warnSpy.mock.calls.indexOf(warnCall!)]!;
    const deleteCallIndex = executeMock.mock.invocationCallOrder[3]!;
    expect(warnCallIndex).toBeLessThan(deleteCallIndex);

    warnSpy.mockRestore();
  });

  it('no residual rows: does not warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    executeMock
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce({ count: 0 });

    await runReceiptRetentionSweep();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('runShadowComparisonSweep', () => {
  it('non-shadow-mode run is a cheap no-op: no DB query, no Redis reads', async () => {
    eventDispatchModeMock.mockReturnValue('enforce');

    const result = await runShadowComparisonSweep();

    expect(result).toEqual({ skipped: true });
    expect(executeMock).not.toHaveBeenCalled();
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(redisHgetallMock).not.toHaveBeenCalled();
  });

  it('first run for a subscriber: baselines the snapshot instead of reporting lifetime volume as this run\'s delta', async () => {
    eventDispatchModeMock.mockReturnValue('shadow');
    executeMock.mockResolvedValueOnce([]); // empty window
    redisGetMock.mockResolvedValue(null); // no last-run watermark, no snapshot for any subscriber
    redisHgetallMock.mockImplementation(async (key: string) => {
      if (key === 'breeze:event-shadow:count:webhook-delivery') return { ok: '500', error: '3' };
      return {};
    });

    const summary = await runShadowComparisonSweep();

    expect(summary).not.toHaveProperty('skipped');
    const deltas = (summary as { subscriberDeltas: Record<string, { localDelta: number; receiptCount: number }> })
      .subscriberDeltas;
    // 503 lifetime invocations must NOT surface as a 503 delta on the very
    // first run — the snapshot baselines to the current absolute.
    expect(deltas['webhook-delivery']!.localDelta).toBe(0);
    expect(deltas['webhook-delivery']!.receiptCount).toBe(0);
    // The snapshot is then stored so the NEXT run has something to diff against.
    expect(redisSetMock).toHaveBeenCalledWith('breeze:event-shadow:count-snapshot:webhook-delivery', '503');
  });

  it('second run: delta is current-minus-previous-snapshot, matched against receipts in the window', async () => {
    eventDispatchModeMock.mockReturnValue('shadow');
    executeMock.mockResolvedValueOnce([
      { event_id: 'evt-1', event_type: 'device.online', subscriber_id: 'webhook-delivery' },
      { event_id: 'evt-2', event_type: 'device.online', subscriber_id: 'webhook-delivery' }
    ]);
    redisGetMock.mockImplementation(async (key: string) => {
      if (key === 'breeze:event-shadow:count-snapshot:webhook-delivery') return '500'; // previous
      return null;
    });
    redisHgetallMock.mockImplementation(async (key: string) => {
      if (key === 'breeze:event-shadow:count:webhook-delivery') return { ok: '501', error: '1' }; // current = 502
      return {};
    });

    const summary = await runShadowComparisonSweep();

    const deltas = (summary as { subscriberDeltas: Record<string, { localDelta: number; receiptCount: number; withinTolerance: boolean }> })
      .subscriberDeltas;
    expect(deltas['webhook-delivery']).toEqual({ localDelta: 2, receiptCount: 2, withinTolerance: true });
    expect(redisSetMock).toHaveBeenCalledWith('breeze:event-shadow:count-snapshot:webhook-delivery', '502');
  });

  it('flags a planted swap (event A missing its subscriber locally, aggregate totals still match) that count-comparison alone would conceal', async () => {
    eventDispatchModeMock.mockReturnValue('shadow');
    // Router planned 'notification-dispatcher' for BOTH evt-a and evt-b.
    executeMock.mockResolvedValueOnce([
      { event_id: 'evt-a', event_type: 'alert.new', subscriber_id: 'notification-dispatcher' },
      { event_id: 'evt-b', event_type: 'alert.new', subscriber_id: 'notification-dispatcher' }
    ]);
    // Aggregate count hash reports exactly 2 total invocations — matches the
    // 2 receipts exactly, so the pure COUNT comparison sees no problem at all,
    // even though (per the local hashes below) evt-a's invocation never
    // actually ran for this subscriber and evt-b's ran twice.
    redisGetMock.mockImplementation(async (key: string) => {
      if (key === 'breeze:event-shadow:count-snapshot:notification-dispatcher') return '0';
      return null;
    });
    redisHgetallMock.mockImplementation(async (key: string) => {
      if (key === 'breeze:event-shadow:count:notification-dispatcher') return { ok: '2', error: '0' };
      if (key === 'breeze:event-shadow:local:evt-a') return {}; // MISSING locally
      if (key === 'breeze:event-shadow:local:evt-b') return { 'notification-dispatcher': 'ok' };
      return {};
    });
    isShadowSampledEventMock.mockReturnValue(true); // both events sampled
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await runShadowComparisonSweep();

    const result = summary as {
      subscriberDeltas: Record<string, { withinTolerance: boolean }>;
      mismatches: number;
      samplesChecked: number;
    };
    // The aggregate signal reports all-clear...
    expect(result.subscriberDeltas['notification-dispatcher']!.withinTolerance).toBe(true);
    // ...but the exact per-event signal catches exactly the one broken event.
    expect(result.samplesChecked).toBe(2);
    expect(result.mismatches).toBe(1);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const mismatchCall = errorSpy.mock.calls.find((call) => String(call[0]).includes('EVENT_DISPATCH_SHADOW_MISMATCH'));
    expect(mismatchCall).toBeDefined();
    expect(String(mismatchCall![0])).toContain('"eventId":"evt-a"');
    expect(String(mismatchCall![0])).not.toContain('"eventId":"evt-b"');

    expect(redisLpushMock).toHaveBeenCalledTimes(1);
    expect(redisLpushMock).toHaveBeenCalledWith(
      'breeze:event-shadow:mismatches',
      expect.stringContaining('"eventId":"evt-a"')
    );
    expect(redisLtrimMock).toHaveBeenCalledWith('breeze:event-shadow:mismatches', 0, 999);
    errorSpy.mockRestore();
  });

  it('un-sampled events are excluded from the per-event sample diff entirely', async () => {
    eventDispatchModeMock.mockReturnValue('shadow');
    executeMock.mockResolvedValueOnce([
      { event_id: 'evt-unsampled', event_type: 'device.online', subscriber_id: 'webhook-delivery' }
    ]);
    isShadowSampledEventMock.mockReturnValue(false);

    const summary = await runShadowComparisonSweep();

    expect((summary as { samplesChecked: number }).samplesChecked).toBe(0);
    expect(redisHgetallMock).not.toHaveBeenCalledWith('breeze:event-shadow:local:evt-unsampled');
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('sample cap: never diffs more than 200 sampled events per run', async () => {
    eventDispatchModeMock.mockReturnValue('shadow');
    const rows = Array.from({ length: 250 }, (_, i) => ({
      event_id: `evt-${i}`,
      event_type: 'alert.new',
      subscriber_id: 'notification-dispatcher'
    }));
    executeMock.mockResolvedValueOnce(rows);
    isShadowSampledEventMock.mockReturnValue(true);
    redisHgetallMock.mockImplementation(async (key: string) => {
      if (key.startsWith('breeze:event-shadow:local:')) return { 'notification-dispatcher': 'ok' };
      return {};
    });

    const summary = await runShadowComparisonSweep();

    expect((summary as { samplesChecked: number }).samplesChecked).toBe(200);
  });

  it('clamps the window to the local-hash TTL (2h): a 3h-old watermark does not resurrect a receipt older than the TTL as a spurious mismatch, while a recent receipt in the clamped window is still genuinely checked', async () => {
    eventDispatchModeMock.mockReturnValue('shadow');
    const now = Date.now();
    const threeHoursAgo = new Date(now - 3 * 60 * 60 * 1000);
    const twoAndHalfHoursAgo = new Date(now - 2.5 * 60 * 60 * 1000); // older than the 2h TTL floor
    const thirtyMinutesAgo = new Date(now - 30 * 60 * 1000); // inside the clamped window

    redisGetMock.mockImplementation(async (key: string) => {
      if (key === 'breeze:event-shadow:compare-last-run') return threeHoursAgo.toISOString();
      return null;
    });

    // A stand-in for what Postgres's own `created_at >= windowStart` predicate
    // would do: filters the fixture by the ACTUAL windowStart param the code
    // passed to db.execute, so this test fails if the clamp is removed (the
    // stale row would then be included, per the mutation-verification note).
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const dialect = new PgDialect();
    const fixtureRows = [
      { event_id: 'evt-stale', event_type: 'alert.new', subscriber_id: 'notification-dispatcher', createdAt: twoAndHalfHoursAgo },
      { event_id: 'evt-recent', event_type: 'alert.new', subscriber_id: 'notification-dispatcher', createdAt: thirtyMinutesAgo }
    ];
    executeMock.mockImplementation(async (query: unknown) => {
      const { params } = dialect.sqlToQuery(query as never);
      const windowStart = new Date(params[0] as string);
      return fixtureRows
        .filter((r) => r.createdAt.getTime() >= windowStart.getTime())
        .map(({ event_id, event_type, subscriber_id }) => ({ event_id, event_type, subscriber_id }));
    });

    isShadowSampledEventMock.mockReturnValue(true);
    // Neither event has a local hash — evt-recent is a genuine mismatch (it's
    // inside the clamped window); evt-stale must never even be fetched.
    redisHgetallMock.mockResolvedValue({});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await runShadowComparisonSweep();

    const result = summary as { samplesChecked: number; mismatches: number };
    expect(result.samplesChecked).toBe(1);
    expect(result.mismatches).toBe(1);
    const mismatchCall = errorSpy.mock.calls.find((c) => String(c[0]).includes('EVENT_DISPATCH_SHADOW_MISMATCH'));
    expect(mismatchCall).toBeDefined();
    expect(String(mismatchCall![0])).toContain('"eventId":"evt-recent"');
    expect(String(mismatchCall![0])).not.toContain('"eventId":"evt-stale"');

    const clampWarn = warnSpy.mock.calls.find((c) => String(c[0]).includes('shadow-compare-window-clamped'));
    expect(clampWarn).toBeDefined();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
