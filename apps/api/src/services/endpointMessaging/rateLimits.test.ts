import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rateLimiter: vi.fn(),
  redis: null as null | { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> },
  store: new Map<string, string>(),
}));

vi.mock('../rate-limit', () => ({ rateLimiter: h.rateLimiter }));
vi.mock('../redis', () => ({ getRedis: () => h.redis }));

import {
  ENDPOINT_MESSAGE_RATE_LIMITS,
  checkActorSendLimit,
  checkPartnerDeliveryLimit,
  claimCriticalSlot,
  releaseCriticalSlot,
} from './rateLimits';
import { claimMessageIdempotency, completeMessageIdempotency, releaseMessageIdempotency } from './idempotency';

function fakeRedis() {
  return {
    set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
      if (rest.includes('NX') && h.store.has(key)) return null;
      h.store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => h.store.get(key) ?? null),
    del: vi.fn(async (key: string) => (h.store.delete(key) ? 1 : 0)),
  };
}

describe('endpoint message rate limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.store.clear();
    h.redis = fakeRedis();
    h.rateLimiter.mockResolvedValue({ allowed: true, remaining: 5, resetAt: new Date(Date.now() + 60_000) });
  });

  it('limits are 20 sends/hour/actor, 10000 deliveries/hour/partner, 1 critical per device per 5 minutes', () => {
    expect(ENDPOINT_MESSAGE_RATE_LIMITS).toEqual({
      actorSendsPerHour: 20,
      partnerDeliveriesPerHour: 10_000,
      criticalPerDeviceWindowSeconds: 300,
    });
  });

  it('actor limit: keyed by actor, one send per call, rejections refunded', async () => {
    await checkActorSendLimit('user-1');
    expect(h.rateLimiter).toHaveBeenCalledWith(h.redis, 'endpoint-msg:actor:user-1', 20, 3600, 1, { refundOnReject: true });
  });

  it('partner limit: keyed by partner, cost = device deliveries', async () => {
    await checkPartnerDeliveryLimit('partner-1', 250);
    expect(h.rateLimiter).toHaveBeenCalledWith(h.redis, 'endpoint-msg:partner:partner-1', 10_000, 3600, 250, { refundOnReject: true });
  });

  it('partner limit with zero deliveries consumes nothing', async () => {
    await expect(checkPartnerDeliveryLimit('partner-1', 0)).resolves.toMatchObject({ allowed: true });
    expect(h.rateLimiter).not.toHaveBeenCalled();
  });

  it('reports retryAfterSeconds (>= 1) from the window reset when rejected', async () => {
    h.rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 90_500) });
    const r = await checkActorSendLimit('user-1');
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(90);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(92);
  });

  it('critical slot: first claim wins, second within the window loses, release frees it', async () => {
    expect(await claimCriticalSlot('dev-1')).toBe(true);
    expect(h.redis!.set).toHaveBeenCalledWith('endpoint-msg:critical:dev-1', '1', 'EX', 300, 'NX');
    expect(await claimCriticalSlot('dev-1')).toBe(false);
    await releaseCriticalSlot('dev-1');
    expect(await claimCriticalSlot('dev-1')).toBe(true);
  });

  it('critical slot fails closed (no slot) when Redis is unavailable', async () => {
    h.redis = null;
    expect(await claimCriticalSlot('dev-1')).toBe(false);
  });
});

describe('message idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.store.clear();
    h.redis = fakeRedis();
  });

  it('first claim wins; a concurrent duplicate sees in_progress', async () => {
    expect(await claimMessageIdempotency('u1', 'm1')).toEqual({ state: 'claimed' });
    expect(await claimMessageIdempotency('u1', 'm1')).toEqual({ state: 'in_progress' });
  });

  it('after completion a replay returns the stored first 200 body', async () => {
    await claimMessageIdempotency('u1', 'm1');
    await completeMessageIdempotency('u1', 'm1', { batchId: 'b', deviceCount: 1, results: [] });
    expect(await claimMessageIdempotency('u1', 'm1')).toEqual({
      state: 'replay',
      body: { batchId: 'b', deviceCount: 1, results: [] },
    });
  });

  it('is scoped per (actor, messageId): another actor with the same id is a fresh claim', async () => {
    await claimMessageIdempotency('u1', 'm1');
    expect(await claimMessageIdempotency('u2', 'm1')).toEqual({ state: 'claimed' });
  });

  it('completion is kept for 24 hours', async () => {
    await claimMessageIdempotency('u1', 'm1');
    await completeMessageIdempotency('u1', 'm1', { ok: true });
    const lastSet = h.redis!.set.mock.calls.at(-1)!;
    expect(lastSet[2]).toBe('EX');
    expect(lastSet[3]).toBe(24 * 3600);
  });

  it('release lets the same messageId be retried (a rejected send must not burn the id)', async () => {
    await claimMessageIdempotency('u1', 'm1');
    await releaseMessageIdempotency('u1', 'm1');
    expect(await claimMessageIdempotency('u1', 'm1')).toEqual({ state: 'claimed' });
  });

  it('is unavailable (fail closed) without Redis', async () => {
    h.redis = null;
    expect(await claimMessageIdempotency('u1', 'm1')).toEqual({ state: 'unavailable' });
  });
});
