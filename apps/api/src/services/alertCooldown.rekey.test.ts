import { beforeEach, expect, it, vi } from 'vitest';
const { redis, getRedis } = vi.hoisted(() => {
  const redis = { scan: vi.fn(), pttl: vi.fn(), set: vi.fn(), del: vi.fn() };
  return { redis, getRedis: vi.fn(() => redis as typeof redis | null) };
});
vi.mock('./redis', () => ({ getRedis, isRedisAvailable: () => true }));
import { rekeyConfigPolicyCooldowns, rekeyCooldownsBackToConfigPolicy } from './alertCooldown';
beforeEach(() => { vi.resetAllMocks(); getRedis.mockReturnValue(redis); });
it('moves positive config-policy TTLs and removes expired keys across SCAN pages', async () => {
  redis.scan.mockResolvedValueOnce(['1', ['breeze:alerts:cooldown:cpar:source:a']]).mockResolvedValueOnce(['0', ['breeze:alerts:cooldown:cpar:source:b']]);
  redis.pttl.mockResolvedValueOnce(1000).mockResolvedValueOnce(0);
  expect(await rekeyConfigPolicyCooldowns('source', 'compiled')).toBe(2);
  expect(redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'breeze:alerts:cooldown:cpar:source:*', 'COUNT', 200);
  expect(redis.scan).toHaveBeenNthCalledWith(2, '1', 'MATCH', 'breeze:alerts:cooldown:cpar:source:*', 'COUNT', 200);
  expect(redis.set).toHaveBeenCalledExactlyOnceWith('breeze:alerts:cooldown:compiled:a', expect.any(String), 'PX', 1000);
  expect(redis.del).toHaveBeenCalledTimes(2);
});
it('reverses only compiled-rule keys preserving the remaining TTL', async () => {
  redis.scan.mockResolvedValue(['0', ['breeze:alerts:cooldown:compiled:a']]);
  redis.pttl.mockResolvedValue(321);
  expect(await rekeyCooldownsBackToConfigPolicy('compiled', 'source')).toBe(1);
  expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'breeze:alerts:cooldown:compiled:*', 'COUNT', 200);
  expect(redis.set).toHaveBeenCalledWith('breeze:alerts:cooldown:cpar:source:a', expect.any(String), 'PX', 321);
  expect(redis.del).toHaveBeenCalledWith('breeze:alerts:cooldown:compiled:a');
});
it('returns zero when Redis is unavailable', async () => {
  getRedis.mockReturnValue(null);
  expect(await rekeyConfigPolicyCooldowns('source', 'compiled')).toBe(0);
  expect(await rekeyCooldownsBackToConfigPolicy('compiled', 'source')).toBe(0);
});
