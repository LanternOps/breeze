import { hasDbAccessContext, runAfterDbContextExit } from '../db';
import { registerHotPathCache } from './hotPathCacheRegistry';

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
 * - **Staleness is bounded by the TTL, and by `invalidate()` on this process.**
 *   Invalidation is process-local: another API instance keeps its entry until
 *   the TTL expires. Pick the TTL with that in mind.
 * - **A load that races an invalidation is not stored.** Every `invalidate()`
 *   bumps a generation; a load that started before the bump returns its value
 *   to its own caller but does not populate the cache, so a writer that
 *   invalidates after committing can never be overwritten by a read that saw
 *   the pre-commit state.
 * - **Only top-level reads are cached.** Inside an ambient DB context the
 *   loader would join the caller's transaction — its RLS scope (an org-scoped
 *   caller cannot see the parent partner row) and its uncommitted writes — so
 *   the cache is bypassed entirely there: no read, no write.
 * - **Failures are never cached.** A throwing loader propagates to the caller
 *   and leaves the cache untouched, so a fail-closed caller re-resolves on its
 *   next request.
 * - **Concurrent misses are not coalesced.** Sharing one in-flight promise would
 *   run the loader under the first caller's async context; on a miss each
 *   caller loads for itself, which only costs the fan-in of one TTL window.
 * - Callers must treat returned values as read-only: they are shared.
 */
export interface HotPathTtlCacheOptions {
  /** Low-cardinality name, used in the test reset registry. */
  name: string;
  ttlMs: number;
  /** Upper bound on entries; the oldest entry is evicted past it. */
  maxEntries: number;
}


export class HotPathTtlCache<K, V> {
  readonly name: string;
  readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private generation = 0;

  constructor(options: HotPathTtlCacheOptions) {
    if (!(options.ttlMs > 0)) throw new Error(`HotPathTtlCache ${options.name}: ttlMs must be positive`);
    if (!(options.maxEntries > 0)) throw new Error(`HotPathTtlCache ${options.name}: maxEntries must be positive`);
    this.name = options.name;
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    registerHotPathCache(this);
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
    if (hasDbAccessContext()) return load();

    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit) {
      if (hit.expiresAt > now) return hit.value;
      this.entries.delete(key);
    }

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
   */
  invalidateAroundCommit(key?: K): void {
    this.invalidate(key);
    runAfterDbContextExit(`hotPathCache.${this.name}.invalidate`, () => this.invalidate(key));
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

