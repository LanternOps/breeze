import type { MouseEvent } from "react";
import { seedRouterHistoryState } from "./replaceUrl";

/**
 * Claim a plain click on an anchor whose target differs from the current URL
 * only by its fragment, and navigate it with `window.location.hash` so a real
 * `hashchange` fires.
 *
 * Why: Astro's `<ClientRouter />` moves same-page fragment links with a bare
 * `history.pushState`, which fires neither `hashchange` nor `popstate`, so
 * every `useHashState` subscriber keeps rendering the old value (#4229; the
 * full mechanism is documented on `components/shared/HashLink.tsx`). Calling
 * `preventDefault()` here, from React's root-container listener, makes Astro's
 * document-level listener stand down.
 *
 * Left alone (returns false): an already-prevented click, modified or
 * non-primary clicks (new tab/window keep working off the real `href`), and
 * any href that changes the path or query — that is a real page navigation and
 * stays the router's job.
 *
 * @returns whether the click was claimed.
 */
export function claimSamePageHashClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
): boolean {
  if (event.defaultPrevented) return false;
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return false;
  }
  const hashIndex = href.indexOf("#");
  if (hashIndex < 0) return false;
  const target = new URL(href, window.location.href);
  if (
    target.origin !== window.location.origin ||
    target.pathname !== window.location.pathname ||
    target.search !== window.location.search
  ) {
    return false;
  }
  event.preventDefault();
  window.location.hash = href.slice(hashIndex + 1);
  // The hash assignment pushed an entry with null `history.state`. The router
  // ignores null-state popstates, so once a later click swaps the page, Back
  // onto this entry would leave the wrong page on screen (and a later
  // `history: 'replace'` navigate would throw, #8331). Seed the shape it needs.
  seedRouterHistoryState();
  return true;
}
