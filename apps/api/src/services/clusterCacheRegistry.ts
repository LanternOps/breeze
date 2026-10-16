/**
 * Registry of every cluster-invalidated cache (W05, #8144): name → target.
 *
 * LEAF, no imports — like `hotPathCacheRegistry.ts`. A `HotPathTtlCache` built
 * with `cluster: true` registers here at construction (module load), and the
 * cluster cache bus looks targets up here at receive/resync time. Keeping the
 * binding by name, resolved late, means a test can swap the process bus after
 * the caches were built, and a `vi.resetModules()` re-import that rebuilds a
 * cache simply replaces the old entry.
 */
export interface ClusterCacheTarget {
  readonly name: string;
  /** Drop one key, or every key when called without one. Must bump the cache generation. */
  invalidate(key?: string): void;
}

const targets = new Map<string, ClusterCacheTarget>();

/** Register (or replace, with a warning) the target for `target.name`. */
export function registerClusterCache(target: ClusterCacheTarget): void {
  const previous = targets.get(target.name);
  if (previous && previous !== target) {
    console.warn(`[clusterCache] cache "${target.name}" registered twice; the newer instance replaces the older one`);
  }
  targets.set(target.name, target);
}

export function clusterCacheTargets(): Iterable<ClusterCacheTarget> {
  return targets.values();
}

export function getClusterCacheTarget(name: string): ClusterCacheTarget | undefined {
  return targets.get(name);
}
