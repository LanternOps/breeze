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
//
// `subscribePartnerCurrencyCache` lets a DOWNSTREAM module-level cache
// (approximateTotalCache.ts) react to a reset the instant it happens, rather
// than discovering it lazily on the next unrelated render — a reset that
// nobody happens to re-render for is otherwise invisible until something
// else forces one (#4472).
//
// Each listener is called in its own try/catch: `Set.forEach` aborts on the
// first throw, which would otherwise (a) propagate into whatever CALLER
// triggered the reset — e.g. the billing-settings save success handler — and
// (b) silently skip every listener registered after the throwing one,
// reintroducing #4472 for those subscribers with no signal anywhere.

import * as Sentry from '@sentry/astro';

export const partnerCurrencyCache: {
  value: string | null;
  inflight: Promise<string | null> | null;
  generation: number;
} = { value: null, inflight: null, generation: 0 };

const listeners = new Set<() => void>();

/** Notified synchronously every time `resetPartnerCurrencyCache()` runs.
 *  Returns an unsubscribe function. */
export function subscribePartnerCurrencyCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Forget the cached partner currency and invalidate every request already in
 *  flight. Called on logout so a partner switch in the same tab never renders
 *  the previous partner's currency; tests call it in `beforeEach`. */
export function resetPartnerCurrencyCache(): void {
  partnerCurrencyCache.value = null;
  partnerCurrencyCache.inflight = null;
  partnerCurrencyCache.generation += 1;
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      Sentry.captureException(error);
    }
  });
}
