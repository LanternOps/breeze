/**
 * Take Back / Forward between two of this page's own history entries before
 * Astro's router does. The router would treat the step as a navigation and,
 * unless the location it last moved to carries a hash, re-fetch and swap the
 * page (remounting every island). Why this cannot be an ordinary listener, and
 * how the hook gets ahead of the router: `public/same-page-history.js`.
 *
 * `claim` runs on every popstate. Return true once it has handled the step
 * (the router and every later listener then never see it); return false to
 * leave it alone. Returns an unregister function.
 *
 * Without the hook (a layout that does not load it) the claim still runs, as
 * an ordinary listener behind the router.
 */
export type SamePageHistoryClaim = (event: PopStateEvent) => boolean;

type HookWindow = typeof window & {
  __breezeSamePageHistory?: { claim: (fn: SamePageHistoryClaim) => () => void };
};

export function claimSamePageHistory(claim: SamePageHistoryClaim): () => void {
  if (typeof window === 'undefined') return () => {};
  const hook = (window as HookWindow).__breezeSamePageHistory;
  if (hook) return hook.claim(claim);
  const listener = (event: PopStateEvent) => { claim(event); };
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
