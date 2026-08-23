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

import type { ReportingTotalResponse } from './reporting/approximateTotal';

export const approximateTotalCache: {
  values: Map<string, ReportingTotalResponse>;
  inflight: Map<string, Promise<ReportingTotalResponse | null>>;
  generation: number;
} = { values: new Map(), inflight: new Map(), generation: 0 };

/** Forget every cached approximate total and invalidate all in-flight
 *  requests. Called on logout so a partner switch in the same tab never
 *  renders the previous partner's converted figures; tests call it in
 *  `beforeEach`. */
export function resetApproximateTotalCache(): void {
  approximateTotalCache.values.clear();
  approximateTotalCache.inflight.clear();
  approximateTotalCache.generation += 1;
}
