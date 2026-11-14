import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rateLimiterMock } = vi.hoisted(() => ({ rateLimiterMock: vi.fn() }));
vi.mock('./rate-limit', () => ({ rateLimiter: rateLimiterMock }));
const { getRedisMock } = vi.hoisted(() => ({ getRedisMock: vi.fn((): unknown => ({})) }));
vi.mock('./redis', () => ({ getRedis: getRedisMock }));

import {
  TUNNEL_HTTP_CONCURRENCY_LIMITS, TUNNEL_HTTP_QUEUE_LIMITS, TUNNEL_HTTP_RATE_LIMITS, __resetTunnelHttpBudgetForTests,
  __tunnelHttpBudgetStateForTests, acquireTunnelHttpSlot, checkTunnelHttpRate, type TunnelSlotResult,
} from './tunnelHttpBudget';

const keys = { userId: 'u1', tunnelId: 't1', agentId: 'a1' };

beforeEach(() => {
  __resetTunnelHttpBudgetForTests();
  rateLimiterMock.mockReset();
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 1, resetAt: new Date(Date.now() + 60_000) });
});

afterEach(() => {
  vi.useRealTimers();
  __resetTunnelHttpBudgetForTests();
});

describe('tunnel http rate budgets', () => {
  it('checks tunnel, user and agent rate buckets with their limits and reports the first exhausted scope', async () => {
    expect(await checkTunnelHttpRate(keys)).toEqual({ ok: true });
    expect(rateLimiterMock.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ['tunnel-http:rate:tunnel:t1', TUNNEL_HTTP_RATE_LIMITS.tunnel, 60],
      ['tunnel-http:rate:user:u1', TUNNEL_HTTP_RATE_LIMITS.user, 60],
      ['tunnel-http:rate:agent:a1', TUNNEL_HTTP_RATE_LIMITS.agent, 60],
    ]);
    rateLimiterMock.mockResolvedValueOnce({ allowed: true, remaining: 1, resetAt: new Date() })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 30_000) });
    const limited = await checkTunnelHttpRate(keys);
    expect(limited).toMatchObject({ ok: false, scope: 'user' });
    expect(limited.ok === false && limited.retryAfterSeconds).toBeGreaterThanOrEqual(29);
  });

  it('reports the budget store as unavailable (not a user/tunnel limit) when Redis is down', async () => {
    getRedisMock.mockReturnValueOnce(null);
    expect(await checkTunnelHttpRate(keys)).toEqual({ ok: false, scope: 'unavailable', retryAfterSeconds: 5 });
    expect(rateLimiterMock).not.toHaveBeenCalled();
  });

  it('never reports a Retry-After below one second', async () => {
    rateLimiterMock.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() - 5_000) });
    expect(await checkTunnelHttpRate(keys)).toEqual({ ok: false, scope: 'tunnel', retryAfterSeconds: 1 });
  });
});

type Granted = Extract<TunnelSlotResult, { ok: true }>;

async function fill(n: number, k = keys): Promise<Granted[]> {
  const slots = await Promise.all(Array.from({ length: n }, () => acquireTunnelHttpSlot(k)));
  for (const s of slots) expect(s.ok).toBe(true);
  return slots as Granted[];
}

/** Lets already-settled promise callbacks run, without advancing any timer. */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('tunnel http concurrency budgets', () => {
  it('caps in-flight requests per tunnel and frees the slot on release (idempotently)', async () => {
    const slots = await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    expect(__tunnelHttpBudgetStateForTests().inFlight).toEqual({ 'tunnel:t1': 12, 'user:u1': 12, 'agent:a1': 12 });
    slots[0]!.release();
    slots[0]!.release();
    expect(__tunnelHttpBudgetStateForTests().inFlight['tunnel:t1']).toBe(11);
    expect((await acquireTunnelHttpSlot(keys)).ok).toBe(true);
    expect(__tunnelHttpBudgetStateForTests().inFlight['tunnel:t1']).toBe(12);
  });

  it('refuses at once (no queueing) when the user or the agent ceiling is the one that is full', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < TUNNEL_HTTP_CONCURRENCY_LIMITS.user; i += 1) {
      expect((await acquireTunnelHttpSlot({ userId: 'u1', tunnelId: `t${i}`, agentId: `a${i}` })).ok).toBe(true);
    }
    // Settles without any timer advancing: a hard ceiling, not a wait.
    expect(await acquireTunnelHttpSlot({ userId: 'u1', tunnelId: 'fresh', agentId: 'fresh' }))
      .toEqual({ ok: false, scope: 'user', reason: 'busy' });
    __resetTunnelHttpBudgetForTests();
    for (let i = 0; i < TUNNEL_HTTP_CONCURRENCY_LIMITS.agent; i += 1) {
      expect((await acquireTunnelHttpSlot({ userId: `u${i}`, tunnelId: `t${i}`, agentId: 'a1' })).ok).toBe(true);
    }
    expect(await acquireTunnelHttpSlot({ userId: 'fresh', tunnelId: 'fresh', agentId: 'a1' }))
      .toEqual({ ok: false, scope: 'agent', reason: 'busy' });
    expect(__tunnelHttpBudgetStateForTests().queued).toEqual({});
  });

  it('a refused acquire takes no slot in any scope', async () => {
    await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.user - TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel,
      { userId: 'u1', tunnelId: 'other', agentId: 'a2' });
    for (let i = 0; i < TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel; i += 1) {
      expect((await acquireTunnelHttpSlot({ userId: 'u1', tunnelId: `t${i}`, agentId: 'a1' })).ok).toBe(true);
    }
    const before = __tunnelHttpBudgetStateForTests().inFlight;
    expect(await acquireTunnelHttpSlot({ userId: 'u1', tunnelId: 'x', agentId: 'a1' }))
      .toEqual({ ok: false, scope: 'user', reason: 'busy' });
    expect(__tunnelHttpBudgetStateForTests().inFlight).toEqual(before);
  });
});

describe('tunnel http concurrency queue (a full tunnel waits for a slot instead of refusing)', () => {
  it('queues the request after the tunnel cap and admits it when a slot frees', async () => {
    const slots = await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    let settled: TunnelSlotResult | undefined;
    const waiting = acquireTunnelHttpSlot(keys).then((r) => { settled = r; return r; });
    await flush();
    expect(settled).toBeUndefined();
    expect(__tunnelHttpBudgetStateForTests().queued).toEqual({ 'tunnel:t1': 1 });

    slots[0]!.release();
    const granted = await waiting;
    expect(granted.ok).toBe(true);
    // The freed slot went to the waiter: every scope is still at the cap, nothing queued.
    expect(__tunnelHttpBudgetStateForTests()).toEqual({
      inFlight: { 'tunnel:t1': 12, 'user:u1': 12, 'agent:a1': 12 },
      queued: {},
    });
    (granted as Granted).release();
    expect(__tunnelHttpBudgetStateForTests().inFlight['tunnel:t1']).toBe(11);
  });

  it('admits waiters in arrival order', async () => {
    const slots = await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    const order: number[] = [];
    const waiters = [0, 1, 2].map((n) => acquireTunnelHttpSlot(keys).then((r) => { order.push(n); return r; }));
    await flush();
    slots[0]!.release();
    await flush();
    expect(order).toEqual([0]);
    slots[1]!.release();
    slots[2]!.release();
    await Promise.all(waiters);
    expect(order).toEqual([0, 1, 2]);
  });

  it('refuses with queue_full once the per-tunnel queue is at its depth, without waiting', async () => {
    vi.useFakeTimers();
    await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    for (let i = 0; i < TUNNEL_HTTP_QUEUE_LIMITS.depth; i += 1) void acquireTunnelHttpSlot(keys);
    expect(__tunnelHttpBudgetStateForTests().queued).toEqual({ 'tunnel:t1': TUNNEL_HTTP_QUEUE_LIMITS.depth });
    expect(await acquireTunnelHttpSlot(keys)).toEqual({ ok: false, scope: 'tunnel', reason: 'queue_full' });
  });

  it('gives up after the bounded wait with a timeout refusal and leaves the queue', async () => {
    vi.useFakeTimers();
    await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    let settled: TunnelSlotResult | undefined;
    void acquireTunnelHttpSlot(keys).then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(TUNNEL_HTTP_QUEUE_LIMITS.maxWaitMs - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ ok: false, scope: 'tunnel', reason: 'timeout' });
    expect(__tunnelHttpBudgetStateForTests().queued).toEqual({});
    expect(__tunnelHttpBudgetStateForTests().inFlight['tunnel:t1']).toBe(12);
  });

  it('a waiter whose client disconnects leaves the queue, and the freed slot goes to the next waiter', async () => {
    const slots = await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    const controller = new AbortController();
    const abandoned = acquireTunnelHttpSlot(keys, { signal: controller.signal });
    const next = acquireTunnelHttpSlot(keys);
    await flush();
    controller.abort();
    expect(await abandoned).toEqual({ ok: false, scope: 'tunnel', reason: 'aborted' });
    expect(__tunnelHttpBudgetStateForTests().queued).toEqual({ 'tunnel:t1': 1 });
    slots[0]!.release();
    expect((await next).ok).toBe(true);
    expect(__tunnelHttpBudgetStateForTests().inFlight['tunnel:t1']).toBe(12);
  });

  it('an already-aborted request is refused without taking a slot or a queue place', async () => {
    const controller = new AbortController();
    controller.abort();
    await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    expect(await acquireTunnelHttpSlot(keys, { signal: controller.signal }))
      .toEqual({ ok: false, scope: 'tunnel', reason: 'aborted' });
    expect(__tunnelHttpBudgetStateForTests().queued).toEqual({});
  });

  it('a queued tunnel never takes the user or agent ceilings past their limits, so other tunnels keep their room', async () => {
    const slots = await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    const waiters = Array.from({ length: 20 }, () => acquireTunnelHttpSlot(keys));
    await flush();
    // Another tunnel of the same user and agent is still admitted at once, up to the user ceiling.
    await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.user - TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel,
      { userId: 'u1', tunnelId: 't2', agentId: 'a1' });
    expect(await acquireTunnelHttpSlot({ userId: 'u1', tunnelId: 't3', agentId: 'a1' }))
      .toEqual({ ok: false, scope: 'user', reason: 'busy' });
    // Draining t1's slots hands each to a waiter: t1 stays at its own cap throughout.
    for (const s of slots) s.release();
    await flush();
    const state = __tunnelHttpBudgetStateForTests();
    expect(state.inFlight['tunnel:t1']).toBe(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    expect(state.inFlight['user:u1']).toBe(TUNNEL_HTTP_CONCURRENCY_LIMITS.user);
    expect(state.queued).toEqual({ 'tunnel:t1': 20 - TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel });
    void waiters;
  });

  it('releasing the same slot twice after it was handed to a waiter admits only one waiter', async () => {
    const slots = await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel);
    const first = acquireTunnelHttpSlot(keys);
    let second: TunnelSlotResult | undefined;
    void acquireTunnelHttpSlot(keys).then((r) => { second = r; });
    await flush();
    slots[0]!.release();
    slots[0]!.release();
    expect((await first).ok).toBe(true);
    await flush();
    expect(second).toBeUndefined();
    expect(__tunnelHttpBudgetStateForTests()).toEqual({
      inFlight: { 'tunnel:t1': 12, 'user:u1': 12, 'agent:a1': 12 },
      queued: { 'tunnel:t1': 1 },
    });
  });

  it('when a blocked head waiter leaves, the next waiter that fits is admitted at once', async () => {
    // t1 is full with u1's requests; u2 is at its own ceiling on other tunnels.
    const t1 = await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel, { userId: 'u1', tunnelId: 't1', agentId: 'a1' });
    await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel, { userId: 'u2', tunnelId: 's1', agentId: 'a2' });
    await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.user - TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel,
      { userId: 'u2', tunnelId: 's2', agentId: 'a3' });
    const headAbort = new AbortController();
    const head = acquireTunnelHttpSlot({ userId: 'u2', tunnelId: 't1', agentId: 'a1' }, { signal: headAbort.signal });
    let next: TunnelSlotResult | undefined;
    void acquireTunnelHttpSlot({ userId: 'u3', tunnelId: 't1', agentId: 'a1' }).then((r) => { next = r; });
    await flush();
    t1[0]!.release(); // t1 has room, but the head (u2) cannot use it and u3 is behind it
    await flush();
    expect(next).toBeUndefined();
    headAbort.abort(); // no further release: leaving alone must hand the room on
    expect(await head).toEqual({ ok: false, scope: 'tunnel', reason: 'aborted' });
    await flush();
    expect(next?.ok).toBe(true);
    expect(__tunnelHttpBudgetStateForTests().queued).toEqual({});
  });

  it('a waiter blocked only by its own user ceiling is admitted when that user frees a slot on another tunnel', async () => {
    // Two users on one tunnel. t1 is full with u1's requests; u2 is at its own ceiling elsewhere.
    const t1 = await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel, { userId: 'u1', tunnelId: 't1', agentId: 'a1' });
    await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel, { userId: 'u2', tunnelId: 's1', agentId: 'a2' });
    const s2 = await fill(TUNNEL_HTTP_CONCURRENCY_LIMITS.user - TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel,
      { userId: 'u2', tunnelId: 's2', agentId: 'a3' });
    let settled: TunnelSlotResult | undefined;
    const waiting = acquireTunnelHttpSlot({ userId: 'u2', tunnelId: 't1', agentId: 'a1' })
      .then((r) => { settled = r; return r; });
    await flush();
    t1[0]!.release(); // t1 has room now, but u2 does not
    await flush();
    expect(settled).toBeUndefined();
    s2[0]!.release(); // u2 has room: the t1 waiter is admitted
    expect((await waiting).ok).toBe(true);
    expect(__tunnelHttpBudgetStateForTests().inFlight['user:u2']).toBe(TUNNEL_HTTP_CONCURRENCY_LIMITS.user);
  });
});
