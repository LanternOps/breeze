import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_CACHE_CHANNEL,
  ClusterCacheBus,
  decodeInvalidation,
  encodeInvalidation,
  type ClusterCacheBusOptions,
  type ClusterInvalidationMessage,
  type PublisherLike,
  type SubscriberLike,
} from './clusterCacheBus';
import { registerClusterCache } from './clusterCacheRegistry';
import { metricsRegistry } from './metricsRegistry';

type SubscribeMode = 'resolve' | 'reject' | 'deferred';

class FakeSubscriber extends EventEmitter {
  mode: SubscribeMode = 'resolve';
  deferreds: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  subscribe = vi.fn((_channel: string): Promise<unknown> => {
    if (this.mode === 'resolve') return Promise.resolve(1);
    if (this.mode === 'reject') return Promise.reject(new Error('subscribe refused'));
    return new Promise((resolve, reject) => this.deferreds.push({ resolve, reject }));
  });
  quit = vi.fn(async () => 'OK');
  disconnect = vi.fn();
  deliver(raw: string, channel = CLUSTER_CACHE_CHANNEL): void {
    this.emit('message', channel, raw);
  }
}

function target(name: string) {
  return { name, invalidate: vi.fn((_key?: string) => {}) };
}

function msg(over: Partial<ClusterInvalidationMessage> = {}): ClusterInvalidationMessage {
  return { v: 1, cache: 'c1', key: 'org-1', origin: 'other', sentAtMs: 1_000, ...over };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeBus(over: Partial<ClusterCacheBusOptions> = {}) {
  const sub = new FakeSubscriber();
  const published: Array<[string, string]> = [];
  const publisher: PublisherLike = {
    publish: vi.fn(async (channel: string, message: string) => {
      published.push([channel, message]);
      return 1;
    }),
  };
  const bus = new ClusterCacheBus({
    origin: 'self',
    getPublisher: () => publisher,
    createSubscriber: () => sub as unknown as SubscriberLike,
    now: () => 1_500,
    ...over,
  });
  return { bus, sub, publisher, published };
}

describe('decodeInvalidation (#8144)', () => {
  it('round-trips a valid message, including key null', () => {
    expect(decodeInvalidation(encodeInvalidation(msg()))).toEqual(msg());
    expect(decodeInvalidation(encodeInvalidation(msg({ key: null })))).toEqual(msg({ key: null }));
  });

  it.each([
    ['bad JSON', '{nope'],
    ['not an object', '"x"'],
    ['v !== 1', JSON.stringify({ ...msg(), v: 2 })],
    ['missing cache', JSON.stringify({ ...msg(), cache: undefined })],
    ['empty cache', JSON.stringify({ ...msg(), cache: '' })],
    ['numeric key', JSON.stringify({ ...msg(), key: 42 })],
    ['missing key', JSON.stringify({ v: 1, cache: 'c1', origin: 'o', sentAtMs: 1 })],
    ['key over 256 chars', JSON.stringify({ ...msg(), key: 'k'.repeat(257) })],
    ['missing origin', JSON.stringify({ ...msg(), origin: undefined })],
    ['non-finite sentAtMs', JSON.stringify({ ...msg(), sentAtMs: 'soon' })],
  ])('rejects %s', (_label, raw) => {
    expect(decodeInvalidation(raw)).toBeNull();
  });

  it('accepts a key of exactly 256 chars', () => {
    expect(decodeInvalidation(encodeInvalidation(msg({ key: 'k'.repeat(256) })))?.key).toHaveLength(256);
  });
});

describe('process default bus (#8144)', () => {
  it('publishes on the shared getRedis() client with INSTANCE_ID as origin', async () => {
    const { getClusterCacheBus } = await import('./clusterCacheBus');
    const { INSTANCE_ID } = await import('./instanceIdentity');
    const { getRedis } = await import('./redis');
    const shared = getRedis() as unknown as { publish: ReturnType<typeof vi.fn> };
    shared.publish.mockClear();
    await expect(getClusterCacheBus().publish('factory-test', 'org-1')).resolves.toBe('published');
    const [channel, raw] = shared.publish.mock.calls[0]!;
    expect(channel).toBe(CLUSTER_CACHE_CHANNEL);
    expect(decodeInvalidation(raw as string)).toMatchObject({ cache: 'factory-test', key: 'org-1', origin: INSTANCE_ID });
  });

  it('subscribes on its own duplicate() named breeze:cluster-cache', async () => {
    const { getRedis } = await import('./redis');
    const sub = new FakeSubscriber();
    const duplicate = vi.fn(() => sub);
    const shared = getRedis() as unknown as Record<string, unknown>;
    shared.duplicate = duplicate;
    try {
      const { getClusterCacheBus } = await import('./clusterCacheBus');
      const bus = getClusterCacheBus();
      await expect(bus.start()).resolves.toBe('subscribed');
      expect(duplicate).toHaveBeenCalledWith({ connectionName: 'breeze:cluster-cache' });
      expect(sub.subscribe).toHaveBeenCalledWith(CLUSTER_CACHE_CHANNEL);
      await bus.stop();
    } finally {
      delete shared.duplicate;
    }
  });
});

describe('ClusterCacheBus construction (#8144)', () => {
  it('rejects an empty origin (every receiver would drop its messages as malformed)', () => {
    expect(() => makeBus({ origin: '' })).toThrow(/origin/);
  });
});

describe('ClusterCacheBus.publish (#8144)', () => {
  afterEach(() => vi.useRealTimers());

  it('publishes the encoded message on the channel', async () => {
    const { bus, published } = makeBus();
    await expect(bus.publish('c1', 'org-1')).resolves.toBe('published');
    expect(published).toEqual([
      [CLUSTER_CACHE_CHANNEL, encodeInvalidation({ v: 1, cache: 'c1', key: 'org-1', origin: 'self', sentAtMs: 1_500 })],
    ]);
  });

  it('returns unavailable with no publisher', async () => {
    const { bus } = makeBus({ getPublisher: () => null });
    await expect(bus.publish('c1', 'org-1')).resolves.toBe('unavailable');
  });

  it('returns failed when publish rejects or getPublisher throws', async () => {
    const { bus } = makeBus({ getPublisher: () => ({ publish: () => Promise.reject(new Error('boom')) }) });
    await expect(bus.publish('c1', 'org-1')).resolves.toBe('failed');
    const { bus: bus2 } = makeBus({ getPublisher: () => { throw new Error('getter'); } });
    await expect(bus2.publish('c1', null)).resolves.toBe('failed');
  });

  it('returns failed when publish never settles within publishTimeoutMs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { bus } = makeBus({ getPublisher: () => ({ publish: () => new Promise<number>(() => {}) }), publishTimeoutMs: 1_000 });
    const pending = bus.publish('c1', 'org-1');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe('failed');
  });

  it('counts each outcome on the published series', async () => {
    const { bus } = makeBus({ getPublisher: () => null });
    await bus.publish('count-me', 'org-1');
    const text = await metricsRegistry.getSingleMetricAsString('breeze_cluster_cache_invalidations_published_total');
    expect(text).toContain('cache="count-me",outcome="unavailable"} 1');
  });

  it('widens an oversize key to a whole-cache invalidation instead of sending one receivers drop', async () => {
    const { bus, published } = makeBus();
    await bus.publish('c1', 'k'.repeat(300));
    expect(decodeInvalidation(published[0]![1])?.key).toBeNull();
  });
});

describe('ClusterCacheBus receive (#8144)', () => {
  it('invalidates the attached target by key, and the whole cache for key null', async () => {
    const { bus, sub } = makeBus();
    const t = target('c1');
    bus.attach(t);
    await bus.start();
    sub.deliver(encodeInvalidation(msg()));
    sub.deliver(encodeInvalidation(msg({ key: null })));
    expect(t.invalidate).toHaveBeenNthCalledWith(1, 'org-1');
    expect(t.invalidate).toHaveBeenNthCalledWith(2);
    expect(t.invalidate.mock.calls[1]).toHaveLength(0);
  });

  it('ignores its own origin', async () => {
    const { bus, sub } = makeBus();
    const t = target('c1');
    bus.attach(t);
    await bus.start();
    sub.deliver(encodeInvalidation(msg({ origin: 'self' })));
    expect(t.invalidate).not.toHaveBeenCalled();
  });

  it('drops unknown caches, malformed messages and other channels without throwing', async () => {
    const { bus, sub } = makeBus();
    const t = target('c1');
    bus.attach(t);
    await bus.start();
    expect(() => sub.deliver(encodeInvalidation(msg({ cache: 'nobody' })))).not.toThrow();
    expect(() => sub.deliver('{garbage')).not.toThrow();
    expect(() => sub.deliver(encodeInvalidation(msg()), 'some-other-channel')).not.toThrow();
    expect(t.invalidate).not.toHaveBeenCalled();
  });

  it('attach replaces a target with the same name', async () => {
    const { bus, sub } = makeBus();
    const first = target('c1');
    const second = target('c1');
    bus.attach(first);
    bus.attach(second);
    await bus.start();
    sub.deliver(encodeInvalidation(msg()));
    expect(first.invalidate).not.toHaveBeenCalled();
    expect(second.invalidate).toHaveBeenCalledWith('org-1');
  });

  it('a throwing target does not escape the message handler, and is counted as error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bus, sub } = makeBus();
    bus.attach({ name: 'throws-on-receive', invalidate: () => { throw new Error('bad cache'); } });
    await bus.start();
    expect(() => sub.deliver(encodeInvalidation(msg({ cache: 'throws-on-receive' })))).not.toThrow();
    const text = await metricsRegistry.getSingleMetricAsString('breeze_cluster_cache_invalidations_received_total');
    expect(text).toContain('cache="throws-on-receive",result="error"} 1');
    err.mockRestore();
  });

  it('finds targets through clusterCacheRegistry when nothing is attached', async () => {
    const { bus, sub } = makeBus();
    const t = target('registry-only-target');
    registerClusterCache(t);
    await bus.start();
    sub.deliver(encodeInvalidation(msg({ cache: 'registry-only-target' })));
    expect(t.invalidate).toHaveBeenCalledWith('org-1');
  });
});

describe('ClusterCacheBus.start (#8144)', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves subscribed, and returns the same promise when called twice', async () => {
    const { bus, sub } = makeBus();
    const p1 = bus.start();
    expect(bus.start()).toBe(p1);
    await expect(p1).resolves.toBe('subscribed');
    expect(bus.subscribed).toBe(true);
    expect(sub.subscribe).toHaveBeenCalledTimes(1);
    expect(sub.subscribe).toHaveBeenCalledWith(CLUSTER_CACHE_CHANNEL);
  });

  it('resolves unavailable without a subscriber', async () => {
    const { bus } = makeBus({ createSubscriber: () => null });
    await expect(bus.start()).resolves.toBe('unavailable');
    expect(bus.subscribed).toBe(false);
  });

  it('resolves failed and disconnects when subscribe rejects', async () => {
    const { bus, sub } = makeBus();
    sub.mode = 'reject';
    await expect(bus.start()).resolves.toBe('failed');
    expect(sub.disconnect).toHaveBeenCalled();
    expect(bus.subscribed).toBe(false);
  });

  it('on timeout keeps the subscriber, and a late subscribe resolves into a resync (D9)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { bus, sub } = makeBus({ subscribeTimeoutMs: 1_000 });
    const t = target('c1');
    bus.attach(t);
    sub.mode = 'deferred';
    const started = bus.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(started).resolves.toBe('timeout');
    expect(sub.disconnect).not.toHaveBeenCalled();
    expect(sub.quit).not.toHaveBeenCalled();
    expect(bus.subscribed).toBe(false);

    sub.deferreds[0]!.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(bus.subscribed).toBe(true);
    expect(t.invalidate).toHaveBeenCalledTimes(1);
    expect(t.invalidate.mock.calls[0]).toHaveLength(0);
  });

  it('a late rejection after the timeout raises no unhandled rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { bus, sub } = makeBus({ subscribeTimeoutMs: 1_000 });
      sub.mode = 'deferred';
      const started = bus.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(started).resolves.toBe('timeout');
      sub.deferreds[0]!.reject(new Error('late refusal'));
      vi.useRealTimers();
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      expect(bus.subscribed).toBe(false);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('ClusterCacheBus reconnect resync (D6, #8144)', () => {
  let bus: ClusterCacheBus;
  let sub: FakeSubscriber;
  let t1: ReturnType<typeof target>;
  let t2: ReturnType<typeof target>;

  beforeEach(() => {
    ({ bus, sub } = makeBus());
    t1 = target('c1');
    t2 = target('c2');
    bus.attach(t1);
    bus.attach(t2);
  });

  it('the first ready, even while the first subscribe is pending, clears nothing', async () => {
    sub.mode = 'deferred';
    const started = bus.start();
    sub.emit('ready');
    sub.deferreds[0]!.resolve(1);
    await expect(started).resolves.toBe('subscribed');
    await flush();
    expect(t1.invalidate).not.toHaveBeenCalled();
    expect(sub.subscribe).toHaveBeenCalledTimes(1);
  });

  it('a subscriber already connected at start() treats its next ready as a reconnect', async () => {
    (sub as unknown as { status: string }).status = 'ready';
    await bus.start();
    sub.emit('ready');
    await flush();
    expect(sub.subscribe).toHaveBeenCalledTimes(2);
    expect(t1.invalidate).toHaveBeenCalledTimes(1);
  });

  it('a later ready re-subscribes, and clears every target only once the subscribe resolves', async () => {
    await bus.start();
    sub.emit('ready');
    sub.mode = 'deferred';
    sub.emit('close');
    expect(bus.subscribed).toBe(false);
    sub.emit('ready');
    await flush();
    expect(sub.subscribe).toHaveBeenCalledTimes(2);
    expect(t1.invalidate).not.toHaveBeenCalled();
    sub.deferreds[0]!.resolve(1);
    await flush();
    expect(t1.invalidate).toHaveBeenCalledTimes(1);
    expect(t2.invalidate).toHaveBeenCalledTimes(1);
    expect(bus.subscribed).toBe(true);
  });

  it('two reconnects produce two clears, and the resync series moves', async () => {
    const before = (await metricsRegistry.getSingleMetric('breeze_cluster_cache_resyncs_total')!.get()).values[0]?.value ?? 0;
    await bus.start();
    sub.emit('ready');
    sub.emit('ready');
    await flush();
    sub.emit('ready');
    await flush();
    expect(t1.invalidate).toHaveBeenCalledTimes(2);
    const after = (await metricsRegistry.getSingleMetric('breeze_cluster_cache_resyncs_total')!.get()).values[0]?.value ?? 0;
    expect(after - before).toBe(2);
  });

  it('a throwing target does not stop the resync of the others', async () => {
    bus.attach({ name: 'c1', invalidate: () => { throw new Error('bad'); } });
    await bus.start();
    sub.emit('ready');
    sub.emit('ready');
    await flush();
    expect(t2.invalidate).toHaveBeenCalledTimes(1);
  });

  it('a failed re-subscribe leaves the bus unsubscribed and clears nothing', async () => {
    await bus.start();
    sub.emit('ready');
    sub.mode = 'reject';
    sub.emit('ready');
    await flush();
    expect(bus.subscribed).toBe(false);
    expect(t1.invalidate).not.toHaveBeenCalled();
  });

  it('after stop(), a late ready or message invalidates nothing', async () => {
    await bus.start();
    sub.emit('ready');
    await bus.stop();
    expect(sub.quit).toHaveBeenCalled();
    expect(bus.subscribed).toBe(false);
    sub.emit('ready');
    sub.deliver(encodeInvalidation(msg()));
    await flush();
    expect(t1.invalidate).not.toHaveBeenCalled();
    expect(sub.subscribe).toHaveBeenCalledTimes(1);
  });

  it('stop() falls back to disconnect() when quit() rejects', async () => {
    await bus.start();
    sub.quit.mockRejectedValueOnce(new Error('EPIPE'));
    await expect(bus.stop()).resolves.toBeUndefined();
    expect(sub.disconnect).toHaveBeenCalled();
  });
});
