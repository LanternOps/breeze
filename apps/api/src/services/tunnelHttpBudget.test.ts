import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rateLimiterMock } = vi.hoisted(() => ({ rateLimiterMock: vi.fn() }));
vi.mock('./rate-limit', () => ({ rateLimiter: rateLimiterMock }));
const { getRedisMock } = vi.hoisted(() => ({ getRedisMock: vi.fn((): unknown => ({})) }));
vi.mock('./redis', () => ({ getRedis: getRedisMock }));

import {
  TUNNEL_HTTP_CONCURRENCY_LIMITS, TUNNEL_HTTP_RATE_LIMITS, __resetTunnelHttpBudgetForTests, acquireTunnelHttpSlot, checkTunnelHttpRate,
} from './tunnelHttpBudget';

const keys = { userId: 'u1', tunnelId: 't1', agentId: 'a1' };

beforeEach(() => {
  __resetTunnelHttpBudgetForTests();
  rateLimiterMock.mockReset();
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 1, resetAt: new Date(Date.now() + 60_000) });
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

describe('tunnel http concurrency budgets', () => {
  it('caps in-flight requests per tunnel and frees the slot on release (idempotently)', () => {
    const slots = Array.from({ length: TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel }, () => acquireTunnelHttpSlot(keys));
    expect(slots.every((s) => s.ok)).toBe(true);
    expect(acquireTunnelHttpSlot(keys)).toEqual({ ok: false, scope: 'tunnel' });
    const first = slots[0]!;
    if (first.ok) { first.release(); first.release(); }
    expect(acquireTunnelHttpSlot(keys).ok).toBe(true);
    expect(acquireTunnelHttpSlot(keys)).toEqual({ ok: false, scope: 'tunnel' });
  });

  it('caps a user across tunnels and an agent across users', () => {
    for (let i = 0; i < TUNNEL_HTTP_CONCURRENCY_LIMITS.user; i += 1) {
      expect(acquireTunnelHttpSlot({ userId: 'u1', tunnelId: `t${i}`, agentId: `a${i}` }).ok).toBe(true);
    }
    expect(acquireTunnelHttpSlot({ userId: 'u1', tunnelId: 'fresh', agentId: 'fresh' })).toEqual({ ok: false, scope: 'user' });
    __resetTunnelHttpBudgetForTests();
    for (let i = 0; i < TUNNEL_HTTP_CONCURRENCY_LIMITS.agent; i += 1) {
      expect(acquireTunnelHttpSlot({ userId: `u${i}`, tunnelId: `t${i}`, agentId: 'a1' }).ok).toBe(true);
    }
    expect(acquireTunnelHttpSlot({ userId: 'fresh', tunnelId: 'fresh', agentId: 'a1' })).toEqual({ ok: false, scope: 'agent' });
  });

  it('a refused acquire takes no slot in any scope', () => {
    for (let i = 0; i < TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel; i += 1) acquireTunnelHttpSlot(keys);
    // Refused on the tunnel scope: the user and agent counters must not have moved.
    expect(acquireTunnelHttpSlot(keys).ok).toBe(false);
    const others = Array.from({ length: TUNNEL_HTTP_CONCURRENCY_LIMITS.user - TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel },
      (_, i) => acquireTunnelHttpSlot({ userId: 'u1', tunnelId: `other${i}`, agentId: 'a1' }));
    expect(others.every((s) => s.ok)).toBe(true);
    expect(acquireTunnelHttpSlot({ userId: 'u1', tunnelId: 'x', agentId: 'a1' })).toEqual({ ok: false, scope: 'user' });
  });
});
