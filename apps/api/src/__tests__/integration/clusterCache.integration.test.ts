/**
 * W05 (#8144) acceptance — spec W1b: "A cache test proves a write on instance A
 * invalidates instance B within 1 s."
 *
 * Two cluster cache buses in one process stand in for two API instances: each
 * has its own origin, its own publisher and its own subscriber connection to
 * the one real Redis. Each test builds `cacheA` (on bus A) and `cacheB` (on bus
 * B) under the same unique cache name.
 *
 * Negative assertions ("B did NOT drop it") use an ordering probe: Redis
 * delivers one channel's messages in publish order, so once a sentinel
 * published afterwards has been applied on B, anything published before it
 * would already have arrived.
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { HotPathTtlCache } from '../../services/hotPathCache';
import {
  ClusterCacheBus,
  type PublisherLike,
  type SubscriberLike,
} from '../../services/clusterCacheBus';
import { metricsRegistry } from '../../services/metricsRegistry';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (pred()) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function metricValue(metric: string, labels: Record<string, string>): Promise<number> {
  const m = metricsRegistry.getSingleMetric(metric);
  if (!m) return 0;
  const { values } = await m.get();
  const hit = values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return hit?.value ?? 0;
}

describe('cluster cache — cross-instance invalidation (W05 #8144)', () => {
  let connections: Redis[];
  let buses: ClusterCacheBus[];
  let busA: ClusterCacheBus;
  let busB: ClusterCacheBus;
  let subscriberB: Redis;
  let name: string;
  let cacheA: HotPathTtlCache<string, string>;
  let cacheB: HotPathTtlCache<string, string>;

  function instance(origin: string): { bus: ClusterCacheBus; subscriber: Redis } {
    const publisher = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    // lazyConnect like getRedis().duplicate(): the bus's listeners exist before the first `ready`.
    const subscriber = new Redis(REDIS_URL, { lazyConnect: true });
    connections.push(publisher, subscriber);
    const bus = new ClusterCacheBus({
      origin,
      getPublisher: () => publisher as unknown as PublisherLike,
      createSubscriber: () => subscriber as unknown as SubscriberLike,
    });
    buses.push(bus);
    return { bus, subscriber };
  }

  async function seed(cache: HotPathTtlCache<string, string>, key: string, value: string): Promise<void> {
    await cache.getOrLoad(key, async () => value);
    expect(cache.peek(key)).toBe(value);
  }

  /**
   * Ordering probe: publish a sentinel from A and wait until B has applied it.
   * Seed it first (outside any DB context: getOrLoad bypasses the cache inside one).
   */
  async function seedSentinel(): Promise<void> {
    await seed(cacheB, 'sentinel', 's');
  }
  async function sentinelRoundTrip(): Promise<void> {
    await busA.publish(name, 'sentinel');
    await waitUntil(() => cacheB.peek('sentinel') === undefined, 1_000);
  }

  beforeEach(async () => {
    connections = [];
    buses = [];
    const a = instance('inst-a');
    const b = instance('inst-b');
    busA = a.bus;
    busB = b.bus;
    subscriberB = b.subscriber;
    name = `cc-it-${randomUUID()}`;
    cacheA = new HotPathTtlCache<string, string>({ name, ttlMs: 60_000, maxEntries: 100, cluster: { bus: busA } });
    cacheB = new HotPathTtlCache<string, string>({ name, ttlMs: 60_000, maxEntries: 100, cluster: { bus: busB } });
    expect(await busA.start()).toBe('subscribed');
    expect(await busB.start()).toBe('subscribed');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const bus of buses) await bus.stop();
    for (const conn of connections) conn.disconnect();
  });

  it('a write on A invalidates B within 1 s, and only that key', async () => {
    await seed(cacheA, 'org-1', 'v1');
    await seed(cacheB, 'org-1', 'v1');
    await seed(cacheB, 'org-2', 'v2');

    cacheA.invalidateAroundCommit('org-1');
    const ms = await waitUntil(() => cacheB.peek('org-1') === undefined, 1_000);
    console.info('[clusterCache.it] A→B invalidation ms=', ms);

    expect(ms).toBeLessThanOrEqual(1_000);
    expect(cacheB.peek('org-2')).toBe('v2');
  });

  it('a whole-cache invalidation on A clears every key on B within 1 s', async () => {
    await seed(cacheB, 'org-1', 'v1');
    await seed(cacheB, 'org-2', 'v2');
    cacheA.invalidateAroundCommit();
    await waitUntil(() => cacheB.size === 0, 1_000);
  });

  it('the publish waits for COMMIT', async () => {
    await seed(cacheB, 'org-1', 'v1');
    await seedSentinel();
    await withSystemDbAccessContext(async () => {
      cacheA.invalidateAroundCommit('org-1');
      await sentinelRoundTrip();
      // Still inside the transaction: B must not have dropped org-1 yet.
      expect(cacheB.peek('org-1')).toBe('v1');
    });
    await waitUntil(() => cacheB.peek('org-1') === undefined, 1_000);
  });

  it('a rollback publishes nothing', async () => {
    await seed(cacheB, 'org-1', 'v1');
    await expect(
      withSystemDbAccessContext(async () => {
        cacheA.invalidateAroundCommit('org-1');
        throw new Error('rollback-for-test');
      }),
    ).rejects.toThrow('rollback-for-test');
    await seedSentinel();
    await sentinelRoundTrip();
    expect(cacheB.peek('org-1')).toBe('v1');
  });

  it('a load in flight on B when the invalidation lands is returned but not stored', async () => {
    const applied = vi.spyOn(cacheB, 'invalidate');
    let release!: (value: string) => void;
    const loading = cacheB.getOrLoad('org-3', () => new Promise<string>((resolve) => { release = resolve; }));

    cacheA.invalidateAroundCommit('org-3');
    await waitUntil(() => applied.mock.calls.some((call) => call[0] === 'org-3'), 1_000);
    release('stale');

    await expect(loading).resolves.toBe('stale');
    expect(cacheB.peek('org-3')).toBeUndefined();
  });

  it('an instance ignores its own echo', async () => {
    await seed(cacheA, 'org-1', 'v1');
    await seed(cacheB, 'org-1', 'v1');
    const onA = vi.spyOn(cacheA, 'invalidate');
    const onB = vi.spyOn(cacheB, 'invalidate');

    cacheA.invalidateAroundCommit('org-1');
    await waitUntil(() => onB.mock.calls.length > 0, 1_000);
    expect(onB.mock.calls).toEqual([['org-1']]);

    // B → A sentinel: once A has applied it, A's own echo (published earlier) would have arrived too.
    await seed(cacheA, 'sentinel', 's');
    await busB.publish(name, 'sentinel');
    await waitUntil(() => cacheA.peek('sentinel') === undefined, 1_000);

    // A's own two drops (immediate + after-exit), then B's sentinel — no third 'org-1' from its echo.
    expect(onA.mock.calls).toEqual([['org-1'], ['org-1'], ['sentinel']]);
  });

  it('a subscriber reconnect clears the cache once (messages in the gap are lost)', async () => {
    const before = await metricValue('breeze_cluster_cache_resyncs_total', {});
    await seed(cacheB, 'org-1', 'v1');
    subscriberB.disconnect(true);
    await waitUntil(() => cacheB.size === 0, 5_000);
    expect(await metricValue('breeze_cluster_cache_resyncs_total', {})).toBeGreaterThan(before);

    // And it is subscribed again: a fresh write on A still reaches B.
    await waitUntil(() => busB.subscribed, 5_000);
    await seed(cacheB, 'org-2', 'v2');
    cacheA.invalidateAroundCommit('org-2');
    await waitUntil(() => cacheB.peek('org-2') === undefined, 1_000);
  });

  it('degraded: without Redis, start() is unavailable and a write still drops locally without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const offline = new ClusterCacheBus({ origin: 'inst-offline', getPublisher: () => null, createSubscriber: () => null });
    buses.push(offline);
    const offlineName = `cc-it-offline-${randomUUID()}`;
    const cache = new HotPathTtlCache<string, string>({ name: offlineName, ttlMs: 60_000, maxEntries: 10, cluster: { bus: offline } });
    expect(await offline.start()).toBe('unavailable');

    await seed(cache, 'org-1', 'v1');
    expect(() => cache.invalidateAroundCommit('org-1')).not.toThrow();
    expect(cache.peek('org-1')).toBeUndefined();
    const labels = { cache: offlineName, outcome: 'unavailable' };
    await vi.waitFor(async () => {
      expect(await metricValue('breeze_cluster_cache_invalidations_published_total', labels)).toBe(1);
    }, { timeout: 1_000 });
    warn.mockRestore();
  });
});
