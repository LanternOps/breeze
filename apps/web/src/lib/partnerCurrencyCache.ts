// Module-level cache behind `usePartnerCurrency` (lib/usePartnerCurrency.ts).
// Lives in its own import-free module so `stores/auth.ts` can reset it from
// the logout path without a stores ↔ lib import cycle (the hook imports
// `fetchWithAuth` from the store).
//
// Only a RESOLVED currency is ever cached: a rejected / 401 / non-OK response
// leaves the cache empty so the next mount retries.
//
// `generation` binds every request to the reset epoch it started in. A reset
// (logout) bumps it, so a request started under partner A that resolves after
// partner B logged in can neither commit A's currency over B's cache nor clear
// B's newer in-flight request (#3777 review F7).

export const partnerCurrencyCache: {
  value: string | null;
  inflight: Promise<string | null> | null;
  generation: number;
} = { value: null, inflight: null, generation: 0 };

/** Forget the cached partner currency and invalidate every request already in
 *  flight. Called on logout so a partner switch in the same tab never renders
 *  the previous partner's currency; tests call it in `beforeEach`. */
export function resetPartnerCurrencyCache(): void {
  partnerCurrencyCache.value = null;
  partnerCurrencyCache.inflight = null;
  partnerCurrencyCache.generation += 1;
}
