/**
 * The per-partner + global import lease (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.8, §8 W4 row) against real Redis: the Lua acquire / renew / release over
 * both ZSETs.
 *
 * Proves: the cap per partner (1) and the global cap; a renewing holder keeps
 * both keys alive past several lease lengths; a crashed holder (no heartbeat,
 * no release) frees its slot within one lease, and its late renewal reports
 * the lease lost; release frees both keys at once; with no Redis nothing is
 * acquired (fail closed). Review #4: a partner refused a global slot gets
 * the next freed slot before the successor of a finishing slice, and a waiter
 * that stopped retrying is forgotten. Review #12: every time is Redis's own,
 * so a skewed API clock can neither evict a live lease nor extend one.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getRedis } from '../../services/redis';
import {
  acquireImportLease,
  renewImportLeaseOnce,
  ticketImportPartnerLeaseKey,
  TICKET_IMPORT_GLOBAL_LEASE_KEY,
  TICKET_IMPORT_LEASE_WAITERS_KEY,
} from '../../services/ticketImport/importLease';

const runRedis = it.runIf(!!process.env.REDIS_URL || !!process.env.DATABASE_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ticket import lease (real Redis)', () => {
  runRedis('caps one slice per partner and the global count across partners', async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const a1 = await acquireImportLease({ partnerId: a, globalCap: 2, leaseMs: 5_000 });
    expect(a1).not.toBeNull();
    // A second slice of the same partner waits.
    expect(await acquireImportLease({ partnerId: a, globalCap: 2, leaseMs: 5_000 })).toBeNull();
    const b1 = await acquireImportLease({ partnerId: b, globalCap: 2, leaseMs: 5_000 });
    expect(b1).not.toBeNull();
    // A third partner is refused by the global cap.
    expect(await acquireImportLease({ partnerId: c, globalCap: 2, leaseMs: 5_000 })).toBeNull();
    const redis = getRedis()!;
    expect(await redis.zcard(TICKET_IMPORT_GLOBAL_LEASE_KEY)).toBe(2);
    expect(await redis.zcard(ticketImportPartnerLeaseKey(a))).toBe(1);

    await a1!.release();
    const c1 = await acquireImportLease({ partnerId: c, globalCap: 2, leaseMs: 5_000 });
    expect(c1).not.toBeNull();
    await b1!.release();
    await c1!.release();
  });

  runRedis('a renewing holder keeps both keys alive past several lease lengths', async () => {
    const partner = randomUUID();
    const lease = await acquireImportLease({ partnerId: partner, globalCap: 2, leaseMs: 300, renewEveryMs: 80 });
    expect(lease).not.toBeNull();
    await sleep(1_200); // four lease lengths
    expect(lease!.held()).toBe(true);
    const redis = getRedis()!;
    expect(await redis.pttl(ticketImportPartnerLeaseKey(partner))).toBeGreaterThan(0);
    expect(await redis.pttl(TICKET_IMPORT_GLOBAL_LEASE_KEY)).toBeGreaterThan(0);
    expect(await redis.zscore(ticketImportPartnerLeaseKey(partner), lease!.token)).not.toBeNull();
    expect(await redis.zscore(TICKET_IMPORT_GLOBAL_LEASE_KEY, lease!.token)).not.toBeNull();
    expect(await acquireImportLease({ partnerId: partner, globalCap: 2, leaseMs: 300 })).toBeNull();
    await lease!.release();
  });

  runRedis('a crashed holder frees its slot within one lease, and a late renewal finds it lost', async () => {
    const partner = randomUUID();
    // No heartbeat before expiry and no release: the process died.
    const crashed = await acquireImportLease({ partnerId: partner, globalCap: 2, leaseMs: 250, renewEveryMs: 60_000 });
    expect(crashed).not.toBeNull();
    expect(await acquireImportLease({ partnerId: partner, globalCap: 2, leaseMs: 250 })).toBeNull();
    await sleep(400);
    const next = await acquireImportLease({ partnerId: partner, globalCap: 2, leaseMs: 5_000 });
    expect(next).not.toBeNull();
    const redis = getRedis()!;
    expect(await renewImportLeaseOnce(redis, partner, crashed!.token, 250)).toBe(false);
    // The successor's token is untouched by the stale renewal.
    expect(await redis.zscore(ticketImportPartnerLeaseKey(partner), next!.token)).not.toBeNull();
    await next!.release();
    await crashed!.release();
  });

  runRedis('renewal reports a lease lost when its token left either key', async () => {
    const partner = randomUUID();
    const lease = await acquireImportLease({ partnerId: partner, globalCap: 2, leaseMs: 5_000, renewEveryMs: 50 });
    const redis = getRedis()!;
    await redis.zrem(TICKET_IMPORT_GLOBAL_LEASE_KEY, lease!.token);
    await sleep(200);
    expect(lease!.held()).toBe(false);
    // The lost renewal also cleared the partner key.
    expect(await redis.zscore(ticketImportPartnerLeaseKey(partner), lease!.token)).toBeNull();
    await lease!.release();
  });

  runRedis('release removes the token from both keys at once', async () => {
    const partner = randomUUID();
    const lease = await acquireImportLease({ partnerId: partner, globalCap: 1, leaseMs: 60_000 });
    await lease!.release();
    const redis = getRedis()!;
    expect(await redis.zscore(ticketImportPartnerLeaseKey(partner), lease!.token)).toBeNull();
    expect(await redis.zscore(TICKET_IMPORT_GLOBAL_LEASE_KEY, lease!.token)).toBeNull();
    expect(lease!.held()).toBe(false);
    const again = await acquireImportLease({ partnerId: partner, globalCap: 1, leaseMs: 60_000 });
    expect(again).not.toBeNull();
    await again!.release();
  });

  runRedis('is fair: a partner refused by the global cap gets the next freed slot before a finishing slice\'s successor', async () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const a1 = await acquireImportLease({ partnerId: a, globalCap: 2, leaseMs: 5_000 });
    const b1 = await acquireImportLease({ partnerId: b, globalCap: 2, leaseMs: 5_000 });
    expect(a1).not.toBeNull();
    expect(b1).not.toBeNull();
    // C is refused and queued.
    expect(await acquireImportLease({ partnerId: c, globalCap: 2, leaseMs: 5_000 })).toBeNull();
    expect(await getRedis()!.zscore(TICKET_IMPORT_LEASE_WAITERS_KEY, c)).not.toBeNull();

    // A's slice finishes; its successor asks at once and must wait behind C.
    await a1!.release();
    expect(await acquireImportLease({ partnerId: a, globalCap: 2, leaseMs: 5_000 })).toBeNull();
    const c1 = await acquireImportLease({ partnerId: c, globalCap: 2, leaseMs: 5_000 });
    expect(c1).not.toBeNull();
    expect(await getRedis()!.zscore(TICKET_IMPORT_LEASE_WAITERS_KEY, c)).toBeNull();

    // The next slot is A's, now the oldest waiter.
    await b1!.release();
    const a2 = await acquireImportLease({ partnerId: a, globalCap: 2, leaseMs: 5_000 });
    expect(a2).not.toBeNull();
    await c1!.release();
    await a2!.release();
  });

  runRedis('forgets a waiter that stopped retrying, so it cannot block the rest', async () => {
    const [a, c, d] = [randomUUID(), randomUUID(), randomUUID()];
    const a1 = await acquireImportLease({ partnerId: a, globalCap: 1, leaseMs: 5_000 });
    expect(await acquireImportLease({ partnerId: c, globalCap: 1, leaseMs: 5_000, waiterTtlMs: 200 })).toBeNull();
    await a1!.release();
    await sleep(350);
    // C never came back: D takes the free slot.
    const d1 = await acquireImportLease({ partnerId: d, globalCap: 1, leaseMs: 5_000, waiterTtlMs: 200 });
    expect(d1).not.toBeNull();
    expect(await getRedis()!.zscore(TICKET_IMPORT_LEASE_WAITERS_KEY, c)).toBeNull();
    await d1!.release();
  });

  runRedis('uses Redis time: a client clock an hour ahead or behind changes nothing', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const a1 = await acquireImportLease({ partnerId: a, globalCap: 2, leaseMs: 5_000, renewEveryMs: 60_000 });
    const realNow = Date.now.bind(Date);
    // An instance an hour ahead would have evicted A's live lease with a client clock.
    const ahead = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 3_600_000);
    const b1 = await acquireImportLease({ partnerId: b, globalCap: 2, leaseMs: 5_000, renewEveryMs: 60_000 });
    ahead.mockRestore();
    expect(b1).not.toBeNull();
    const redis = getRedis()!;
    expect(await redis.zscore(TICKET_IMPORT_GLOBAL_LEASE_KEY, a1!.token)).not.toBeNull();
    expect(await renewImportLeaseOnce(redis, a, a1!.token, 5_000)).toBe(true);
    // An instance an hour behind cannot hold a lease past its real expiry.
    const behind = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 3_600_000);
    const c = randomUUID();
    const short = await acquireImportLease({ partnerId: c, globalCap: 3, leaseMs: 200, renewEveryMs: 60_000 });
    behind.mockRestore();
    expect(short).not.toBeNull();
    await sleep(350);
    expect(await renewImportLeaseOnce(redis, c, short!.token, 200)).toBe(false);
    await a1!.release();
    await b1!.release();
    await short!.release();
  });

  runRedis('fails closed without Redis', async () => {
    expect(await acquireImportLease({ partnerId: randomUUID(), globalCap: 2, leaseMs: 1_000, redis: null })).toBeNull();
  });
});
