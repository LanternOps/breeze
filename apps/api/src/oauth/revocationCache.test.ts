import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The global unit-test setup (apps/api/src/__tests__/setup.ts) auto-mocks
// `../services/redis` with a fake. This suite exercises the real cache
// against a live local Redis, so unmock here.
vi.unmock('../services/redis');

const { closeRedis } = await vi.importActual<typeof import('../services/redis')>('../services/redis');
const { isJtiRevoked, revokeJti } = await vi.importActual<typeof import('./revocationCache')>('./revocationCache');

describe('revocationCache fail-closed', () => {
  const oldMcpOauthEnabled = process.env.MCP_OAUTH_ENABLED;

  afterAll(() => {
    if (oldMcpOauthEnabled === undefined) delete process.env.MCP_OAUTH_ENABLED;
    else process.env.MCP_OAUTH_ENABLED = oldMcpOauthEnabled;
  });

  it('returns true (fail-closed) when redis.get rejects and OAuth is enabled', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const throwing = { get: vi.fn().mockRejectedValue(new Error('connection lost')) };
    vi.resetModules();
    vi.doMock('../services/redis', () => ({ getRedis: () => throwing }));

    const mod = await import('./revocationCache');

    await expect(mod.isJtiRevoked('jti-x')).resolves.toBe(true);
    await expect(mod.isGrantRevoked('grant-x')).resolves.toBe(true);
    expect(throwing.get).toHaveBeenCalledTimes(2);

    vi.doUnmock('../services/redis');
    vi.resetModules();
  });

  it('returns false when redis.get rejects and OAuth is disabled (no-op posture)', async () => {
    process.env.MCP_OAUTH_ENABLED = 'false';
    const throwing = { get: vi.fn().mockRejectedValue(new Error('connection lost')) };
    vi.resetModules();
    vi.doMock('../services/redis', () => ({ getRedis: () => throwing }));

    const mod = await import('./revocationCache');

    await expect(mod.isJtiRevoked('jti-x')).resolves.toBe(false);
    await expect(mod.isGrantRevoked('grant-x')).resolves.toBe(false);

    vi.doUnmock('../services/redis');
    vi.resetModules();
  });

  it('returns true (fail-closed) when Redis is missing and OAuth is enabled', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    vi.resetModules();
    vi.doMock('../services/redis', () => ({ getRedis: () => null }));

    const mod = await import('./revocationCache');

    await expect(mod.isJtiRevoked('jti-y')).resolves.toBe(true);
    await expect(mod.isGrantRevoked('grant-y')).resolves.toBe(true);

    vi.doUnmock('../services/redis');
    vi.resetModules();
  });

  it('returns false when Redis is missing and OAuth is disabled (no-op)', async () => {
    process.env.MCP_OAUTH_ENABLED = 'false';
    vi.resetModules();
    vi.doMock('../services/redis', () => ({ getRedis: () => null }));

    const mod = await import('./revocationCache');

    await expect(mod.isJtiRevoked('jti-z')).resolves.toBe(false);
    await expect(mod.isGrantRevoked('grant-z')).resolves.toBe(false);

    vi.doUnmock('../services/redis');
    vi.resetModules();
  });

  it('rejects jti revocation writes when OAuth is enabled and Redis is missing', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    vi.resetModules();
    vi.doMock('../services/redis', () => ({ getRedis: () => null }));

    const mod = await import('./revocationCache');

    await expect(mod.revokeJti('jti-missing-redis', 60)).rejects.toThrow(/Redis is required/);

    vi.doUnmock('../services/redis');
    vi.resetModules();
  });

  it('rejects grant revocation writes when OAuth is enabled and Redis is missing', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    vi.resetModules();
    vi.doMock('../services/redis', () => ({ getRedis: () => null }));

    const mod = await import('./revocationCache');

    await expect(mod.revokeGrant('grant-missing-redis', 60)).rejects.toThrow(/Redis is required/);

    vi.doUnmock('../services/redis');
    vi.resetModules();
  });

  it('keeps revocation writes as no-ops when OAuth is disabled and Redis is missing', async () => {
    process.env.MCP_OAUTH_ENABLED = 'false';
    vi.resetModules();
    vi.doMock('../services/redis', () => ({ getRedis: () => null }));

    const mod = await import('./revocationCache');

    await expect(mod.revokeJti('jti-oauth-disabled', 60)).resolves.toBeUndefined();
    await expect(mod.revokeGrant('grant-oauth-disabled', 60)).resolves.toBeUndefined();

    vi.doUnmock('../services/redis');
    vi.resetModules();
  });
});

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
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
