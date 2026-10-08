// apps/api/src/db/poolAdmission.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPoolSlotSettlement,
  createPoolAdmission,
  DbPoolAdmissionCancelledError,
  getRequestPoolAdmission,
  nestedReserveFor,
  registerRequestPoolAdmission,
  __resetRequestPoolAdmissionForTests,
  type PoolSlot,
} from './poolAdmission';
import { DbAccessContextPrologueAbortedError } from './prologueDeadline';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('nestedReserveFor', () => {
  it('reserves one permit for nested escalations only when the pool can spare it', () => {
    expect(nestedReserveFor(1)).toBe(0);
    expect(nestedReserveFor(2)).toBe(0);
    expect(nestedReserveFor(3)).toBe(1);
    expect(nestedReserveFor(30)).toBe(1);
  });
});

describe('classifyPoolSlotSettlement', () => {
  it('recognises driver connection loss and server-side termination', () => {
    expect(classifyPoolSlotSettlement(Object.assign(new Error('x'), { code: 'CONNECTION_CLOSED' }))).toBe('connection-closed');
    expect(classifyPoolSlotSettlement(Object.assign(new Error('x'), { code: 'CONNECTION_DESTROYED' }))).toBe('connection-closed');
    // pg_terminate_backend: the FATAL can reach the transaction before the socket close does.
    expect(classifyPoolSlotSettlement(Object.assign(new Error('terminating connection'), { code: '57P01' }))).toBe('connection-closed');
    expect(classifyPoolSlotSettlement(Object.assign(new Error('unique'), { code: '23505' }))).toBe('rejected');
    expect(classifyPoolSlotSettlement(new Error('boom'))).toBe('rejected');
    expect(classifyPoolSlotSettlement(undefined)).toBe('rejected');
  });
});

describe('createPoolAdmission', () => {
  it('grants immediately below the top-level cap and counts in-use', async () => {
    const gate = createPoolAdmission({ permits: 3 });
    const a = await gate.acquire('t');
    const b = await gate.acquire('t');
    expect(gate.snapshot()).toEqual({ permits: 3, nestedReserve: 1, inUse: 2, waiting: 0, abandoned: 0, effectivePermits: 3 });
    a.release('resolved');
    b.release('resolved');
    expect(gate.snapshot().inUse).toBe(0);
  });

  it('keeps top-level acquirers out of the nested reserve', async () => {
    const gate = createPoolAdmission({ permits: 3 });
    await gate.acquire('t');
    await gate.acquire('t');
    let third: PoolSlot | null = null;
    void gate.acquire('t').then((slot) => { third = slot; });
    await flush();
    expect(third).toBeNull();
    expect(gate.snapshot().waiting).toBe(1);
  });

  it('nested acquirers use the reserve and are served before top-level waiters', async () => {
    const gate = createPoolAdmission({ permits: 3 });
    const parentA = await gate.acquire('parent');
    await gate.acquire('parent');
    const order: string[] = [];
    void gate.acquire('top').then((slot) => { order.push('top'); return slot; });
    const nested = await gate.acquire('nested', { nested: true });
    order.push('nested');
    expect(nested.nested).toBe(true);
    expect(gate.snapshot().inUse).toBe(3);
    nested.release('resolved');
    await flush();
    // The freed permit is the reserve: the top-level waiter still cannot take it.
    expect(order).toEqual(['nested']);
    parentA.release('resolved');
    await flush();
    expect(order).toEqual(['nested', 'top']);
  });

  it('a waiter whose signal aborts leaves the queue and is never granted', async () => {
    const gate = createPoolAdmission({ permits: 1 });
    const holder = await gate.acquire('holder');
    const controller = new AbortController();
    const waiting = gate.acquire('waiter', { signal: controller.signal });
    const assertion = expect(waiting).rejects.toBeInstanceOf(DbPoolAdmissionCancelledError);
    controller.abort();
    await assertion;
    expect(gate.snapshot()).toMatchObject({ inUse: 1, waiting: 0 });
    expect(gate.totals().cancelledWaiters).toBe(1);
    holder.release('resolved');
    expect(gate.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('an already-aborted signal is refused without queueing', async () => {
    const gate = createPoolAdmission({ permits: 1 });
    await gate.acquire('holder');
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire('late', { signal: controller.signal })).rejects.toBeInstanceOf(DbPoolAdmissionCancelledError);
    expect(gate.snapshot().waiting).toBe(0);
  });

  it('a granted waiter stops listening, so a later abort cannot cancel its permit', async () => {
    const gate = createPoolAdmission({ permits: 1 });
    const holder = await gate.acquire('holder');
    const controller = new AbortController();
    const waiting = gate.acquire('waiter', { signal: controller.signal });
    holder.release('resolved');
    const slot = await waiting;
    controller.abort();
    await flush();
    expect(slot.released).toBe(false);
    expect(gate.snapshot()).toMatchObject({ inUse: 1, waiting: 0 });
    expect(gate.totals().cancelledWaiters).toBe(0);
  });

  it('removes its abort listener on admission so a shared long-lived signal does not accumulate listeners', async () => {
    const gate = createPoolAdmission({ permits: 1 });
    const holder = await gate.acquire('holder');
    const shared = new AbortController();
    const add = vi.spyOn(shared.signal, 'addEventListener');
    const remove = vi.spyOn(shared.signal, 'removeEventListener');
    const waiting = gate.acquire('waiter', { signal: shared.signal });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    holder.release('resolved');
    await waiting;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
  });

  it('does not touch the signal on the immediate-grant fast path', async () => {
    const gate = createPoolAdmission({ permits: 2 });
    const shared = new AbortController();
    const add = vi.spyOn(shared.signal, 'addEventListener');
    await gate.acquire('t', { signal: shared.signal });
    expect(add).not.toHaveBeenCalled();
  });

  it('an abandoned permit is never re-admitted until its transaction settles', async () => {
    const gate = createPoolAdmission({ permits: 1 });
    const slot = await gate.acquire('t');
    const abandonment = expect(slot.abandonment).rejects.toThrow('prologue expired');
    slot.abandon(new Error('prologue expired'));
    await abandonment;
    expect(gate.snapshot()).toMatchObject({ inUse: 1, abandoned: 1, effectivePermits: 0 });
    let next: PoolSlot | null = null;
    void gate.acquire('t').then((granted) => { next = granted; });
    await flush();
    expect(next).toBeNull();
    slot.release('connection-closed');
    await flush();
    expect(next).not.toBeNull();
    expect(gate.snapshot()).toMatchObject({ inUse: 1, abandoned: 0, effectivePermits: 1 });
    expect(gate.totals()).toMatchObject({ abandoned: 1, abandonedReturned: { rollback: 0, 'connection-closed': 1 } });
  });

  it('abandon and release are idempotent', async () => {
    const gate = createPoolAdmission({ permits: 2 });
    const slot = await gate.acquire('t');
    slot.abandon(new Error('a'));
    slot.abandon(new Error('b'));
    slot.release('rejected');
    slot.release('rejected');
    slot.abandon(new Error('after release'));
    expect(gate.snapshot()).toMatchObject({ inUse: 0, abandoned: 0 });
    expect(gate.totals()).toMatchObject({ abandoned: 1, abandonedReturned: { rollback: 1, 'connection-closed': 0 } });
  });

  it('throwIfAbandoned throws the aborted error only once abandoned', async () => {
    const gate = createPoolAdmission({ permits: 2 });
    const slot = await gate.acquire('withDbAccessContext(scope=system)');
    expect(() => slot.throwIfAbandoned()).not.toThrow();
    slot.abandon(new Error('expired'));
    expect(() => slot.throwIfAbandoned()).toThrow(DbAccessContextPrologueAbortedError);
  });

  it('an un-awaited abandonment never becomes an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const gate = createPoolAdmission({ permits: 2 });
      const slot = await gate.acquire('t');
      slot.abandon(new Error('nobody is racing this'));
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('request pool admission registry', () => {
  afterEach(() => {
    __resetRequestPoolAdmissionForTests();
  });

  it('is null until the db module registers its gate', () => {
    expect(getRequestPoolAdmission()).toBeNull();
    const gate = createPoolAdmission({ permits: 4 });
    registerRequestPoolAdmission(gate);
    expect(getRequestPoolAdmission()).toBe(gate);
  });
});
