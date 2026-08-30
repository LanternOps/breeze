import type { AnchorHTMLAttributes, MouseEvent } from "react";

export type HashLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  /** Fragment to navigate to, with or without the leading `#`. */
  hash: string;
};

/**
 * An `<a href="#…">` that actually fires `hashchange` (#4229).
 *
 * CLAUDE.md makes `window.location.hash` the sanctioned mechanism for
 * client-side UI state (selected tab, selected row), and the whole app reads it
 * back through `hashchange` — `useHashState`, plus the hand-rolled listeners in
 * PatchesPage, OrgSettingsPage, TicketingSettingsTabs and friends.
 *
 * A bare anchor breaks that contract under Astro. `Layout.astro` renders
 * `<ClientRouter />`, whose document-level click listener intercepts EVERY
 * same-origin anchor, calls `preventDefault()`, and hands the href to
 * `astro:transitions/client`'s `navigate()`. When the link differs from the
 * current URL only by fragment, `navigate()` short-circuits to
 * `history.pushState(…, to.href)` and returns. `pushState` fires neither
 * `hashchange` nor `popstate`, so the address bar moves to `#activities` while
 * every subscriber keeps rendering the old tab — until a reload re-reads the
 * hash and "fixes" it. That was the reported symptom.
 *
 * Assigning `window.location.hash` ourselves fires a real `hashchange`; the
 * `preventDefault()` we call first is what keeps Astro out of it, because its
 * listener skips events whose default is already prevented (React 18 dispatches
 * to handlers at the island root, which is inside `document`, so our handler
 * always runs first).
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
