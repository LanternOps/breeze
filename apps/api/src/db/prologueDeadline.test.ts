/**
 * #6048 — the RLS GUC prologue must be bounded on the CLIENT clock.
 *
 * Every test here models the production shape: a "connection" whose first
 * `set_config` promise NEVER settles. That is the whole failure — the backend
 * finished the statement and is sitting in `ClientRead` waiting for a protocol
 * message we never send, so nothing on the server or in the driver will ever
 * resolve it. A test that used a slow-but-resolving promise would pass against
 * code that has no deadline at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DbAccessContextPrologueAbortedError,
  DbAccessContextPrologueTimeoutError,
  getDbAccessContextPrologueTimeoutMs,
  withPrologueDeadline,
  type PrologueDeadline,
} from './prologueDeadline';

/** A promise that never settles — the wedged `set_config`. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('getDbAccessContextPrologueTimeoutMs', () => {
  const original = process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS;
    else process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = original;
  });

  it('defaults to 15s', () => {
    delete process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS;
    expect(getDbAccessContextPrologueTimeoutMs()).toBe(15_000);
  });

  it('honours an explicit 0 as "disabled"', () => {
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '0';
    expect(getDbAccessContextPrologueTimeoutMs()).toBe(0);
  });

  it('clamps a sub-second budget up to the 1s floor rather than honouring it', () => {
    // A 50ms budget would turn ordinary cross-AZ latency into a fault and make
    // the reclaimer fire constantly against healthy connections.
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '50';
    expect(getDbAccessContextPrologueTimeoutMs()).toBe(1_000);
  });

  it('falls back to the default on garbage', () => {
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = 'soon';
    expect(getDbAccessContextPrologueTimeoutMs()).toBe(15_000);
  });
});

describe('withPrologueDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects with the typed timeout error when the prologue never settles', async () => {
    const result = withPrologueDeadline('withDbAccessContext(scope=system)', () => neverSettles(), {
      timeoutMs: 15_000,
    });
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('carries the elapsed time and the budget on the error', async () => {
    let captured: DbAccessContextPrologueTimeoutError | null = null;
    const result = withPrologueDeadline('withDbAccessContext(scope=system)', () => neverSettles(), {
      timeoutMs: 12_000,
    }).catch((err: unknown) => {
      captured = err as DbAccessContextPrologueTimeoutError;
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await result;

    expect(captured).toBeInstanceOf(DbAccessContextPrologueTimeoutError);
    expect(captured!.timeoutMs).toBe(12_000);
    expect(captured!.elapsedMs).toBeGreaterThanOrEqual(12_000);
    expect(captured!.contextLabel).toBe('withDbAccessContext(scope=system)');
    // The message must name the reclamation, not read as a database fault: an
    // operator seeing only "connection closed" would chase the wrong incident.
    expect(captured!.message).toContain('#6048');
  });

  it('asks for a reclamation pass at expiry, BEFORE the caller is rejected', async () => {
    const order: string[] = [];
    const result = withPrologueDeadline('withDbAccessContext(scope=system)', () => neverSettles(), {
      timeoutMs: 15_000,
      onExpired: (expiry) => {
        order.push(`expired:${expiry.timeoutMs}`);
      },
    }).catch(() => {
      order.push('rejected');
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await result;

    // Ordering is the point: recovery is kicked off synchronously and NOT
    // awaited, so caller latency stays bounded by the deadline itself.
    expect(order).toEqual(['expired:15000', 'rejected']);
  });

  it('never leaves the caller hanging when the expiry handler itself throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = withPrologueDeadline('withDbAccessContext(scope=system)', () => neverSettles(), {
      timeoutMs: 5_000,
      onExpired: () => {
        throw new Error('reclaimer exploded');
      },
    });
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('aborts the deadline so no further set_config statements are issued', async () => {
    // `Promise.race` does NOT cancel its loser. Without an abort flag checked at
    // every statement boundary, a statement that finally resolved late would
    // queue the remaining five onto a connection being torn down — or already
    // recycled to a different tenant's request.
    let deadline: PrologueDeadline | null = null;
    const result = withPrologueDeadline(
      'withDbAccessContext(scope=system)',
      (d) => {
        deadline = d;
        return neverSettles();
      },
      { timeoutMs: 15_000 },
    ).catch(() => undefined);

    expect(deadline!.aborted).toBe(false);
    expect(() => deadline!.throwIfAborted()).not.toThrow();

    await vi.advanceTimersByTimeAsync(15_000);
    await result;

    expect(deadline!.aborted).toBe(true);
    expect(() => deadline!.throwIfAborted()).toThrow(DbAccessContextPrologueAbortedError);
  });

  it('leaves a normal prologue completely unaffected', async () => {
    const onExpired = vi.fn();
    const result = await withPrologueDeadline(
      'withDbAccessContext(scope=organization)',
      async (deadline) => {
        deadline.throwIfAborted();
        deadline.disarm();
        return 'rows';
      },
      { timeoutMs: 15_000, onExpired },
    );

    expect(result).toBe('rows');
    expect(onExpired).not.toHaveBeenCalled();
    // The timer must be gone, not merely ignored: a live timer would keep a
    // reference to the rejection path for every request in flight.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not bound the caller work that follows a disarmed prologue', async () => {
    // The deadline covers the prologue ONLY. A slow request is not a wedged one,
    // and bounding `fn` here would turn every long report query into a 500.
    const onExpired = vi.fn();
    let release: (() => void) | null = null;
    const slowWork = new Promise<string>((resolve) => {
      release = () => resolve('done');
    });

    const result = withPrologueDeadline(
      'withDbAccessContext(scope=organization)',
      async (deadline) => {
        deadline.disarm();
        return slowWork;
      },
      { timeoutMs: 1_000, onExpired },
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onExpired).not.toHaveBeenCalled();

    release!();
    await expect(result).resolves.toBe('done');
  });

  it('is a pass-through when the bound is disabled', async () => {
    const onExpired = vi.fn();
    const seen: PrologueDeadline[] = [];
    const result = await withPrologueDeadline(
      'withDbAccessContext(scope=system)',
      async (deadline) => {
        seen.push(deadline);
        return 7;
      },
      { timeoutMs: 0, onExpired },
    );

    expect(result).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
    expect(seen[0]!.aborted).toBe(false);
    expect(() => seen[0]!.throwIfAborted()).not.toThrow();
  });

  it('does not surface an unhandled rejection when the abandoned work rejects later', async () => {
    // Once the reclaimer terminates the backend the driver finally rejects the
    // abandoned transaction with CONNECTION_CLOSED. Nobody awaits it any more,
    // so if the race did not keep it subscribed it would reach the process-level
    // unhandledRejection handler and be reported as a fatal DB error.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectLate: ((err: Error) => void) | null = null;
      const abandoned = new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });

      const result = withPrologueDeadline('withDbAccessContext(scope=system)', () => abandoned, {
        timeoutMs: 1_000,
      }).catch(() => 'timed-out');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toBe('timed-out');

      rejectLate!(new Error('CONNECTION_CLOSED'));
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
