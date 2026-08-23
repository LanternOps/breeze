// Module-level cache behind `useApproximateTotal` (lib/useApproximateTotal.ts).
//
// Lives in its own import-free module for the same reason
// `partnerCurrencyCache.ts` does: `stores/auth.ts` resets it from the logout
// path, and the hook imports `fetchWithAuth` FROM that store — importing the
// hook into the store instead would close an import cycle.
//
// Every entry is a converted REPORTING total denominated in the viewer's own
// partner reporting currency (the server derives the target from the actor),
// so it must not survive a partner switch in the same tab. Only a VALIDATED
// server answer is cached; a non-2xx, rejected or malformed response caches
// nothing so the next mount retries. An `unavailable` answer IS a valid answer
// and is cached — re-asking cannot make a missing rate appear.
//
// `generation` binds every request to the reset epoch it started in, so a
// response that lands after a logout can neither commit the previous partner's
// total nor clear the newer in-flight slot (the #3777 review F7 shape).

import { partnerCurrencyCache } from './partnerCurrencyCache';
import type { ReportingTotalResponse } from './reporting/approximateTotal';

export const approximateTotalCache: {
  values: Map<string, ReportingTotalResponse>;
  inflight: Map<string, Promise<ReportingTotalResponse | null>>;
  generation: number;
  /** The partner-currency generation the cached entries were resolved under. */
  partnerCurrencyGeneration: number;
} = {
  values: new Map(),
  inflight: new Map(),
  generation: 0,
  partnerCurrencyGeneration: partnerCurrencyCache.generation,
};

/**
 * THE key for one cached total — every read and write goes through here.
 *
 * The key is `${date}|${groupsParam}`, but each entry is denominated in the
 * SERVER-derived partner reporting currency, which the key cannot name (the
 * client never asks for a target; an organization-scoped viewer cannot even
 * read `/orgs/partners/me`). So an admin who changes the partner reporting
 * currency in the same tab would keep reading — and formatting — figures in the
 * OLD currency until logout.
 *
 * Rather than guess the target, the cache is bound to the partner-currency
 * cache's reset epoch: whatever invalidates THAT (logout, saving partner
 * billing settings) invalidates these totals in the same motion. Observing a
 * new epoch clears the values AND bumps our own generation, so an answer
 * already in flight under the previous currency is discarded by the existing
 * generation check instead of committing.
 *
 * Resolving the partner currency for the first time is not a change and does
 * not bump the generation, so ordinary de-duplication is untouched.
 */
export function approximateTotalCacheKey(date: string, groupsParam: string): string {
  if (approximateTotalCache.partnerCurrencyGeneration !== partnerCurrencyCache.generation) {
    approximateTotalCache.partnerCurrencyGeneration = partnerCurrencyCache.generation;
    approximateTotalCache.values.clear();
    approximateTotalCache.inflight.clear();
    approximateTotalCache.generation += 1;
  }
  return `${date}|${groupsParam}`;
}

/** Forget every cached approximate total and invalidate all in-flight
 *  requests. Called on logout so a partner switch in the same tab never
 *  renders the previous partner's converted figures; tests call it in
 *  `beforeEach`. */
export function resetApproximateTotalCache(): void {
  approximateTotalCache.partnerCurrencyGeneration = partnerCurrencyCache.generation;
  approximateTotalCache.values.clear();
  approximateTotalCache.inflight.clear();
  approximateTotalCache.generation += 1;
}
