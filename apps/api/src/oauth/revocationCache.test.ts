import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRedis } from '../services/redis';
import { isJtiRevoked, revokeJti } from './revocationCache';

const redisUrl = 'redis://localhost:6379';
const oldRedisUrl = process.env.REDIS_URL;

async function canReachRedis(): Promise<boolean> {
  const redis = new Redis(redisUrl, {
    connectTimeout: 200,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });

  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    console.warn('Redis unreachable; skipping revocation cache test');
    return false;
  } finally {
    redis.disconnect();
  }
}

const describeIfRedis = (await canReachRedis()) ? describe : describe.skip;

describeIfRedis('revocationCache', () => {
  let redis: Redis;

  beforeAll(() => {
    process.env.REDIS_URL = redisUrl;
    redis = new Redis(redisUrl);
  });

  beforeEach(async () => {
    const keys = await redis.keys('oauth:revoked:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    const keys = await redis.keys('oauth:revoked:*');
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
    await closeRedis();
    if (oldRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = oldRedisUrl;
  });

  it('returns true for a revoked jti', async () => {
    await revokeJti('jti-revoked', 60);

    await expect(isJtiRevoked('jti-revoked')).resolves.toBe(true);
  });

  it('returns false for an unknown jti', async () => {
    await expect(isJtiRevoked('jti-unknown')).resolves.toBe(false);
  });

  it('respects the revocation ttl', async () => {
    await revokeJti('jti-ttl', 1);
    await expect(isJtiRevoked('jti-ttl')).resolves.toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    await expect(isJtiRevoked('jti-ttl')).resolves.toBe(false);
  });
});
