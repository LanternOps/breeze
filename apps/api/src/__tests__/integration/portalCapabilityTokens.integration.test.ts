/**
 * Portal registration W2 (#11379): capability tokens are consumed ATOMICALLY
 * on real Redis (Review Focus 4 — the invite link double-clicked or opened in
 * two tabs gives exactly one activation).
 *
 * Before W2 the invite token was read and deleted in two round trips, so two
 * concurrent consumers could both read it. The Lua GET+DEL runs as one
 * server-side step.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalCapabilityTokens.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { __testOnly } from '../../routes/portal/capabilityTokens';
import { closeRedis, getRedis } from '../../services/redis';

const RUN = !!process.env.REDIS_URL;

describe.skipIf(!RUN)('portal capability token consume against real Redis', () => {
  afterAll(async () => { await closeRedis(); });

  it('two concurrent consumes of one token: exactly one wins', async () => {
    const redis = getRedis()!;
    const key = `portal:invite:${randomUUID()}`;
    await redis.set(key, '{"v":2}', 'EX', 60);
    const [a, b] = await Promise.all([
      __testOnly.consumeFromRedis(redis, key),
      __testOnly.consumeFromRedis(redis, key),
    ]);
    expect([a, b].filter(Boolean)).toEqual(['{"v":2}']);
    expect(await redis.exists(key)).toBe(0);
  });

  it('many concurrent consumes still yield exactly one value', async () => {
    const redis = getRedis()!;
    const key = `portal:reset:${randomUUID()}`;
    await redis.set(key, 'payload', 'EX', 60);
    const results = await Promise.all(Array.from({ length: 20 }, () => __testOnly.consumeFromRedis(redis, key)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('a missing key consumes to null', async () => {
    expect(await __testOnly.consumeFromRedis(getRedis()!, `portal:invite:${randomUUID()}`)).toBeNull();
  });
});
