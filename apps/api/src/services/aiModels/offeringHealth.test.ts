import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  redis: null as null | {
    set: ReturnType<typeof vi.fn>; mget: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn>;
  },
  listOfferings: vi.fn(),
}));
vi.mock('../redis', () => ({ getRedis: () => h.redis }));
vi.mock('./offerings', () => ({ listOfferings: h.listOfferings }));

import {
  clearConnectionCooldowns,
  coolingOfferings,
  markOfferingCooldown,
  noteProviderFailure,
  noteProviderFailureForBinding,
} from './offeringHealth';

beforeEach(() => {
  h.redis = { set: vi.fn(async () => 'OK'), mget: vi.fn(async () => []), del: vi.fn(async () => 1) };
  h.listOfferings.mockReset();
});

describe('offering cooldown', () => {
  it('marks with the cause-specific TTL', async () => {
    await markOfferingCooldown('off-1', 'overloaded');
    await markOfferingCooldown('off-2', 'auth_failed');
    expect(h.redis!.set).toHaveBeenNthCalledWith(1, 'ai-model:cooldown:off-1', 'overloaded', 'PX', 60_000);
    expect(h.redis!.set).toHaveBeenNthCalledWith(2, 'ai-model:cooldown:off-2', 'auth_failed', 'PX', 900_000);
  });

  it('reads many ids in one MGET and returns the cooling ones', async () => {
    h.redis!.mget.mockResolvedValue(['overloaded', null]);
    expect(await coolingOfferings(['a', 'b', 'a'])).toEqual(new Set(['a']));
    expect(h.redis!.mget).toHaveBeenCalledWith('ai-model:cooldown:a', 'ai-model:cooldown:b');
  });

  it('fails open: no Redis, a Redis error, or a slow Redis all mean "nothing is cooling"', async () => {
    h.redis = null;
    expect(await coolingOfferings(['a'])).toEqual(new Set());
    h.redis = { set: vi.fn(), del: vi.fn(), mget: vi.fn(async () => { throw new Error('down'); }) };
    expect(await coolingOfferings(['a'])).toEqual(new Set());
    vi.useFakeTimers();
    h.redis.mget = vi.fn(() => new Promise(() => undefined));
    const pending = coolingOfferings(['a']);
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toEqual(new Set());
    vi.useRealTimers();
  });

  it('noteProviderFailure skips a partnerless platform call (no offering id)', async () => {
    await noteProviderFailure({ offering: { id: null, displayName: 'x' }, surface: 'patch_test', funding: 'platform' }, 'overloaded');
    expect(h.redis!.set).not.toHaveBeenCalled();
  });

  it('a key rotation clears the cooldown of every offering on that connection', async () => {
    h.listOfferings.mockResolvedValue([{ id: 'o1', connectionId: 'c1' }, { id: 'o2', connectionId: 'c1' }]);
    await clearConnectionCooldowns('p1', 'c1');
    expect(h.listOfferings).toHaveBeenCalledWith('p1', { connectionId: 'c1' });
    expect(h.redis!.del).toHaveBeenCalledWith('ai-model:cooldown:o1', 'ai-model:cooldown:o2');
  });

  it('noteProviderFailureForBinding cools the binding offering', async () => {
    await noteProviderFailureForBinding({ offeringId: 'o9', surface: 'chat', funding: 'platform' }, 'rate_limited');
    expect(h.redis!.set).toHaveBeenCalledWith('ai-model:cooldown:o9', 'rate_limited', 'PX', 60_000);
  });
});
