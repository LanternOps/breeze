import { overflowTabId } from "../shared/OverflowTabs";

// DeviceDetails renders its tab bar with `testIdPrefix="device-tab-"`, so a
// tab's button carries `id={overflowTabId(tab, "device-tab-")}`. When the tab
// is collapsed into "More", OverflowTabs moves that id onto the More button,
// so the lookup still lands on the tab bar.
const DEVICE_TAB_PREFIX = "device-tab-";

/** DOM id of the Details tab's "Warranty & purchase" section (DeviceWarrantyCard). */
export const DEVICE_WARRANTY_SECTION_ID = "device-warranty";

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Switches the device page to `tab` and makes the switch visible.
 *
 * Writing the hash is enough when it changes (DeviceDetails follows it via
 * `hashchange`), but choosing the tab you are already on fires no event, so
 * nothing would happen while the user sits scrolled far down the tab. Either
 * way the tab's button is scrolled to the top of the viewport, with the tab's
 * content right below it, and takes keyboard focus.
 *
 * With `sectionId`, that section of the tab is the target instead, when it is
 * on the page by the next frame (it must be focusable: `tabIndex={-1}`). A
 * section that is still loading falls back to the tab's button.
 *
 * Deferred a frame: the actions menu or popover returns focus to its trigger
 * and closes after the action runs, which would undo a synchronous focus.
 */
export function revealDeviceTab(tab: string, sectionId?: string): void {
  window.location.hash = tab;
  window.requestAnimationFrame(() => {
    const target =
      (sectionId ? document.getElementById(sectionId) : null) ??
      document.getElementById(overflowTabId(tab, DEVICE_TAB_PREFIX));
    if (!target) return;
    // Focus first without scrolling: a plain focus() jumps instantly and
    // would cancel the smooth scroll.
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({
      block: "start",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  });
}
