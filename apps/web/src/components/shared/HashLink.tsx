import type { AnchorHTMLAttributes, MouseEvent } from "react";

export type HashLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  /** Fragment to navigate to, with or without the leading `#`. */
  hash: string;
  /**
   * Optional click hook. It runs BEFORE the hash is written, and calling
   * `event.preventDefault()` inside it cancels the navigation entirely — the
   * standard anchor-veto idiom. A caller that vetoes owns 100% of the
   * resulting feedback: nothing else happens, by design.
   */
  onClick?: AnchorHTMLAttributes<HTMLAnchorElement>["onClick"];
};

/**
 * An `<a href="#…">` that actually fires `hashchange` (#4229).
 *
 * This is the canonical explanation for the whole hash-link mechanism; the
 * test double at `src/__tests__/astroClientRouterStandIn.ts` encodes it in
 * executable form.
 *
 * CLAUDE.md makes `window.location.hash` the sanctioned mechanism for
 * client-side UI state (selected tab, selected row), and the app reads it back
 * through `hashchange` — `useHashState`, plus the hand-rolled listeners in
 * PatchesPage, OrgSettingsPage, TicketingSettingsTabs and friends.
 *
 * A bare anchor breaks that contract under Astro. `Layout.astro` renders
 * `<ClientRouter />`, whose document-level click listener claims same-origin
 * anchor clicks — every one that does not opt out via `data-astro-reload`, a
 * `download` attribute, a `target` other than `_self`, a missing `href`, a
 * modifier key, or an already-prevented default. For a claimed click it calls
 * `preventDefault()` and hands the href to `astro:transitions/client`'s
 * `navigate()`.
 *
 * Verified against `astro@7.2.4` (`dist/transitions/router.js`, an unexported
 * internal reached only through the `astro:transitions/client` virtual module
 * — re-check on any Astro bump): when the link's path and query match the
 * current URL and only the fragment differs, `transition()` short-circuits to
 * `moveToLocation()`, which does `history.pushState(…, to.href)`. `pushState`
 * fires no `hashchange`, and the synthetic `popstate` that `moveToLocation()`
 * can dispatch is guarded on `history.state` being falsy — which the
 * `pushState` it just performed rules out. So on this path the address bar
 * moves to `#activities` while every subscriber keeps rendering the old value,
 * until a reload re-reads the hash on mount and appears to "fix" it.
 *
 * Assigning `window.location.hash` ourselves fires a real `hashchange`. The
 * `preventDefault()` we call first is what keeps Astro out of it: React's
 * delegated listener sits on the island's root container, which is an ancestor
 * of this anchor and a descendant of `document`, so it is reached earlier in
 * the bubble path than Astro's `document`-level listener — which then sees an
 * already-prevented default and stands down. `HashLink.test.tsx` pins that
 * ordering down; do not rely on the narrative alone.
 *
 * Modified clicks are deliberately untouched — cmd/ctrl-click still opens the
 * fragment in a new tab, shift-click a new window — which is the reason this
 * stays an anchor with a real `href` rather than becoming a `<button>`.
 */
export default function HashLink({
  hash,
  onClick,
  children,
  ...rest
}: HashLinkProps) {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    // Caller veto (documented on `onClick` above): they own the outcome.
    if (event.defaultPrevented) return;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    window.location.hash = fragment;
  };

  return (
    <a {...rest} href={`#${fragment}`} onClick={handleClick}>
      {children}
    </a>
  );
}
