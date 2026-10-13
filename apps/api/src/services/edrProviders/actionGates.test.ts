import { beforeEach, describe, expect, it, vi } from 'vitest';

const rateLimiterMock = vi.hoisted(() => vi.fn());
vi.mock('../rate-limit', () => ({ rateLimiter: rateLimiterMock }));

import { checkEdrActionRateLimit, EDR_ACTION_RATE_LIMITS, edrActorKey } from './actionGates';

const redis = {} as never;
const allow = () => ({ allowed: true, remaining: 1, resetAt: new Date(Date.now() + 1000) });
const deny = (ms: number) => ({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + ms) });

describe('EDR action rate limits', () => {
  beforeEach(() => rateLimiterMock.mockReset());

  it('checks the actor window, then the connection window, with refund-on-reject', async () => {
    rateLimiterMock.mockResolvedValue(allow());
    await expect(checkEdrActionRateLimit({ redis, connectionId: 'c1', actorKey: 'u:1', targets: 1 }))
      .resolves.toEqual({ ok: true });
    expect(rateLimiterMock.mock.calls.map((c) => c.slice(1))).toEqual([
      ['edr-actions:actor:u:1', EDR_ACTION_RATE_LIMITS.perActor.limit, EDR_ACTION_RATE_LIMITS.perActor.windowSeconds, 1, { refundOnReject: true }],
      ['edr-actions:conn:c1', EDR_ACTION_RATE_LIMITS.perConnection.limit, EDR_ACTION_RATE_LIMITS.perConnection.windowSeconds, 1, { refundOnReject: true }],
    ]);
  });

  it('limits are 10 per actor and 30 per connection per 10 minutes', () => {
    expect(EDR_ACTION_RATE_LIMITS).toEqual({
      perConnection: { limit: 30, windowSeconds: 600 },
      perActor: { limit: 10, windowSeconds: 600 },
    });
  });

  it('a batch of 3 targets costs 3 in both windows', async () => {
    rateLimiterMock.mockResolvedValue(allow());
    await checkEdrActionRateLimit({ redis, connectionId: 'c1', actorKey: 'u:1', targets: 3 });
    expect(rateLimiterMock.mock.calls.map((c) => c[4])).toEqual([3, 3]);
  });

  it('per-actor rejection stops before the connection window and reports retry-after', async () => {
    rateLimiterMock.mockResolvedValueOnce(deny(4_500));
    const r = await checkEdrActionRateLimit({ redis, connectionId: 'c1', actorKey: 'u:1', targets: 1 });
    expect(r).toEqual({ ok: false, retryAfterSeconds: 5 });
    expect(rateLimiterMock).toHaveBeenCalledTimes(1);
  });

  it('per-connection rejection is refused', async () => {
    rateLimiterMock.mockResolvedValueOnce(allow()).mockResolvedValueOnce(deny(60_000));
    const r = await checkEdrActionRateLimit({ redis, connectionId: 'c1', actorKey: 'u:1', targets: 1 });
    expect(r.ok).toBe(false);
  });

  it('fails CLOSED with no Redis (no limiter call)', async () => {
    const r = await checkEdrActionRateLimit({ redis: null, connectionId: 'c1', actorKey: 'u:1', targets: 1 });
    expect(r).toMatchObject({ ok: false });
    expect(rateLimiterMock).not.toHaveBeenCalled();
  });

  it('actor key prefers the user over the AI session', () => {
    expect(edrActorKey({ userId: 'u1', aiSessionId: 's1' })).toBe('u:u1');
    expect(edrActorKey({ userId: null, aiSessionId: 's1' })).toBe('s:s1');
    expect(edrActorKey({ userId: null, aiSessionId: null })).toBe('anon');
  });
});
