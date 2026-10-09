// apps/api/src/db/poolAdmissionWiring.test.ts
/**
 * #8143 — the admission gate at the REAL context openers, on top of #8229's
 * acquire/prologue budgets. drizzle is faked (as in prologueDeadlineWiring.test.ts)
 * so a transaction can be made to hang, or to settle late, on demand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { drizzleFactory, transactionImpl } = vi.hoisted(() => {
  const transactionImpl = vi.fn();
  const drizzleFactory = vi.fn(() => ({
    transaction: (fn: (tx: unknown) => Promise<unknown>) => transactionImpl(fn),
  }));
  return { drizzleFactory, transactionImpl };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), {
    options: { parsers: {}, serializers: {} },
    end: vi.fn(() => Promise.resolve()),
  })),
}));
vi.mock('./wedgedBackends', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wedgedBackends')>()),
  requestWedgedBackendReclaim: vi.fn(() => null),
}));

const originalEnv = { ...process.env };

/** Emulates postgres.js: the callback's rejection is the transaction's rejection. */
function runCallback(tx: unknown) {
  return (fn: (t: unknown) => Promise<unknown>) => fn(tx);
}

const okTx = () => ({ execute: vi.fn(() => Promise.resolve([])) });

describe('#8143 pool admission wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '15000';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('a request that times out waiting for a permit never reaches the driver', async () => {
    process.env.DB_POOL_MAX = '1';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '1000';
    let finishHolder!: () => void;
    const holderCommit = new Promise<void>((resolve) => { finishHolder = resolve; });
    transactionImpl.mockImplementationOnce(async (fn: (t: unknown) => Promise<unknown>) => {
      const value = await fn(okTx());
      await holderCommit; // COMMIT in flight: the holder keeps its permit
      return value;
    });
    const db = await import('./index');

    const holder = db.withSystemDbAccessContext(async () => 'held');
    const waiter = db.withSystemDbAccessContext(async () => 'never');
    const assertion = expect(waiter).rejects.toBeInstanceOf(db.DbPoolAcquireTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(transactionImpl).toHaveBeenCalledTimes(1);
    expect(db.getRequestPoolAdmission()!.totals().cancelledWaiters).toBe(1);
    finishHolder();
    await expect(holder).resolves.toBe('held');
    expect(db.getRequestPoolAdmission()!.snapshot()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('holds an abandoned permit until the late prologue settles, then hands it on', async () => {
    process.env.DB_POOL_MAX = '1';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '10000';
    const lateTx = { execute: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 20_000))) };
    transactionImpl.mockImplementationOnce(runCallback(lateTx));
    transactionImpl.mockImplementationOnce(runCallback(okTx()));
    const db = await import('./index');
    const fn = vi.fn(async () => 'rows');

    const first = db.withSystemDbAccessContext(fn);
    const firstAssertion = expect(first).rejects.toBeInstanceOf(db.DbAccessContextPrologueTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await firstAssertion;
    expect(db.getRequestPoolAdmission()!.snapshot()).toMatchObject({ inUse: 1, abandoned: 1, effectivePermits: 0 });

    const second = db.withSystemDbAccessContext(async () => 'second');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(second).resolves.toBe('second');
    expect(fn).not.toHaveBeenCalled();
    expect(db.getRequestPoolAdmission()!.totals().abandonedReturned.rollback).toBe(1);
  });

  it('never commits an abandoned transaction, even when caller code swallows the inner timeout', async () => {
    process.env.DB_POOL_MAX = '4';
    let statements = 0;
    const tx = {
      // Statement 1: outer system prologue. Statement 2: the narrowing prologue, which wedges.
      execute: vi.fn(() => (++statements === 2 ? new Promise(() => {}) : Promise.resolve([]))),
    };
    let transactionOutcome: 'committed' | 'rolled-back' | null = null;
    transactionImpl.mockImplementationOnce(async (fn: (t: unknown) => Promise<unknown>) => {
      try {
        const value = await fn(tx);
        transactionOutcome = 'committed';
        return value;
      } catch (err) {
        transactionOutcome = 'rolled-back';
        throw err;
      }
    });
    const db = await import('./index');

    const caller = db.withSystemDbAccessContext(async () => {
      try {
        await db.withResolvedDbAccessContext(
          async () => ({ context: { ...db.SYSTEM_DB_ACCESS_CONTEXT, scope: 'organization', orgId: null, accessibleOrgIds: [] }, value: 1 }),
          async () => 'inner',
        );
      } catch {
        // swallowed on purpose: the hazard under test
      }
      return 'swallowed';
    });
    const assertion = expect(caller).rejects.toBeInstanceOf(db.DbAccessContextPrologueTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    await vi.advanceTimersByTimeAsync(1);
    expect(transactionOutcome).toBe('rolled-back');
  });

  it('starts deferred after-exit work only after an abandoned transaction has actually settled', async () => {
    process.env.DB_POOL_MAX = '4';
    let finishRollback!: () => void;
    const rollbackDone = new Promise<void>((resolve) => { finishRollback = resolve; });
    let statements = 0;
    const tx = {
      execute: vi.fn(() => (++statements === 2 ? new Promise(() => {}) : Promise.resolve([]))),
    };
    transactionImpl.mockImplementationOnce(async (fn: (t: unknown) => Promise<unknown>) => {
      try {
        return await fn(tx);
      } catch (err) {
        await rollbackDone; // ROLLBACK still in flight after the caller was released
        throw err;
      }
    });
    const db = await import('./index');
    const task = vi.fn();
    const caller = db.withSystemDbAccessContext(async () => {
      db.runAfterDbContextExit('wiring.after', task);
      await db.withResolvedDbAccessContext(
        async () => ({ context: { ...db.SYSTEM_DB_ACCESS_CONTEXT, scope: 'organization', orgId: null, accessibleOrgIds: [] }, value: 1 }),
        async () => 'inner',
      );
      return 'unreachable';
    });
    const assertion = expect(caller).rejects.toBeInstanceOf(db.DbAccessContextPrologueTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    // The caller is released, but the transaction has not settled: not yet.
    expect(task).not.toHaveBeenCalled();
    finishRollback();
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('a nested escalation is admitted from the reserve while two parents hold the top-level permits', async () => {
    process.env.DB_POOL_MAX = '3';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '1000';
    transactionImpl.mockImplementation(runCallback(okTx()));
    const db = await import('./index');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const parentA = db.withSystemDbAccessContext(async () => {
      await gate;
      return 'a';
    });
    const parentB = db.withSystemDbAccessContext(() =>
      db.runOutsideDbContext(() => db.withSystemDbAccessContext(async () => 'nested')),
    );
    // Treated as top-level, the nested open would sit behind the cap
    // (permits - reserve = 2) and fail with DbPoolAcquireTimeoutError.
    const outcome = parentB.then((value) => value, (err: unknown) => (err as Error).name);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBe('nested');
    release();
    await expect(parentA).resolves.toBe('a');
  });
  it('releases a permit whose connection arrives after the acquire budget expired', async () => {
    // The gate granted the permit inside the budget, but the driver handed the
    // connection over late: acquisition.acquired() refuses it with
    // DbPoolAcquireAbortedError. The permit must come back, or it leaks forever.
    process.env.DB_POOL_MAX = '1';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '15000';
    let callbackRejection: unknown;
    transactionImpl.mockImplementationOnce(
      (fn: (t: unknown) => Promise<unknown>) =>
        new Promise((resolve, reject) => {
          setTimeout(() => {
            Promise.resolve()
              .then(() => fn(okTx()))
              .then(resolve, (err: unknown) => {
                callbackRejection = err;
                reject(err);
              });
          }, 20_000);
        }),
    );
    transactionImpl.mockImplementationOnce(runCallback(okTx()));
    const db = await import('./index');

    const late = db.withSystemDbAccessContext(async () => 'never');
    const assertion = expect(late).rejects.toBeInstanceOf(db.DbPoolAcquireTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    // Still held: the driver has not handed the connection over yet.
    expect(db.getRequestPoolAdmission()!.snapshot()).toMatchObject({ inUse: 1 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbackRejection).toBeInstanceOf(db.DbPoolAcquireAbortedError);
    expect(db.getRequestPoolAdmission()!.snapshot()).toMatchObject({ inUse: 0, waiting: 0, abandoned: 0 });
    await expect(db.withSystemDbAccessContext(async () => 'next')).resolves.toBe('next');
  });

  it('a transaction rejection reaches the caller only: no derived promise rejects unhandled', async () => {
    process.env.DB_POOL_MAX = '3';
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      transactionImpl.mockImplementation(runCallback(okTx()));
      const db = await import('./index');
      const boom = new Error('device organization mismatch');
      // Top-level, and a nested escalation from inside a held context (the
      // runOutsideDbContext(() => withSystemDbAccessContext(...)) shape).
      await expect(db.withSystemDbAccessContext(async () => { throw boom; })).rejects.toBe(boom);
      await expect(db.withSystemDbAccessContext(async () =>
        db.runOutsideDbContext(() => db.withSystemDbAccessContext(async () => { throw boom; })),
      )).rejects.toBe(boom);
      // Let Node's unhandled-rejection pass run (it follows the microtask drain).
      await new Promise((resolve) => process.nextTick(resolve));
      await vi.advanceTimersByTimeAsync(10);
      expect(unhandled).toEqual([]);
      expect(db.getRequestPoolAdmission()!.snapshot()).toMatchObject({ inUse: 0, abandoned: 0 });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('warns once at startup when the request pool is too small for a nested reserve', async () => {
    process.env.DB_POOL_MAX = '2';
    await import('./index');
    const lines = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('no nested-escalation reserve'))).toHaveLength(1);
  });

  it('does not warn about the nested reserve at the default pool size', async () => {
    delete process.env.DB_POOL_MAX;
    await import('./index');
    const lines = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('no nested-escalation reserve'))).toHaveLength(0);
  });

  it('closeDb stops the abandoned-slot reclaim scheduler, and is idempotent', async () => {
    process.env.DB_POOL_MAX = '1';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '10000';
    // A prologue that never settles: the permit stays abandoned and tracked.
    const wedgedTx = { execute: vi.fn(() => new Promise(() => {})) };
    transactionImpl.mockImplementationOnce(runCallback(wedgedTx));
    const db = await import('./index');
    const { requestWedgedBackendReclaim } = await import('./wedgedBackends');

    const first = db.withSystemDbAccessContext(async () => 'never');
    const assertion = expect(first).rejects.toBeInstanceOf(db.DbAccessContextPrologueTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(db.getRequestPoolAdmission()!.snapshot()).toMatchObject({ abandoned: 1 });

    await db.closeDb();
    await db.closeDb();
    // Well past eligibility (prologue budget + margin): nothing may fire.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requestWedgedBackendReclaim).not.toHaveBeenCalled();
  });
});
