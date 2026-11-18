import { runAfterDbContextCommit, runAfterDbContextExit } from '../db';
import { getClusterCacheBus } from './clusterCacheBus';
import { registerClusterCache } from './clusterCacheRegistry';

/**
 * Put a hand-rolled per-process cache (one that is not a `HotPathTtlCache`) on
 * the W05 cluster cache bus (#8636).
 *
 * `HotPathTtlCache` with `cluster: true` already does this. Several older
 * caches keep their own shape (a single-flight map, a stale-serve fallback, a
 * whole-table snapshot, a cache read inside the request transaction, which
 * `HotPathTtlCache.getOrLoad` would bypass), so they bind to the bus through
 * this instead.
 *
 * `dropLocal(key?)` must:
 * - drop that key (or everything, with no key) from THIS process's cache;
 * - bump the cache's generation/epoch, so a load already in flight (it may have
 *   read the pre-write rows) returns to its caller but is not stored;
 * - never open a DB context or do I/O. The bus calls it from the Redis
 *   `message` handler, and the next read reloads under its own context.
 *
 * `invalidateAroundCommit(key?)` is the writer's call, with the same semantics
 * as `HotPathTtlCache.invalidateAroundCommit`: drop now, drop again once the
 * outermost DB context has settled, and announce to every other API/worker
 * process only after that context COMMITS (a rollback announces nothing).
 * Outside a DB context all three run at once. It never throws and never waits
 * on Redis: a down bus leaves other replicas on their TTL, as before.
 *
 * Keys are ids only (they go on the wire; see CLUSTER_CACHE_MAX_KEY_LENGTH).
 */
export interface ClusterInvalidator {
  readonly name: string;
  invalidateAroundCommit(key?: string): void;
}

export function registerClusterInvalidator(name: string, dropLocal: (key?: string) => void): ClusterInvalidator {
  registerClusterCache({ name, invalidate: dropLocal });

  const drop = (key: string | undefined): void => {
    try {
      dropLocal(key);
    } catch (error) {
      // A cache bug must not fail the write that triggered it.
      console.error(`[clusterCache] local invalidation of "${name}" threw`, error);
    }
  };

  return {
    name,
    invalidateAroundCommit(key?: string): void {
      drop(key);
      runAfterDbContextExit(`clusterInvalidator.${name}.invalidate`, () => drop(key));
      runAfterDbContextCommit(`clusterInvalidator.${name}.publish`, () =>
        // Returned so the after-commit runner reports a (never expected) rejection.
        getClusterCacheBus().publish(name, key ?? null),
      );
    },
  };
}
