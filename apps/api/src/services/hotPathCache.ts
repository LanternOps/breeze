import { getCurrentDbAccessContext, hasDbAccessContext, runAfterDbContextExit, type DbAccessContext } from '../db';
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
 * - **Only top-level reads are cached — with one exception.** Inside an ambient
 *   DB context `getOrLoad` bypasses the cache entirely (the loader would join
 *   the caller's transaction: its RLS scope and its uncommitted writes). The
 *   exception is `DeferredCacheFills` (#8053 W1a-1): a hot path that already
 *   runs inside a SYSTEM-scoped context with no writes of its own can load a
 *   per-org value there, and the value is stored only after that context has
 *   committed, through `fillIfCurrent`, which keeps the invalidation-race rule
 *   below. A load under an org scope is stored only when the caller passes the exact
 *   `{ orgId, partnerId }` fill scope the context was built for (#8142,
 *   `fillScopeIsCacheable`); any other narrower scope is returned but never stored.
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
  orgId: string;
  /** The org's own partner, read under RLS in the same context. Both fields must be non-empty; the context must carry no userId. */
  partnerId: string;
}

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
 * Read-through for a hot path that runs INSIDE a system-scoped context
 * (#8053 W1a-1: the heartbeat's shared post-commit policy context). A hit
 * returns at once with no load. A miss loads in the caller's transaction, as
 * the code did before it was cached, and queues the fill. The caller calls
 * `flush()` once, after that context has committed. A miss under a non-system
 * scope still loads and returns, but is never stored unless the caller names
 * an exact org fill scope that the context matches (`fillScopeIsCacheable`):
 * an RLS-narrowed answer must not be served to the rest of the org.
 *
 * Caller contract: the context must have made no writes the loaded rows could
 * observe, and the value must be a function of `key` alone.
 */
export class DeferredCacheFills {
  private readonly pending: Array<() => void> = [];

  async through<K, V>(cache: HotPathTtlCache<K, V>, key: K, load: () => Promise<V>, fillScope?: DeferredFillScope): Promise<V> {
    const hit = cache.peek(key);
    if (hit !== undefined) return hit;
    const cacheable = fillScopeIsCacheable(getCurrentDbAccessContext(), fillScope);
    const ticket = cache.ticket();
    const value = await load();
    if (cacheable) this.pending.push(() => cache.fillIfCurrent(key, value, ticket));
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
