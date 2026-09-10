import { describe, it, expect, vi } from 'vitest';
import {
  LEASE_GRACE_MS,
  LEASE_MIN_CONSECUTIVE_FAILURES,
  LEASE_RENEW_EVERY_MS,
  leaseOutcomeForStatus,
  renewRevocationLeaseOnce,
  startRevocationLeaseRenewal,
} from './revocationLease';

const PARAMS = {
  apiUrl: 'https://api.example.com',
  sessionId: 'sess-1',
  accessToken: 'viewer-token',
};

describe('lease cadence constants', () => {
  it('mirrors the API contract', () => {
    expect(LEASE_RENEW_EVERY_MS).toBe(25_000);
    expect(LEASE_GRACE_MS).toBe(90_000);
    expect(LEASE_MIN_CONSECUTIVE_FAILURES).toBe(2);
  });
});

describe('leaseOutcomeForStatus', () => {
  it('treats 403 and 410 as definitive revocations', () => {
    expect(leaseOutcomeForStatus(403, 'membership_removed')).toEqual({
      kind: 'revoked',
      reason: 'membership_removed',
    });
    expect(leaseOutcomeForStatus(410)).toEqual({ kind: 'revoked', reason: 'revoked' });
  });

  it('treats 2xx as renewed', () => {
    expect(leaseOutcomeForStatus(200)).toEqual({ kind: 'renewed' });
  });

  it('treats 503 lease_unavailable as inconclusive, never a revocation', () => {
    expect(leaseOutcomeForStatus(503)).toEqual({ kind: 'unavailable' });
  });

  it('treats 401 as inconclusive — token expiry is not a revocation', () => {
    expect(leaseOutcomeForStatus(401)).toEqual({ kind: 'unavailable' });
  });

  it('treats 429 and 5xx as inconclusive', () => {
    expect(leaseOutcomeForStatus(429)).toEqual({ kind: 'unavailable' });
    expect(leaseOutcomeForStatus(500)).toEqual({ kind: 'unavailable' });
  });
});

describe('renewRevocationLeaseOnce', () => {
  it('posts to the viewer lease endpoint with the viewer token', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 'renewed' }), { status: 200 }));
    const outcome = await renewRevocationLeaseOnce(PARAMS, fetchFn as never);

    expect(outcome.kind).toBe('renewed');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/desktop-ws/sess-1/viewer/lease/renew');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer viewer-token');
  });

  it('surfaces the server reason on a revocation', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'revoked', reason: 'site_scope_lost' }), { status: 403 }),
    );
    await expect(renewRevocationLeaseOnce(PARAMS, fetchFn as never)).resolves.toEqual({
      kind: 'revoked',
      reason: 'site_scope_lost',
    });
  });

  it('never throws on a network error — it is inconclusive, not a revocation', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(renewRevocationLeaseOnce(PARAMS, fetchFn as never)).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('tolerates a body-less answer', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 200 }));
    await expect(renewRevocationLeaseOnce(PARAMS, fetchFn as never)).resolves.toEqual({
      kind: 'renewed',
    });
  });
});

describe('startRevocationLeaseRenewal', () => {
  /** Drives the loop by hand: no real timers, no real clock. */
  function rig(fetchFn: typeof fetch, opts: { graceMs?: number } = {}) {
    let tickFn: (() => void) | null = null;
    let clock = 0;
    const onRevoked = vi.fn();
    const onLost = vi.fn();
    const stop = startRevocationLeaseRenewal(PARAMS, { onRevoked, onLost }, {
      fetchFn,
      now: () => clock,
      setIntervalFn: (fn) => {
        tickFn = fn;
        return 'handle';
      },
      clearIntervalFn: () => {
        tickFn = null;
      },
      graceMs: opts.graceMs ?? LEASE_GRACE_MS,
    });
    return {
      onRevoked,
      onLost,
      stop,
      advance: (ms: number) => {
        clock += ms;
      },
      tick: async () => {
        tickFn?.();
        // Let the async tick body settle (fetch + Response.json both resolve
        // across real task boundaries, so microtask flushes alone are not
        // enough).
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      isRunning: () => tickFn !== null,
    };
  }

  it('renews quietly while the server keeps saying yes', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    const r = rig(fetchFn as never);

    for (let i = 0; i < 5; i++) {
      r.advance(LEASE_RENEW_EVERY_MS);
      await r.tick();
    }

    expect(r.onRevoked).not.toHaveBeenCalled();
    expect(r.onLost).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('fires onRevoked immediately on a 403 and stops renewing', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'permissions_changed' }), { status: 403 }),
    );
    const r = rig(fetchFn as never);

    await r.tick();

    expect(r.onRevoked).toHaveBeenCalledWith('permissions_changed');
    expect(r.onLost).not.toHaveBeenCalled();
    expect(r.isRunning()).toBe(false);
  });

  it('rides out failures inside the grace window', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 503 }));
    const r = rig(fetchFn as never);

    // Several failures, but the clock has not crossed the grace window.
    await r.tick();
    r.advance(LEASE_RENEW_EVERY_MS);
    await r.tick();
    r.advance(LEASE_RENEW_EVERY_MS);
    await r.tick();

    expect(r.onLost).not.toHaveBeenCalled();
    expect(r.isRunning()).toBe(true);
  });

  it('gives up once failures span the whole grace window', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 503 }));
    const r = rig(fetchFn as never);

    await r.tick();
    r.advance(LEASE_GRACE_MS);
    await r.tick();

    expect(r.onLost).toHaveBeenCalledTimes(1);
    expect(r.onRevoked).not.toHaveBeenCalled();
    expect(r.isRunning()).toBe(false);
  });

  it('never gives up on a SINGLE failure, however old the loop is', async () => {
    let status = 200;
    const fetchFn = vi.fn(async () => new Response('{}', { status }));
    const r = rig(fetchFn as never);

    // Run healthy for a long while, then fail exactly once.
    await r.tick();
    r.advance(LEASE_GRACE_MS * 10);
    status = 503;
    await r.tick();

    expect(r.onLost).not.toHaveBeenCalled();
    expect(r.isRunning()).toBe(true);
  });

  it('resets the failure window after a successful renewal', async () => {
    let status = 503;
    const fetchFn = vi.fn(async () => new Response('{}', { status }));
    const r = rig(fetchFn as never);

    await r.tick(); // fail — window opens
    status = 200;
    r.advance(LEASE_GRACE_MS);
    await r.tick(); // success — window must close
    status = 503;
    await r.tick(); // one fresh failure
    r.advance(LEASE_GRACE_MS - 1);
    await r.tick();

    expect(r.onLost).not.toHaveBeenCalled();
  });

  it('stops cleanly and fires nothing afterwards', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 403 }));
    const r = rig(fetchFn as never);

    r.stop();
    r.stop(); // idempotent
    await r.tick();

    expect(r.onRevoked).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('renew request timeout', () => {
  it('passes an abort signal so a hung renew cannot outlive its own cadence', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    await renewRevocationLeaseOnce(PARAMS, fetchFn as never);

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('reports a timed-out renew as unavailable — never as a revocation', async () => {
    // A fetch that only ever settles when the caller's signal aborts.
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'TimeoutError')),
          );
        }),
    );

    const outcome = await renewRevocationLeaseOnce(PARAMS, fetchFn as never, 10);
    expect(outcome).toEqual({ kind: 'unavailable' });
  });
});

describe('startRevocationLeaseRenewal — in-flight guard', () => {
  /** A rig whose fetch hangs until the test releases it. */
  function hangingRig(opts: { graceMs?: number } = {}) {
    let tickFn: (() => void) | null = null;
    let clock = 0;
    const pending: Array<(status: number) => void> = [];
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push((status) => resolve(new Response('{}', { status })));
        }),
    );
    const onRevoked = vi.fn();
    const onLost = vi.fn();
    const stop = startRevocationLeaseRenewal(
      PARAMS,
      { onRevoked, onLost },
      {
        fetchFn: fetchFn as never,
        now: () => clock,
        setIntervalFn: (fn) => {
          tickFn = fn;
          return 'handle';
        },
        clearIntervalFn: () => {
          tickFn = null;
        },
        graceMs: opts.graceMs ?? LEASE_GRACE_MS,
      },
    );
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return {
      fetchFn,
      onRevoked,
      onLost,
      stop,
      advance: (ms: number) => {
        clock += ms;
      },
      tick: async () => {
        tickFn?.();
        await settle();
      },
      /** Resolve every outstanding renew with `status`. */
      release: async (status: number) => {
        const waiting = pending.splice(0, pending.length);
        for (const resolve of waiting) resolve(status);
        await settle();
      },
      isRunning: () => tickFn !== null,
    };
  }

  it('skips a tick while a renew is still in flight instead of stacking requests', async () => {
    const r = hangingRig();

    await r.tick();
    expect(r.fetchFn).toHaveBeenCalledTimes(1);

    // Three more ticks land while the first request is still outstanding.
    r.advance(LEASE_RENEW_EVERY_MS);
    await r.tick();
    r.advance(LEASE_RENEW_EVERY_MS);
    await r.tick();
    r.advance(LEASE_RENEW_EVERY_MS);
    await r.tick();
    expect(r.fetchFn).toHaveBeenCalledTimes(1);

    // Once it settles, the next tick issues a fresh request.
    await r.release(200);
    r.advance(LEASE_RENEW_EVERY_MS);
    await r.tick();
    expect(r.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a skipped tick is not a failure — it must not consume the grace budget', async () => {
    const r = hangingRig();

    await r.tick(); // in flight
    r.advance(LEASE_GRACE_MS * 5);
    await r.tick(); // skipped
    await r.tick(); // skipped

    expect(r.onLost).not.toHaveBeenCalled();
    expect(r.isRunning()).toBe(true);
  });

  it('a slow renew that fails still counts toward the failure budget', async () => {
    const r = hangingRig();

    await r.tick();
    await r.release(503); // failure 1, window opens at clock 0

    r.advance(LEASE_GRACE_MS);
    await r.tick();
    await r.release(503); // failure 2, past the grace window

    expect(r.onLost).toHaveBeenCalledTimes(1);
    expect(r.onRevoked).not.toHaveBeenCalled();
    expect(r.isRunning()).toBe(false);
  });

  it('a slow renew that comes back revoked still ends the session', async () => {
    const r = hangingRig();

    await r.tick();
    r.advance(LEASE_RENEW_EVERY_MS);
    await r.tick(); // skipped
    await r.release(403);

    expect(r.onRevoked).toHaveBeenCalledTimes(1);
    expect(r.isRunning()).toBe(false);
  });

  it('clears the in-flight flag after a stop so nothing leaks', async () => {
    const r = hangingRig();

    await r.tick();
    r.stop();
    await r.release(200);

    expect(r.onRevoked).not.toHaveBeenCalled();
    expect(r.onLost).not.toHaveBeenCalled();
  });
});
