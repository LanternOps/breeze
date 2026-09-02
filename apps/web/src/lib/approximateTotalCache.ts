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
//
// Invalidation on a partner-currency change used to be LAZY: it only ran
// inside `approximateTotalCacheKey()`, so it fired only on the next render
// that happened to compute a key. An already-mounted `useApproximateTotal`
// line with no other reason to re-render (the normal case: nothing else on
// its props/state changed) never called that function again, so it neither
// noticed the reset nor refetched — the "never refetches" half of #4472.
// `subscribePartnerCurrencyCache` below makes invalidation EAGER: it fires
// the instant `resetPartnerCurrencyCache()` runs, clearing this cache and
// notifying `subscribeApproximateTotalCache` listeners so a mounted hook can
// force its own re-render via `useSyncExternalStore` even with nothing else
// changing.

import { partnerCurrencyCache, subscribePartnerCurrencyCache } from './partnerCurrencyCache';
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

const listeners = new Set<() => void>();

/** Notified synchronously every time `approximateTotalCache.generation`
 *  changes (a partner-currency reset observed below, or
 *  `resetApproximateTotalCache()` itself — e.g. logout). Returns an
 *  unsubscribe function. `useApproximateTotal` uses this with
 *  `useSyncExternalStore` so an already-mounted line re-renders — and its
 *  effect re-runs — the instant a reset happens, not on the next render it
 *  would have had anyway. */
export function subscribeApproximateTotalCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Clear this cache and bump its generation if the partner-currency cache has
 *  moved on to a new epoch since we last observed it. Idempotent: a no-op if
 *  already caught up (e.g. the eager subscription below already ran). */
function syncToPartnerCurrencyGeneration(): boolean {
  if (approximateTotalCache.partnerCurrencyGeneration === partnerCurrencyCache.generation) return false;
  approximateTotalCache.partnerCurrencyGeneration = partnerCurrencyCache.generation;
  approximateTotalCache.values.clear();
  approximateTotalCache.inflight.clear();
  approximateTotalCache.generation += 1;
  return true;
}

// Wired once at module load: react to a partner-currency reset the instant it
// happens rather than waiting for some unrelated render to notice lazily.
subscribePartnerCurrencyCache(() => {
  if (syncToPartnerCurrencyGeneration()) notify();
});

/**
 * THE key for one cached total — every read and write goes through here.
 *
 * The key is `${generation}|${date}|${groupsParam}`: the generation prefix is
 * what makes a discarded in-flight response self-heal instead of pinning a
 * stale `failed` status. Without it, a response that lands mid-flight for a
 * generation that has since moved on could still be read back against a
 * same-named key later — the generation guard in `loadApproximateTotal`
 * already refuses to COMMIT such a response, but a mounted line's own effect
 * needs the key itself to change so it re-subscribes to a fresh request
 * rather than resolving into the discarded one silently (#4472). Each entry
 * is denominated in the SERVER-derived partner reporting currency, which the
 * key otherwise could not name (the client never asks for a target; an
 * organization-scoped viewer cannot even read `/orgs/partners/me`), so
 * without the generation prefix an admin who changes the partner reporting
 * currency in the same tab would keep reading — and formatting — figures in
 * the OLD currency until logout.
 *
 * Rather than guess the target, the cache is bound to the partner-currency
 * cache's reset epoch: whatever invalidates THAT (logout, saving partner
 * billing settings) invalidates these totals in the same motion — eagerly,
 * via the `subscribePartnerCurrencyCache` listener above, not just here. This
 * lazy check is kept as a fallback for any caller that reads the cache
 * without having been subscribed (e.g. a render that raced module
 * evaluation); it is idempotent with the eager path.
 *
 * Resolving the partner currency for the first time is not a change and does
 * not bump the generation, so ordinary de-duplication is untouched.
 */
export function approximateTotalCacheKey(date: string, groupsParam: string): string {
  if (syncToPartnerCurrencyGeneration()) notify();
  return `${approximateTotalCache.generation}|${date}|${groupsParam}`;
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
  notify();
}
