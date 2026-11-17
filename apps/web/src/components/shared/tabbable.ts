const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The genuinely TABBABLE nodes under `root`, in DOM order — what a focus trap
 * wraps between.
 *
 * `FOCUSABLE` alone is not that list. Its `button:not([disabled])` clause
 * matches a button whatever its tabindex, so a roving-tabindex radiogroup — the
 * pattern every option-card group in this app uses — contributes its
 * `tabindex="-1"` members too. Initial focus then landed on an UNSELECTED
 * option, and the group's own arrow handler moved selection off it on the first
 * ArrowRight: one keystroke from silently changing a privileged choice.
 * `node.tabIndex` reads the resolved value, so this filter is what the
 * selector's `[tabindex]:not([tabindex="-1"])` clause was always meant to do.
 *
 * Nodes inside an `inert` subtree (a collapsed nav section) are skipped too:
 * the browser refuses to focus them, so a trap that picked one as its first or
 * last stop never matched `document.activeElement` and let focus escape.
 */
export function tabbableNodes(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.tabIndex >= 0 && !node.closest('[inert]'),
  );
}
