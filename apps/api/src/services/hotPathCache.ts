import {
  getCurrentDbAccessContext,
  hasDbAccessContext,
  runAfterDbContextCommit,
  runAfterDbContextExit,
  type DbAccessContext,
} from '../db';
import { registerHotPathCache } from './hotPathCacheRegistry';
import { getClusterCacheBus, type ClusterCacheBus } from './clusterCacheBus';
import { registerClusterCache } from './clusterCacheRegistry';
import { recordCacheLookup, registerCacheSizeSource } from './clusterCacheMetrics';

export { __resetHotPathCachesForTests } from './hotPathCacheRegistry';

/**
 * Small in-process TTL cache for read-mostly data on the agent hot paths
 * (heartbeat, unifi-collectors poll) — #8053.
 *
 * Every agent heartbeats every 60 s and polls collectors every 30 s, so a
 * lookup that opens its own transaction per request costs one pooled
 * connection checkout, a `BEGIN`, the RLS `set_config` prologue and a
 * `COMMIT` per agent per beat, multiplied by the whole fleet. For data that is
 * global or per-org (not per-device), or that is overwhelmingly absent, a
 * bounded TTL makes that cost per-process instead of per-agent.
 *
 * Contract — read before adding a cache:
 *
 * - **Keys carry the full tenant scope of the value.** A per-org value is keyed
 *   by org id; a per-device value by org id AND device id. Never key tenant
 *   data by anything a different tenant could share.
 * - **Never cache secrets.** Values live in process memory for the TTL.
 * - **Staleness is bounded by the TTL, and by invalidation.** `invalidate()` is
 *   local to this process. A `cluster` cache (W05, #8144) also drops the entry
 *   on every other API instance, within about 1 s, when a writer calls
 *   `invalidateAroundCommit`; a non-cluster cache, or a cluster cache while
 *   Redis is down, leaves other instances on their entry until the TTL
 *   expires. Pick the TTL with that in mind.
 * - **A cluster cache publishes only from `invalidateAroundCommit`, and only
 *   after the outermost transaction commits** (`runAfterDbContextCommit`). A
 *   receiver that dropped its entry before COMMIT would reload the pre-commit
 *   rows and keep them for a full TTL. Messages carry ids only, never values.
 * - **A load that races an invalidation is not stored.** Every `invalidate()`
 *   bumps a generation; a load that started before the bump returns its value
 *   to its own caller but does not populate the cache, so a writer that
 *   invalidates after committing can never be overwritten by a read that saw
 *   the pre-commit state.
 * - **Only top-level reads are cached — with one exception.** Inside an ambient
 *   DB context `getOrLoad` bypasses the cache entirely (the loader would join
 *   the caller's transaction: its RLS scope and its uncommitted writes). The
 *   exception is `DeferredCacheFills` (#8053 W1a-1): a hot path that already
 *   runs inside a system-scoped context, or an org-scoped one with an exact fill
 *   scope (see `fillScopeIsCacheable`), with no writes of its own can load a
 *   per-org value there, and the value is stored only after that context has
 *   committed, through `fillIfCurrent`, which keeps the invalidation-race rule
 *   below. Which org-scoped contexts may fill is decided in ONE place,
 *   `fillScopeIsCacheable`; a load under any other narrower scope is returned
 *   but never stored (an RLS-narrowed answer must not be served org-wide).
 * - **Failures are never cached.** A throwing loader propagates to the caller
 *   and leaves the cache untouched, so a fail-closed caller re-resolves on its
 *   next request.
 * - **Concurrent misses are not coalesced.** Sharing one in-flight promise would
 *   run the loader under the first caller's async context; on a miss each
 *   caller loads for itself, which only costs the fan-in of one TTL window.
 * - Callers must treat returned values as read-only: they are shared.
 */
export interface HotPathTtlCacheOptions {
  /** Low-cardinality name, used in the test reset registry, metrics labels and cluster messages. */
  name: string;
  ttlMs: number;
  /** Upper bound on entries; the oldest entry is evicted past it. */
  maxEntries: number;
  /**
   * W05 (#8144): also drop this cache's entries on every other API instance.
   * `true` registers in clusterCacheRegistry and publishes through
   * getClusterCacheBus() resolved at publish time (D12); `{ bus }` attaches to
   * that bus (integration tests). Keys must be strings (ids only).
   */
  cluster?: true | { bus: ClusterCacheBus };
}

/** Cluster caches must have string keys: the key goes on the wire. */
type OptionsFor<K> = [K] extends [string]
  ? HotPathTtlCacheOptions
  : Omit<HotPathTtlCacheOptions, 'cluster'> & { cluster?: never };

export class HotPathTtlCache<K, V> {
  readonly name: string;
  readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private generation = 0;
  private readonly cluster: HotPathTtlCacheOptions['cluster'];

  constructor(options: OptionsFor<K>) {
    if (!(options.ttlMs > 0)) throw new Error(`HotPathTtlCache ${options.name}: ttlMs must be positive`);
    if (!(options.maxEntries > 0)) throw new Error(`HotPathTtlCache ${options.name}: maxEntries must be positive`);
    this.name = options.name;
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.cluster = options.cluster;
    registerHotPathCache(this);
    registerCacheSizeSource(this.name, () => this.size);
    if (this.cluster === true) {
      registerClusterCache(this as unknown as HotPathTtlCache<string, V>);
    } else if (this.cluster) {
      this.cluster.bus.attach(this as unknown as HotPathTtlCache<string, V>);
    }
  }

  /** Whether invalidations of this cache are announced to the other API instances. */
  get isCluster(): boolean {
    return this.cluster !== undefined;
  }

  /**
   * Return the cached value for `key`, or run `load` and cache its result.
   * `shouldCache` lets a caller decline to store a particular result (e.g. a
   * negative cache that only stores "absent").
   */
  async getOrLoad(
    key: K,
    load: () => Promise<V>,
    options: { shouldCache?: (value: V) => boolean } = {},
  ): Promise<V> {
    if (hasDbAccessContext()) {
      recordCacheLookup(this.name, 'bypass');
      return load();
    }

    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit) {
      if (hit.expiresAt > now) {
        recordCacheLookup(this.name, 'hit');
        return hit.value;
      }
      this.entries.delete(key);
    }

    recordCacheLookup(this.name, 'miss');
    const generationAtStart = this.generation;
    const value = await load();
    if (generationAtStart === this.generation && (options.shouldCache?.(value) ?? true)) {
      this.set(key, value);
    }
    return value;
  }

  /** Drop one key, or every key when called without one. */
  invalidate(key?: K): void {
    this.generation += 1;
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  /**
   * For a writer that invalidates from INSIDE its own transaction: drop now,
   * and drop again once the outermost DB context has settled. Between the two,
   * a concurrent reader can still load the pre-commit rows; the second drop
   * (with its generation bump) is what keeps that read out of the cache.
   *
   * A `cluster` cache also announces the drop to every other API instance,
   * ONLY after the outermost transaction commits (a rollback announces
   * nothing), fire-and-forget: Redis being down or slow never fails or delays
   * the writer.
   */
  invalidateAroundCommit(key?: K): void {
    if (this.cluster && key !== undefined && typeof key !== 'string') {
      // D10: a cache bug must not fail a settings write. Widen to the whole cache.
      console.error(`[clusterCache] non-string key for "${this.name}"; invalidating the whole cache instead`);
      key = undefined;
    }
    this.invalidate(key);
    runAfterDbContextExit(`hotPathCache.${this.name}.invalidate`, () => this.invalidate(key));
    if (this.cluster) {
      const name = this.name;
      const cluster = this.cluster;
      const wireKey = (key as string | undefined) ?? null;
      runAfterDbContextCommit(`hotPathCache.${name}.publish`, () => {
        const bus = cluster === true ? getClusterCacheBus() : cluster.bus;
        void bus.publish(name, wireKey);
      });
    }
  }

  /** The cached value, or undefined on a miss. Never loads and never touches the DB. */
  peek(key: K): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt > Date.now()) return hit.value;
    this.entries.delete(key);
    return undefined;
  }

  /** Generation stamp for a load the caller runs itself; pass it to fillIfCurrent. */
  ticket(): number {
    return this.generation;
  }

  /**
   * Store a value the caller loaded itself, iff no invalidate() ran since
   * `ticket`. Must be called OUTSIDE any DB context: the load's transaction
   * has to have committed, or a rolled-back read could be cached.
   */
  fillIfCurrent(key: K, value: V, ticket: number): void {
    if (hasDbAccessContext()) {
      throw new Error(`HotPathTtlCache ${this.name}: fillIfCurrent called inside a DB context`);
    }
    if (ticket !== this.generation) return;
    this.set(key, value);
  }

  get size(): number {
    return this.entries.size;
  }

  private set(key: K, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

/** The exact org-scoped context a per-org value may be cached from (#8142). */
export interface DeferredFillScope {
  readonly orgId: string;
  /** The org's own partner, read under RLS in the same context. */
  readonly partnerId: string;
}
// Both fields must be non-empty, and the context must carry no userId
// (checked by fillScopeIsCacheable).

/**
 * Whether a load under `ctx` may be stored for everyone in the org.
 * - system scope: yes (#8053 W1a-1).
 * - org scope: only when the caller names the scope it built the context for
 *   AND the context is exactly that: this org alone, no partner-level grant,
 *   no userId (it would enable the users self-read RLS branch),
 *   and this org's partner as the partner-wide read axis. Then RLS shows the
 *   loader every row any device of the org would see, so the value is not
 *   narrowed or widened. Anything else is returned but never stored.
 */
export function fillScopeIsCacheable(ctx: DbAccessContext | undefined, fillScope?: DeferredFillScope): boolean {
  if (!ctx) return false;
  if (ctx.scope === 'system') return true;
  if (!fillScope || ctx.scope !== 'organization') return false;
  if (fillScope.orgId === '' || fillScope.partnerId === '') return false;
  return ctx.orgId === fillScope.orgId
    && (ctx.userId ?? null) === null
    && Array.isArray(ctx.accessibleOrgIds)
    && ctx.accessibleOrgIds.length === 1
    && ctx.accessibleOrgIds[0] === fillScope.orgId
    && (ctx.accessiblePartnerIds ?? []).length === 0
    && (ctx.currentPartnerId ?? null) === fillScope.partnerId;
}

/**
 * Read-through for a hot path that runs INSIDE a system-scoped context, or an
 * org-scoped one with an exact fill scope (see `fillScopeIsCacheable`)
 * (#8053 W1a-1: the heartbeat's shared post-commit policy context). A hit
 * returns at once with no load. A miss loads in the caller's transaction, as
 * the code did before it was cached, and queues the fill. The caller calls
 * `flush()` once, after that context has committed. Whether a miss is stored
 * at all is `fillScopeIsCacheable`'s decision.
 *
 * Caller contract: the context must have made no writes the loaded rows could
 * observe, and the value must be a function of `key` alone.
 */
export interface DeferredFillOptions<V> {
  /**
   * The org a NON-org key belongs to (#7970: `${orgId}:${deviceId}`). Without
   * it the key itself must equal the fill scope's org id. The caller vouches
   * that the value is a function of rows inside this one org, so the org-scoped
   * context sees exactly what a system read would.
   */
  keyOrgId?: string;
  /** Decline to store a particular value (e.g. a negative-only cache). */
  shouldCache?: (value: V) => boolean;
}

export class DeferredCacheFills {
  private readonly pending: Array<() => void> = [];

  async through<K, V>(
    cache: HotPathTtlCache<K, V>,
    key: K,
    load: () => Promise<V>,
    fillScope?: DeferredFillScope,
    options: DeferredFillOptions<V> = {},
  ): Promise<V> {
    const hit = cache.peek(key);
    if (hit !== undefined) {
      recordCacheLookup(cache.name, 'hit');
      return hit;
    }
    // A fill scope binds the key: another org's key under this scope would cache an RLS-narrowed value.
    const keyOrg: unknown = options.keyOrgId ?? key;
    const cacheable = fillScopeIsCacheable(getCurrentDbAccessContext(), fillScope)
      && !(fillScope && keyOrg !== fillScope.orgId);
    recordCacheLookup(cache.name, cacheable ? 'miss' : 'bypass');
    const ticket = cache.ticket();
    const value = await load();
    if (cacheable && (options.shouldCache?.(value) ?? true)) {
      this.pending.push(() => cache.fillIfCurrent(key, value, ticket));
    }
    return value;
  }

  flush(): void {
    // Each fill is independent: one throwing must not drop the rest.
    for (const fill of this.pending.splice(0)) {
      try {
        fill();
      } catch (err) {
        console.error('[hotPathCache] deferred cache fill failed; skipping it:', err);
      }
    }
  }
}
