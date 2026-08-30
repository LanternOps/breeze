/**
 * Test stand-in for Astro's `<ClientRouter />` anchor interception (#4229).
 *
 * jsdom has no Astro runtime, so a naive `fireEvent.click(anchor)` follows the
 * browser default — hash updated, `hashchange` fired — and every hash-anchor
 * test passes while the real app is broken. In production `Layout.astro`
 * renders `<ClientRouter />`, which installs a document-level click listener
 * that swallows EVERY same-origin anchor click:
 *
 *   ev.preventDefault();
 *   navigate(href);        // astro:transitions/client
 *
 * and `navigate()` short-circuits a same-path/same-search link that only
 * changes the fragment to `history.pushState(..., to.href)`. `pushState` fires
 * neither `hashchange` nor `popstate`, so the URL flips while every
 * `hashchange` subscriber keeps the old value until a reload.
 *
 * Installing this stand-in reproduces that environment, so a hash-anchor test
 * fails for the same reason the product does.
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
