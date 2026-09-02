/**
 * Test stand-in for Astro's `<ClientRouter />` anchor interception (#4229).
 *
 * The full explanation of what Astro does and why it breaks fragment links
 * lives in `src/components/shared/HashLink.tsx` — read that first. This file is
 * the executable form of it.
 *
 * Why it must exist: jsdom has no Astro runtime, so a naive
 * `fireEvent.click(anchor)` follows the browser default — hash updated,
 * `hashchange` fired — and every hash-anchor test passes while the real app is
 * broken. Installing this stand-in reproduces production's behaviour (claim the
 * click, `preventDefault()`, move the URL with `history.pushState`, emit no
 * `hashchange` and no `popstate`), so such a test fails for the same reason the
 * product does.
 *
 * Faithful to `astro@7.2.4` for the fields these tests exercise: the
 * already-prevented-default bail-out and the `leavesWindow` modifier check. It
 * deliberately does NOT model `data-astro-reload`, `download`, `target`, or
 * cross-origin hrefs — none apply to a same-page fragment link.
 */

export type ObservedAnchorClick = {
  link: HTMLAnchorElement;
  /** Whether a handler nearer the target already called preventDefault(). */
  defaultPrevented: boolean;
  /** cmd/ctrl/shift/alt or a non-primary button — Astro leaves these alone. */
  modified: boolean;
};

export type ClientRouterStandIn = {
  /** Every anchor click that reached the document, in order. */
  readonly observed: ObservedAnchorClick[];
  /** The subset the stand-in actually hijacked (i.e. Astro would break it). */
  readonly intercepted: HTMLAnchorElement[];
  uninstall: () => void;
};

export function installAstroClientRouterStandIn(): ClientRouterStandIn {
  const observed: ObservedAnchorClick[] = [];
  const intercepted: HTMLAnchorElement[] = [];

  const handler = (event: Event) => {
    const mouseEvent = event as MouseEvent;
    const target = event.target;
    const link = target instanceof Element ? target.closest("a") : null;
    if (!(link instanceof HTMLAnchorElement) || !link.href) return;
    // Astro bails on modified clicks (new tab/window/download) and on any event
    // whose default a listener closer to the target already prevented.
    const modified =
      mouseEvent.button !== 0 ||
      mouseEvent.metaKey ||
      mouseEvent.ctrlKey ||
      mouseEvent.shiftKey ||
      mouseEvent.altKey;
    observed.push({
      link,
      defaultPrevented: mouseEvent.defaultPrevented,
      modified,
    });
    if (mouseEvent.defaultPrevented || modified) return;

    intercepted.push(link);
    event.preventDefault();
    // The fragment-only shortcut inside astro's `transition()`: URL moves, no
    // hashchange, no popstate.
    window.history.pushState({}, "", link.href);
  };

  document.addEventListener("click", handler);
  return {
    observed,
    intercepted,
    uninstall: () => document.removeEventListener("click", handler),
  };
}
