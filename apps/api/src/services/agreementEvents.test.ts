import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addMock, QueueCtor } = vi.hoisted(() => {
  const addMock = vi.fn();
  return { addMock, QueueCtor: vi.fn(function QueueMock() { return { add: addMock }; }) };
});
vi.mock('bullmq', () => ({ Queue: QueueCtor }));
vi.mock('./redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
const { partnerRows } = vi.hoisted(() => ({ partnerRows: [] as Array<unknown[] | Error> }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    const next = partnerRows.shift() ?? [];
    return (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)).then(resolve, reject);
  };
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { AGREEMENT_EVENTS_QUEUE, AGREEMENT_EVENT_TYPES, emitAgreementEvent, emitAgreementEventForOrg } from './agreementEvents';
import { captureException } from './sentry';

beforeEach(() => {
  vi.clearAllMocks();
  addMock.mockResolvedValue(undefined);
  partnerRows.length = 0;
});

describe('emitAgreementEvent', () => {
  it('publishes the six lifecycle types on the agreement-events queue', () => {
    expect(AGREEMENT_EVENTS_QUEUE).toBe('agreement-events');
    expect([...AGREEMENT_EVENT_TYPES]).toEqual([
      'agreement.sent', 'agreement.viewed', 'agreement.signed',
      'agreement.declined', 'agreement.voided', 'agreement.expired',
    ]);
  });

  it('enqueues the event under its own type name, with retention + retry', async () => {
    const event = { type: 'agreement.signed', requestId: 'r1', orgId: 'o1', partnerId: 'p1', origin: 'customer' } as const;
    await emitAgreementEvent(event);
    expect(addMock).toHaveBeenCalledTimes(1);
    const [name, data, opts] = addMock.mock.calls[0]!;
    expect(name).toBe('agreement.signed');
    expect(data).toEqual(event);
    expect(opts).toMatchObject({ attempts: 3, removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } });
  });

  it('never rejects: a Redis outage is logged + captured, not thrown at the caller', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    addMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(emitAgreementEvent({ type: 'agreement.sent', requestId: 'r1', orgId: 'o1', partnerId: 'p1' })).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('emitAgreementEvent outage behaviour', () => {
  it('a Redis outage that never answers is abandoned after the bound, not awaited forever', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      addMock.mockReturnValueOnce(new Promise(() => {})); // enqueue that never settles
      const p = emitAgreementEvent({ type: 'agreement.viewed', requestId: 'r1', orgId: 'o1', partnerId: 'p1' });
      await vi.advanceTimersByTimeAsync(2500);
      await expect(p).resolves.toBeUndefined();
      expect(captureException).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      err.mockRestore();
    }
  });
});

describe('emitAgreementEventForOrg', () => {
  it('resolves the owning partner under system scope, then enqueues', async () => {
    partnerRows.push([{ partnerId: 'p9' }]);
    await emitAgreementEventForOrg({ type: 'agreement.voided', requestId: 'r1', orgId: 'o1', actorUserId: 'u1' });
    expect(addMock).toHaveBeenCalledWith(
      'agreement.voided',
      { type: 'agreement.voided', requestId: 'r1', orgId: 'o1', partnerId: 'p9', actorUserId: 'u1' },
      expect.any(Object),
    );
  });

  it('an unknown org emits nothing and never throws', async () => {
    partnerRows.push([]);
    await expect(emitAgreementEventForOrg({ type: 'agreement.sent', requestId: 'r1', orgId: 'gone' })).resolves.toBeUndefined();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('a lookup failure is captured and swallowed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    partnerRows.push(new Error('db down'));
    await expect(emitAgreementEventForOrg({ type: 'agreement.sent', requestId: 'r1', orgId: 'o1' })).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalled();
    err.mockRestore();
  });
});
