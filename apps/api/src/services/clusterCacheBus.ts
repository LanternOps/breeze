/**
 * Cluster cache invalidation bus (W05, #8144; spec W1b).
 *
 * A write on one API instance drops the matching hot-path cache entry on every
 * other instance, over one Redis pub/sub channel. Messages carry a cache name
 * and a key (an id, or null for the whole cache) — never a value (spec §7): the
 * receiver only drops entries, and its next read reloads under its own context.
 *
 * Delivery is at-most-once. The guarantees this module keeps:
 *
 * - **Never throws, never blocks a writer for long.** `publish` is bounded by
 *   CLUSTER_CACHE_PUBLISH_TIMEOUT_MS, and every failure becomes an outcome that
 *   is counted and (rate-limited) logged. Without Redis the caches fall back to
 *   their TTL, which is the pre-W05 behaviour.
 * - **Receive = `invalidate(key)`**, which bumps the cache generation, so a load
 *   already in flight on the receiver is not stored either.
 * - **Reconnect resync (D6).** Messages sent while the subscriber was away are
 *   lost, so every `ready` after the first re-issues SUBSCRIBE, waits for it, and
 *   only then clears every cluster cache once.
 * - **Bounded boot (D9).** `start()` waits at most CLUSTER_CACHE_SUBSCRIBE_TIMEOUT_MS.
 *   On a timeout the subscriber is kept; when the subscribe lands later, the bus
 *   marks itself up and runs the same resync.
 *
 * Publishing is only half the contract: `HotPathTtlCache.invalidateAroundCommit`
 * calls `publish` through `runAfterDbContextCommit`, so nothing is announced
 * before the writer's transaction has committed.
 */
import { INSTANCE_ID } from './instanceIdentity';
import { getRedis } from './redis';
import {
  recordInvalidationLag,
  recordInvalidationPublished,
  recordInvalidationReceived,
  recordResync,
  setSubscriberUp,
  type PublishOutcome,
} from './clusterCacheMetrics';
import { clusterCacheTargets, getClusterCacheTarget, type ClusterCacheTarget } from './clusterCacheRegistry';

export type { PublishOutcome } from './clusterCacheMetrics';
export type { ClusterCacheTarget } from './clusterCacheRegistry';

export const CLUSTER_CACHE_CHANNEL = 'breeze:cluster-cache:invalidate';
export const CLUSTER_CACHE_SUBSCRIBE_TIMEOUT_MS = 1_000;
export const CLUSTER_CACHE_PUBLISH_TIMEOUT_MS = 1_000;
export const CLUSTER_CACHE_MAX_KEY_LENGTH = 256;
/** An applied message slower than this breaks the W1b acceptance (A→B within 1 s). */
const LAG_WARN_SECONDS = 1;
const WARN_INTERVAL_MS = 60_000;

export interface ClusterInvalidationMessage {
  v: 1;
  cache: string;
  /** null = every key of that cache */
  key: string | null;
  origin: string;
  sentAtMs: number;
}

/** The subset of ioredis the bus uses, so tests can pass fakes. */
export interface PublisherLike {
  publish(channel: string, message: string): Promise<number>;
}
export interface SubscriberLike {
  on(event: 'message', fn: (channel: string, message: string) => void): unknown;
  on(event: 'ready' | 'end' | 'close', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  removeListener(event: string, fn: (...args: never[]) => void): unknown;
  subscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export interface ClusterCacheBusOptions {
  origin: string;
  getPublisher: () => PublisherLike | null;
  createSubscriber: () => SubscriberLike | null;
  subscribeTimeoutMs?: number;
  publishTimeoutMs?: number;
  now?: () => number;
  /** Where receive/resync find targets when nothing is attached. Default: clusterCacheRegistry. */
  targets?: () => Iterable<ClusterCacheTarget>;
}

export type StartOutcome = 'subscribed' | 'unavailable' | 'timeout' | 'failed';

export function encodeInvalidation(m: ClusterInvalidationMessage): string {
  return JSON.stringify({ v: m.v, cache: m.cache, key: m.key, origin: m.origin, sentAtMs: m.sentAtMs });
}

export function decodeInvalidation(raw: string): ClusterInvalidationMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (m.v !== 1) return null;
  if (typeof m.cache !== 'string' || m.cache.length === 0) return null;
  if (!('key' in m)) return null;
  const key = m.key;
  if (key !== null && (typeof key !== 'string' || key.length > CLUSTER_CACHE_MAX_KEY_LENGTH)) return null;
  if (typeof m.origin !== 'string' || m.origin.length === 0) return null;
  if (typeof m.sentAtMs !== 'number' || !Number.isFinite(m.sentAtMs)) return null;
  return { v: 1, cache: m.cache, key, origin: m.origin, sentAtMs: m.sentAtMs };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Listener = { event: string; fn: (...args: never[]) => void };

export class ClusterCacheBus {
  private readonly origin: string;
  private readonly getPublisher: () => PublisherLike | null;
  private readonly createSubscriber: () => SubscriberLike | null;
  private readonly subscribeTimeoutMs: number;
  private readonly publishTimeoutMs: number;
  private readonly now: () => number;
  private readonly registryTargets: () => Iterable<ClusterCacheTarget>;
  private readonly attached = new Map<string, ClusterCacheTarget>();
  private readonly lastWarnAt = new Map<string, number>();

  private subscriber: SubscriberLike | null = null;
  private listeners: Listener[] = [];
  private startPromise: Promise<StartOutcome> | null = null;
  private cancelStart: (() => void) | null = null;
  private isSubscribed = false;
  private seenReady = false;
  private initialSubscribeRejected = false;

  constructor(options: ClusterCacheBusOptions) {
    if (typeof options.origin !== 'string' || options.origin.length === 0) {
      // Receivers drop a message without an origin as malformed: the bus would be silently dead.
      throw new Error('ClusterCacheBus: origin must be a non-empty string');
    }
    this.origin = options.origin;
    this.getPublisher = options.getPublisher;
    this.createSubscriber = options.createSubscriber;
    this.subscribeTimeoutMs = options.subscribeTimeoutMs ?? CLUSTER_CACHE_SUBSCRIBE_TIMEOUT_MS;
    this.publishTimeoutMs = options.publishTimeoutMs ?? CLUSTER_CACHE_PUBLISH_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.registryTargets = options.targets ?? clusterCacheTargets;
  }

  get subscribed(): boolean {
    return this.isSubscribed;
  }

  /** Explicit targets (integration tests). Without any, the bus reads clusterCacheRegistry. Replaces by name. */
  attach(target: ClusterCacheTarget): void {
    this.attached.set(target.name, target);
  }

  /** Announce that `cache` dropped `key` (null = every key). Never throws. */
  async publish(cache: string, key: string | null): Promise<PublishOutcome> {
    let outcome: PublishOutcome;
    let detail = '';
    try {
      let wireKey = key;
      if (wireKey !== null && wireKey.length > CLUSTER_CACHE_MAX_KEY_LENGTH) {
        // Receivers drop an oversize key as malformed; a whole-cache drop is the safe superset.
        this.warnRateLimited('oversize-key', `[clusterCache] key for "${cache}" exceeds ${CLUSTER_CACHE_MAX_KEY_LENGTH} chars; publishing a whole-cache invalidation instead`);
        wireKey = null;
      }
      const publisher = this.getPublisher();
      if (!publisher) {
        outcome = 'unavailable';
      } else {
        const message = encodeInvalidation({ v: 1, cache, key: wireKey, origin: this.origin, sentAtMs: this.now() });
        outcome = await this.boundedPublish(publisher, message);
        if (outcome === 'failed') detail = `timed out after ${this.publishTimeoutMs}ms`;
      }
    } catch (err) {
      outcome = 'failed';
      detail = errorMessage(err);
    }
    recordInvalidationPublished(cache, outcome);
    if (outcome !== 'published') {
      this.warnRateLimited(
        `publish-${outcome}`,
        `[clusterCache] publish ${outcome} for "${cache}"${detail ? ` (${detail})` : ''}; other API instances keep their entry until the TTL`,
      );
    }
    return outcome;
  }

  /** Subscribe this process. Idempotent; bounded by subscribeTimeoutMs; never throws. */
  start(): Promise<StartOutcome> {
    if (!this.startPromise) this.startPromise = this.doStart();
    return this.startPromise;
  }

  async stop(): Promise<void> {
    const sub = this.subscriber;
    this.subscriber = null;
    this.startPromise = null;
    this.cancelStart?.();
    this.cancelStart = null;
    this.markUnsubscribed();
    if (!sub) return;
    this.detach(sub);
    try {
      await sub.quit();
    } catch {
      try {
        sub.disconnect();
      } catch {
        // Already gone: releasing the connection is all stop() wants.
      }
    }
  }

  private async doStart(): Promise<StartOutcome> {
    let sub: SubscriberLike | null;
    try {
      sub = this.createSubscriber();
    } catch (err) {
      console.warn(`[clusterCache] could not create the subscriber (${errorMessage(err)}); caches are TTL-only on this instance`);
      this.markUnsubscribed();
      return 'failed';
    }
    if (!sub) {
      console.warn('[clusterCache] Redis unavailable; caches are TTL-only on this instance');
      this.markUnsubscribed();
      return 'unavailable';
    }
    this.subscriber = sub;
    // A client that connected before our listeners existed already spent its first
    // `ready`; the next one we see is a reconnect and must resync.
    this.seenReady = (sub as { status?: unknown }).status === 'ready';
    this.initialSubscribeRejected = false;
    this.listen(sub, 'message', (channel: string, message: string) => this.onMessage(sub, channel, message));
    this.listen(sub, 'ready', () => {
      this.onReady(sub).catch((err: unknown) => {
        console.error('[clusterCache] reconnect handling failed:', err);
      });
    });
    this.listen(sub, 'close', () => { if (this.subscriber === sub) this.markUnsubscribed(); });
    this.listen(sub, 'end', () => { if (this.subscriber === sub) this.markUnsubscribed(); });
    this.listen(sub, 'error', (err: Error) => {
      this.warnRateLimited('subscriber-error', `[clusterCache] subscriber error: ${err.message}`);
    });

    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(sub.subscribe(CLUSTER_CACHE_CHANNEL));
    } catch (err) {
      pending = Promise.reject(err);
    }

    return new Promise<StartOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: StartOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelStart = null;
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        if (this.subscriber !== sub) return settle('unavailable');
        console.warn(`[clusterCache] subscribe timed out after ${this.subscribeTimeoutMs}ms; TTL-only until it lands (kept retrying)`);
        settle('timeout');
      }, this.subscribeTimeoutMs);
      this.cancelStart = () => settle('unavailable');

      pending.then(
        () => {
          if (this.subscriber !== sub) return;
          if (!settled) {
            this.markSubscribed();
            settle('subscribed');
            return;
          }
          // D9: the subscribe outlived the boot wait. Anything published meanwhile was missed.
          this.markSubscribed();
          console.warn('[clusterCache] subscribe completed after the boot timeout');
          this.resync();
        },
        (err: unknown) => {
          if (this.subscriber !== sub) return;
          if (!settled) {
            console.warn(`[clusterCache] subscribe failed (${errorMessage(err)}); caches are TTL-only on this instance`);
            this.subscriber = null;
            this.detach(sub);
            try {
              sub.disconnect();
            } catch {
              // Best effort: the bus already stopped using it.
            }
            this.markUnsubscribed();
            settle('failed');
            return;
          }
          // After a timeout the subscriber is kept; the next `ready` re-subscribes.
          this.initialSubscribeRejected = true;
          console.warn(`[clusterCache] subscribe failed after the boot timeout (${errorMessage(err)}); will retry on reconnect`);
        },
      );
    });
  }

  private async onReady(sub: SubscriberLike): Promise<void> {
    if (this.subscriber !== sub) return;
    if (!this.seenReady) {
      this.seenReady = true;
      // The initial subscribe is queued behind this first connect; nothing was missed yet.
      if (!this.initialSubscribeRejected) return;
    }
    try {
      // ioredis also re-subscribes on reconnect, but our own awaited SUBSCRIBE is what
      // proves the server has us registered before we clear (D6). SUBSCRIBE is idempotent.
      await sub.subscribe(CLUSTER_CACHE_CHANNEL);
    } catch (err) {
      if (this.subscriber !== sub) return;
      this.markUnsubscribed();
      console.warn(`[clusterCache] re-subscribe after reconnect failed (${errorMessage(err)}); TTL-only until the next reconnect`);
      return;
    }
    if (this.subscriber !== sub) return;
    this.initialSubscribeRejected = false;
    this.markSubscribed();
    this.resync();
  }

  /** Clear every cluster cache on this instance once (messages may have been lost). */
  private resync(): void {
    let cleared = 0;
    for (const target of this.allTargets()) {
      try {
        target.invalidate();
        cleared += 1;
      } catch (err) {
        console.error(`[clusterCache] resync could not clear "${target.name}":`, err);
      }
    }
    recordResync();
    console.warn(`[clusterCache] subscriber (re)connected; resynced ${cleared} cache(s)`);
  }

  private onMessage(sub: SubscriberLike, channel: string, raw: string): void {
    if (this.subscriber !== sub || channel !== CLUSTER_CACHE_CHANNEL) return;
    try {
      const message = typeof raw === 'string' ? decodeInvalidation(raw) : null;
      if (!message) {
        recordInvalidationReceived('unknown', 'malformed');
        return;
      }
      const target = this.lookup(message.cache);
      if (message.origin === this.origin) {
        recordInvalidationReceived(target ? message.cache : 'unknown', 'self');
        return;
      }
      if (!target) {
        recordInvalidationReceived('unknown', 'unknown_cache');
        return;
      }
      if (message.key === null) target.invalidate();
      else target.invalidate(message.key);
      recordInvalidationReceived(target.name, 'applied');
      const lagSeconds = (this.now() - message.sentAtMs) / 1000;
      recordInvalidationLag(target.name, lagSeconds);
      if (lagSeconds > LAG_WARN_SECONDS) {
        this.warnRateLimited('lag', `[clusterCache] invalidation for "${target.name}" applied ${lagSeconds.toFixed(2)}s after publish (target ≤ ${LAG_WARN_SECONDS}s)`);
      }
    } catch (err) {
      // A cache whose invalidate() throws keeps its entry for the TTL: count it, log it (rate-limited).
      let cache = 'unknown';
      try {
        const name = (decodeInvalidation(raw) ?? { cache: '' }).cache;
        if (this.lookup(name)) cache = name;
      } catch {
        // keep 'unknown'
      }
      recordInvalidationReceived(cache, 'error');
      this.warnRateLimited('receive-error', `[clusterCache] invalidation handler failed for "${cache}": ${errorMessage(err)}`);
    }
  }

  // Attached targets (integration tests) REPLACE the registry for this bus, so two
  // test buses in one process never deliver into the process's real caches.
  private lookup(name: string): ClusterCacheTarget | undefined {
    if (this.attached.size > 0) return this.attached.get(name);
    if (this.registryTargets === clusterCacheTargets) return getClusterCacheTarget(name);
    for (const target of this.registryTargets()) if (target.name === name) return target;
    return undefined;
  }

  private allTargets(): Iterable<ClusterCacheTarget> {
    return this.attached.size > 0 ? [...this.attached.values()] : [...this.registryTargets()];
  }

  private async boundedPublish(publisher: PublisherLike, message: string): Promise<PublishOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.publishTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      const result = await Promise.race([publisher.publish(CLUSTER_CACHE_CHANNEL, message).then(() => 'ok' as const), timeout]);
      return result === 'ok' ? 'published' : 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  private listen(sub: SubscriberLike, event: string, fn: (...args: never[]) => void): void {
    (sub.on as (e: string, f: (...args: never[]) => void) => unknown)(event, fn);
    this.listeners.push({ event, fn });
  }

  private detach(sub: SubscriberLike): void {
    for (const { event, fn } of this.listeners.splice(0)) {
      try {
        sub.removeListener(event, fn);
      } catch {
        // A fake or half-closed client: nothing else to release.
      }
    }
    // An EventEmitter with no 'error' listener throws; the connection may still emit one while closing.
    try {
      (sub.on as (e: string, f: () => void) => unknown)('error', () => {});
    } catch {
      // ignore
    }
  }

  private markSubscribed(): void {
    this.isSubscribed = true;
    setSubscriberUp(true);
  }

  private markUnsubscribed(): void {
    this.isSubscribed = false;
    setSubscriberUp(false);
  }

  private warnRateLimited(kind: string, line: string): void {
    const now = Date.now();
    const last = this.lastWarnAt.get(kind);
    if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
    this.lastWarnAt.set(kind, now);
    console.warn(line);
  }
}

let defaultBus: ClusterCacheBus | null = null;
let testBus: ClusterCacheBus | null = null;

/**
 * The process bus: origin INSTANCE_ID, publishes on the shared `getRedis()`
 * client (a subscriber-mode connection cannot publish), and subscribes on its
 * own `duplicate()` named `breeze:cluster-cache`. Built lazily.
 */
export function getClusterCacheBus(): ClusterCacheBus {
  if (testBus) return testBus;
  if (!defaultBus) {
    defaultBus = new ClusterCacheBus({
      origin: INSTANCE_ID,
      getPublisher: () => getRedis(),
      createSubscriber: () => {
        const redis = getRedis();
        if (!redis || typeof redis.duplicate !== 'function') return null;
        return redis.duplicate({ connectionName: 'breeze:cluster-cache' }) as unknown as SubscriberLike;
      },
    });
  }
  return defaultBus;
}

/** TEST ONLY: install a bus for `getClusterCacheBus()` to return; `null` restores the default. */
export function __setClusterCacheBusForTests(bus: ClusterCacheBus | null): void {
  testBus = bus;
}
