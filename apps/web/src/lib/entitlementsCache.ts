// Module-level cache behind `useEntitlements` / `useEntitlement`
// (hooks/useEntitlement.ts). Lives in its own import-free module so
// `stores/auth.ts` can reset it from the logout path without a
// stores ↔ hooks import cycle (the hook imports `fetchWithAuth` from the store).
//
// Only a SUCCESSFUL snapshot is ever cached: a rejected / non-2xx / malformed
// response leaves the cache empty so the next mount (or `reload()`) retries —
// and the hook reports `'loading'`, never `'enabled'` (fail closed, D10).
//
// `generation` binds every request to the reset epoch it started in. A reset
// (logout) bumps it, so a request started under partner A that resolves after
// partner B logged in can neither commit A's entitlements over B's cache nor
// clear B's newer in-flight request (same contract as partnerCurrencyCache).

export type ClientEntitlement = {
  key: string;
  label: string;
  why: string;
  state: 'enabled' | 'disabled';
  source: 'plan' | 'billing' | 'license' | 'manual';
  limits: unknown | null;
  expiresAt: string | null;
  graceUntil: string | null;
  reason: string | null;
};

export type EntitlementsSnapshot = { plan: string; entitlements: ClientEntitlement[] };

export const entitlementsCache: {
  value: EntitlementsSnapshot | null;
  inflight: Promise<EntitlementsSnapshot | null> | null;
  generation: number;
} = { value: null, inflight: null, generation: 0 };

const listeners = new Set<() => void>();

/** Notified synchronously every time `resetEntitlementsCache()` runs, so a
 *  mounted hook drops the previous partner's snapshot immediately.
 *  Returns an unsubscribe function. */
export function subscribeEntitlementsCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Forget the cached entitlements and invalidate every request already in
 *  flight. Called on logout; tests call it in `beforeEach`. */
export function resetEntitlementsCache(): void {
  entitlementsCache.value = null;
  entitlementsCache.inflight = null;
  entitlementsCache.generation += 1;
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      // A throwing subscriber must not abort the logout path or skip the
      // remaining subscribers.
      console.error('[entitlements] cache reset listener threw', err);
    }
  });
}
