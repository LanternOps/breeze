/**
 * History helpers that never wipe the state object Astro's view-transition
 * router keeps in `history.state` ({ index, scrollX, scrollY }).
 *
 * `history.replaceState(null | {}, …)` discards that object; the router's next
 * navigation then reads `history.state.index` from null and throws
 * "Cannot read properties of null (reading 'index')" (#8331). Always use
 * `replaceUrl` to rewrite the URL in place. Enforced by
 * `lib/__tests__/no-wipe-history-state.test.ts`.
 */

/** Rewrite the current URL in place (no new entry), preserving `history.state`. */
export function replaceUrl(url: string): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(window.history.state, '', url);
}

/**
 * A plain `window.location.hash = x` assignment pushes an entry whose
 * `history.state` is null, which the router cannot cope with on its next
 * `navigate(..., { history: 'replace' })`. Seed the router's expected shape
 * when the state is missing; existing state is left untouched.
 *
 * `index: 0` is a placeholder: the router's own counter is module-private, so
 * the seeded entry may later report the wrong back/forward direction to the
 * transition animation. That is cosmetic; the alternative is the throw.
 */
export function seedRouterHistoryState(): void {
  if (typeof window === 'undefined') return;
  if (window.history.state !== null && window.history.state !== undefined) return;
  window.history.replaceState({ index: 0, scrollX: window.scrollX, scrollY: window.scrollY }, '');
}
