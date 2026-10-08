/**
 * #8229 — the pool wait and the RLS prologue are two different clocks.
 *
 * Before this fix the #6048 prologue timer was armed around
 * `baseDb.transaction(...)`, so time spent queueing for a pooled connection was
 * charged against the prologue budget. Under pool saturation every request that
 * waited longer than the budget surfaced as `DbAccessContextPrologueTimeoutError`
 * and kicked off a wedged-backend reclaim pass that found nothing.
 *
 * `work` in these tests models `baseDb.transaction(cb)` with a fake pool: the
 * transaction callback runs only when the test delivers a connection, which is
 * the only way to hold a request in the pool queue for a controlled time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DbAccessContextPrologueTimeoutError,
  DbPoolAcquireAbortedError,
  DbPoolAcquireTimeoutError,
  getDbAccessContextPrologueTimeoutMs,
  getDbPoolAcquireTimeoutMs,
  withAcquireAndPrologueDeadline,
  type PoolAcquisition,
  type PrologueDeadline,
} from './prologueDeadline';

/** A promise that never settles — the wedged `set_config`. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * A fake pool. `transaction(cb)` queues until `deliverConnection()`; then it
 * runs `cb` with the same contract as postgres.js `begin`: a callback that
 * throws makes the driver roll back, RELEASE the connection, and reject.
 */
function fakePool() {
  let deliver: (() => void) | null = null;
  const callbackOutcome: { settled: 'resolved' | 'rejected' | null; error: unknown } = {
    settled: null,
    error: undefined,
  };
  function transaction<T>(cb: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      deliver = () => {
        let pending: Promise<T>;
        try {
          pending = cb();
        } catch (err) {
          pending = Promise.reject(err);
        }
        pending.then(
          (value) => {
            callbackOutcome.settled = 'resolved';
            resolve(value);
          },
          (err: unknown) => {
            callbackOutcome.settled = 'rejected';
            callbackOutcome.error = err;
            reject(err);
          },
        );
      };
    });
  }
  return { transaction, deliverConnection: () => deliver!(), callbackOutcome };
}

describe('getDbPoolAcquireTimeoutMs', () => {
  const original = process.env.DB_POOL_ACQUIRE_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.DB_POOL_ACQUIRE_TIMEOUT_MS;
    else process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = original;
  });

  it('defaults to 15s', () => {
    delete process.env.DB_POOL_ACQUIRE_TIMEOUT_MS;
    expect(getDbPoolAcquireTimeoutMs()).toBe(15_000);
  });

  it('honours an explicit 0 as "disabled"', () => {
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '0';
    expect(getDbPoolAcquireTimeoutMs()).toBe(0);
  });

  it('clamps a sub-second budget up to the 1s floor rather than honouring it', () => {
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '50';
    expect(getDbPoolAcquireTimeoutMs()).toBe(1_000);
  });

  it('falls back to the default on garbage or a negative value', () => {
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = 'soon';
    expect(getDbPoolAcquireTimeoutMs()).toBe(15_000);
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '-5';
    expect(getDbPoolAcquireTimeoutMs()).toBe(15_000);
  });

  it('is read from its own knob, independent of the prologue knob', () => {
    const originalPrologue = process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS;
    try {
      process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '30000';
      process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '5000';
      expect(getDbPoolAcquireTimeoutMs()).toBe(30_000);
      expect(getDbAccessContextPrologueTimeoutMs()).toBe(5_000);
    } finally {
      if (originalPrologue === undefined) delete process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS;
      else process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = originalPrologue;
    }
  });
});

describe('withAcquireAndPrologueDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does NOT charge the pool wait to the prologue budget', async () => {
    // The production misreport: 10s queued for a slot plus a 10s prologue is
    // 20s total, which the old single clock reported as a wedged prologue.
    const pool = fakePool();
    const onExpired = vi.fn();
    const result = withAcquireAndPrologueDeadline(
      'withDbAccessContext(scope=system)',
      (acquisition) =>
        pool.transaction(async () => {
          const deadline = acquisition.acquired();
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          deadline.throwIfAborted();
          deadline.disarm();
          return 'rows';
        }),
      { acquireTimeoutMs: 15_000, timeoutMs: 15_000, onExpired },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    pool.deliverConnection();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe('rows');
    expect(onExpired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the prologue clock at acquisition, not at call time', async () => {
    const pool = fakePool();
    let captured: unknown = null;
    const result = withAcquireAndPrologueDeadline(
      'withDbAccessContext(scope=system)',
      (acquisition) =>
        pool.transaction(async () => {
          acquisition.acquired();
          return neverSettles<string>();
        }),
      { acquireTimeoutMs: 15_000, timeoutMs: 15_000 },
    ).catch((err: unknown) => {
      captured = err;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    pool.deliverConnection();
    // 15s after CALL time is only 5s after acquisition — not expired yet.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(captured).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(captured).toBeInstanceOf(DbAccessContextPrologueTimeoutError);
    // Measured from acquisition, so it reports the prologue alone.
    expect((captured as DbAccessContextPrologueTimeoutError).elapsedMs).toBe(15_000);
  });

  it('rejects with the typed acquire error when the pool never hands over a connection', async () => {
    const pool = fakePool();
    let captured: unknown = null;
    const result = withAcquireAndPrologueDeadline(
      'withDbAccessContext(scope=system)',
      (acquisition) =>
        pool.transaction(async () => {
          acquisition.acquired();
          return 'rows';
        }),
      { acquireTimeoutMs: 12_000, timeoutMs: 15_000 },
    ).catch((err: unknown) => {
      captured = err;
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await result;

    expect(captured).toBeInstanceOf(DbPoolAcquireTimeoutError);
    expect(captured).not.toBeInstanceOf(DbAccessContextPrologueTimeoutError);
    const err = captured as DbPoolAcquireTimeoutError;
    expect(err.name).toBe('DbPoolAcquireTimeoutError');
    expect(err.timeoutMs).toBe(12_000);
    expect(err.elapsedMs).toBe(12_000);
    expect(err.contextLabel).toBe('withDbAccessContext(scope=system)');
    // Must point at saturation, not at a wedged prologue.
    expect(err.message).toContain('#8229');
    expect(err.message).not.toContain('reclamation pass was requested');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does NOT request a reclamation pass on an acquire timeout', async () => {
    // Nothing is wedged: every backend is busy with real work. A reclaim pass
    // would scan, find nothing, and tell the operator the wrong story.
    const pool = fakePool();
    const onExpired = vi.fn();
    const result = withAcquireAndPrologueDeadline(
      'withDbAccessContext(scope=system)',
      (acquisition) =>
        pool.transaction(async () => {
          acquisition.acquired();
          return 'rows';
        }),
      { acquireTimeoutMs: 15_000, timeoutMs: 15_000, onExpired },
    ).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('refuses — and so releases — a connection that arrives AFTER the acquire budget expired', async () => {
    // `Promise.race` does not cancel the queued acquire. When the pool finally
    // hands the connection over, the callback must throw so the driver rolls
    // back and returns the connection to the pool. Running the work would
    // execute a request nobody is waiting for on a slot the pool needs back.
    const pool = fakePool();
    const work = vi.fn(async () => 'rows');
    const result = withAcquireAndPrologueDeadline(
      'withDbAccessContext(scope=system)',
      (acquisition) =>
        pool.transaction(async () => {
          acquisition.acquired();
          return work();
        }),
      { acquireTimeoutMs: 15_000, timeoutMs: 15_000 },
    );
    const assertion = expect(result).rejects.toBeInstanceOf(DbPoolAcquireTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    pool.deliverConnection();
    await vi.advanceTimersByTimeAsync(0);

    expect(work).not.toHaveBeenCalled();
    expect(pool.callbackOutcome.settled).toBe('rejected');
    expect(pool.callbackOutcome.error).toBeInstanceOf(DbPoolAcquireAbortedError);
    // No prologue clock was started for the refused connection.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not surface an unhandled rejection when the refused late connection rejects', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const pool = fakePool();
      const result = withAcquireAndPrologueDeadline(
        'withDbAccessContext(scope=system)',
        (acquisition) =>
          pool.transaction(async () => {
            acquisition.acquired();
            return 'rows';
          }),
        { acquireTimeoutMs: 1_000, timeoutMs: 1_000 },
      ).catch(() => 'timed-out');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toBe('timed-out');

      pool.deliverConnection();
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('leaves the pool wait unbounded when the acquire budget is disabled, but still bounds the prologue', async () => {
    const pool = fakePool();
    const onExpired = vi.fn();
    let captured: unknown = null;
    const result = withAcquireAndPrologueDeadline(
      'withDbAccessContext(scope=system)',
      (acquisition) =>
        pool.transaction(async () => {
          acquisition.acquired();
          return neverSettles<string>();
        }),
      { acquireTimeoutMs: 0, timeoutMs: 15_000, onExpired },
    ).catch((err: unknown) => {
      captured = err;
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(captured).toBeNull();

    pool.deliverConnection();
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(captured).toBeInstanceOf(DbAccessContextPrologueTimeoutError);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('still bounds the pool wait when only the prologue budget is disabled', async () => {
    const pool = fakePool();
    const result = withAcquireAndPrologueDeadline(
      'withDbAccessContext(scope=system)',
      (acquisition) =>
        pool.transaction(async () => {
          acquisition.acquired();
          return 'rows';
        }),
      { acquireTimeoutMs: 15_000, timeoutMs: 0 },
    );
    const assertion = expect(result).rejects.toBeInstanceOf(DbPoolAcquireTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('is a pass-through, with no timers, when both budgets are disabled', async () => {
    const seen: PrologueDeadline[] = [];
    const result = await withAcquireAndPrologueDeadline(
      'withDbAccessContext(scope=system)',
      async (acquisition: PoolAcquisition) => {
        seen.push(acquisition.acquired());
        return 7;
      },
      { acquireTimeoutMs: 0, timeoutMs: 0 },
    );
    expect(result).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
    expect(seen[0]!.aborted).toBe(false);
  });
});
