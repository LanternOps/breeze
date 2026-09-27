/**
 * Real-Redis proof of the accounting limiter's Lua scripts
 * (services/accounting/accountingRateLimit.ts). The unit suite mocks `eval`, so
 * only this file shows the ZSET lease semaphore actually caps concurrency,
 * frees slots on release, and reclaims a lease a crashed process never released.
 *
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/accountingRateLimit.integration.test.ts
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { withProviderCallSlot } from '../../services/accounting/accountingRateLimit';
import { closeRedis, getRedis } from '../../services/redis';

const RUN = !!process.env.REDIS_URL;
const spec = { perConnection: { limit: 1000, windowSeconds: 60 }, maxConcurrentPerConnection: 2, appWide: null, dailyPerConnection: null };

describe.skipIf(!RUN)('accountingRateLimit against real Redis', () => {
  afterAll(async () => { await closeRedis(); });

  it('admits at most maxConcurrentPerConnection concurrent calls and frees slots afterwards', async () => {
    const conn = `it-${Date.now()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = withProviderCallSlot('xero', spec, conn, () => gate);
    const b = withProviderCallSlot('xero', spec, conn, () => gate);
    await new Promise((r) => setTimeout(r, 50));
    await expect(withProviderCallSlot('xero', spec, conn, async () => 'third')).rejects.toMatchObject({ kind: 'rate_limited' });
    release();
    await Promise.all([a, b]);
    expect(await getRedis()!.zcard(`acct-rl:xero:inflight:${conn}`)).toBe(0);
    await expect(withProviderCallSlot('xero', spec, conn, async () => 'after')).resolves.toBe('after');
  });

  it('reclaims leaked leases a crashed process never released', async () => {
    const conn = `it-leak-${Date.now()}`;
    const key = `acct-rl:xero:inflight:${conn}`;
    const redis = getRedis()!;
    // Two leases whose expiry has already passed fill the cap (2) — exactly
    // what a process that died mid-call leaves behind — plus a TTL on the key
    // far in the future, as steady traffic would keep refreshing it.
    const past = Date.now() - 1_000;
    await redis.zadd(key, past, 'crashed-a', past, 'crashed-b');
    await redis.pexpire(key, 600_000);
    expect(await redis.zcard(key)).toBe(2);

    // Negative control: a LIVE lease (expiry in the future) is not reclaimed,
    // so the cap still binds when both slots are genuinely held.
    const liveKey = `acct-rl:xero:inflight:${conn}-live`;
    const future = Date.now() + 60_000;
    await redis.zadd(liveKey, future, 'live-a', future, 'live-b');
    await expect(withProviderCallSlot('xero', spec, `${conn}-live`, async () => 'x')).rejects.toMatchObject({ kind: 'rate_limited' });

    await expect(withProviderCallSlot('xero', spec, conn, async () => 'reclaimed')).resolves.toBe('reclaimed');
    // The expired members were dropped, and this call's own lease was released.
    expect(await redis.zcard(key)).toBe(0);
  });
});
