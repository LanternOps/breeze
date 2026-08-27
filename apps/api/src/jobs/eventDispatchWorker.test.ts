import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  addBulkMock,
  getJobCountsMock,
  workerCloseMock,
  attachWorkerObservabilityMock,
  captureExceptionMock,
  getSubscriberByIdMock,
  eventDispatchModeMock
} = vi.hoisted(() => ({
  insertValuesMock: vi.fn(),
  insertOnConflictMock: vi.fn(),
  updateSetMock: vi.fn(),
  updateWhereMock: vi.fn(),
  updateReturningMock: vi.fn(),
  selectLimitMock: vi.fn(),
  addBulkMock: vi.fn(),
  getJobCountsMock: vi.fn(),
  workerCloseMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  getSubscriberByIdMock: vi.fn(),
  eventDispatchModeMock: vi.fn()
}));

vi.mock('bullmq', () => ({
  Worker: class {
    close = workerCloseMock;
    on = vi.fn();
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
    }))
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn()
}));

vi.mock('../config/env', () => ({
  eventDispatchMode: eventDispatchModeMock
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({}))
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
  }))
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: attachWorkerObservabilityMock
}));

import {
  buildReceiptClaimCas,
  createEventDispatchWorker,
  eventDispatchProcessor,
  initializeEventDispatchWorker,
  processDeliverEvent,
  processRouteEvent,
  shutdownEventDispatchWorker
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
  it('unknown subscriberId: terminal — logs, captures, does not touch the receipt', async () => {
    getSubscriberByIdMock.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const data: DeliverEventJobData = { v: 1, subscriberId: 'webhook-delivery', event: makeEvent() };
    await expect(processDeliverEvent(data)).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock).not.toHaveBeenCalled();
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

    await expect(
      processDeliverEvent({ v: 1, subscriberId: 'webhook-delivery', event: makeEvent() })
    ).rejects.toBe(boom);

    // Two update calls: the claim, then the failed-outcome write.
    expect(updateSetMock).toHaveBeenCalledTimes(2);
    const failedSet = updateSetMock.mock.calls[1]![0] as { status: string; lastError: string };
    expect(failedSet.status).toBe('failed');
    expect(failedSet.lastError).toHaveLength(500);
  });

  it('handler succeeds: CAS delivering -> delivered', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    getSubscriberByIdMock.mockReturnValue({ id: 'webhook-delivery', eventTypes: '*', handler });
    updateReturningMock.mockResolvedValue([{ eventId: 'event-1' }]);

    await processDeliverEvent({ v: 1, subscriberId: 'webhook-delivery', event: makeEvent() });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledTimes(2);
    const deliveredSet = updateSetMock.mock.calls[1]![0] as { status: string };
    expect(deliveredSet.status).toBe('delivered');
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
    errorSpy.mockRestore();
  });

  it('dispatches a valid route-event job to processRouteEvent', async () => {
    const event = makeEvent();
    const job = {
      id: 'job-3',
      name: 'route-event',
      data: { v: 1, mode: 'shadow', event, matchedSubscriberIds: [], queueSubscriberIds: [] }
    } as never;

    await eventDispatchProcessor(job);

    expect(insertValuesMock).not.toHaveBeenCalled(); // empty queueSubscriberIds no-op
  });
});

describe('initializeEventDispatchWorker / shutdownEventDispatchWorker', () => {
  it('mode off, empty queue: no-op, worker not created', async () => {
    eventDispatchModeMock.mockReturnValue('off');
    getJobCountsMock.mockResolvedValue({ waiting: 0, delayed: 0, active: 0, paused: 0 });

    await initializeEventDispatchWorker();

    expect(attachWorkerObservabilityMock).not.toHaveBeenCalled();
  });

  it('mode off, queue has a backlog: starts the worker anyway to drain it', async () => {
    eventDispatchModeMock.mockReturnValue('off');
    getJobCountsMock.mockResolvedValue({ waiting: 2, delayed: 0, active: 0, paused: 0 });

    await initializeEventDispatchWorker();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledTimes(1);
    await shutdownEventDispatchWorker();
    expect(workerCloseMock).toHaveBeenCalledTimes(1);
  });

  it('mode shadow/enforce: always starts the worker', async () => {
    eventDispatchModeMock.mockReturnValue('enforce');

    await initializeEventDispatchWorker();

    expect(getJobCountsMock).not.toHaveBeenCalled();
    expect(attachWorkerObservabilityMock).toHaveBeenCalledTimes(1);
    await shutdownEventDispatchWorker();
  });

  it('createEventDispatchWorker returns a Worker instance', () => {
    const w = createEventDispatchWorker();
    expect(w).toBeDefined();
  });

  it('shutdown is a no-op when no worker was ever started', async () => {
    await expect(shutdownEventDispatchWorker()).resolves.toBeUndefined();
  });
});
