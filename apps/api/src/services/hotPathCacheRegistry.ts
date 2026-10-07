/**
 * Registry of every HotPathTtlCache (services/hotPathCache.ts), kept in a leaf
 * module with no imports so the integration setup can reset caches between
 * tests without loading `db` (which must not be imported before the setup has
 * loaded `.env.test`).
 */
export interface ResettableHotPathCache {
  invalidate(): void;
}

const registry = new Set<ResettableHotPathCache>();

export function registerHotPathCache(cache: ResettableHotPathCache): void {
  registry.add(cache);
}

/** TEST ONLY: empty every hot-path cache so one test cannot feed the next. */
export function __resetHotPathCachesForTests(): void {
  for (const cache of registry) cache.invalidate();
}
