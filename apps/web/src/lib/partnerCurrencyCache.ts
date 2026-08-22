// Module-level cache behind `usePartnerCurrency` (lib/usePartnerCurrency.ts).
// Lives in its own import-free module so `stores/auth.ts` can reset it from
// the logout path without a stores ↔ lib import cycle (the hook imports
// `fetchWithAuth` from the store).
//
// Only a RESOLVED currency is ever cached: a rejected / 401 / non-OK response
// leaves the cache empty so the next mount retries.

export const DEFAULT_PARTNER_CURRENCY = 'USD';

export const partnerCurrencyCache: {
  value: string | null;
  inflight: Promise<string | null> | null;
} = { value: null, inflight: null };

/** Forget the cached partner currency. Called on logout so a partner switch in
 *  the same tab never renders the previous partner's currency; tests call it
 *  in `beforeEach`. */
export function resetPartnerCurrencyCache(): void {
  partnerCurrencyCache.value = null;
  partnerCurrencyCache.inflight = null;
}
