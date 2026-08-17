import { useEffect } from 'react';

// Opt-in lift for the global toast anchor (#2151).
//
// ToastContainer sits bottom-right and reads its offset from the
// `--breeze-toast-bottom` CSS variable (see the rule in styles/globals.css).
// A page whose sticky right rail is bottom-anchored — today only the quote
// editor's Live totals + Terms panel — would otherwise have the toast land on
// top of the rail's interactive controls on shorter viewports. z-index was
// never the fix: the toast is *supposed* to be on top, so the anchor is what
// has to move.
//
// This used to be a flat `lg:bottom-24` on the shared container, which meant one
// page's layout moved every page's toasts, and the next page to grow a right
// rail would have re-litigated that single number. Owning the lift here keeps
// the container generic: the page that has the rail declares it, for as long as
// it is mounted.
//
// Deliberately a separate module from Toast.tsx: the toast bus module is mocked
// wholesale (`vi.mock('../../shared/Toast')`) by a large number of suites, and a
// layout hook exported from there would break every one of them.

const RAIL_OFFSET_ATTR = 'data-toast-rail';

// Refcounted: two rail-bearing islands can be mounted at once (e.g. an editor
// remounting while the old tree is still tearing down), and the first unmount
// must not drop the offset out from under the other.
let holders = 0;

/** Lift the global toast anchor while the calling component is mounted. Call
 *  from any page that renders a sticky bottom-anchored right rail. */
export function useToastRailOffset(): void {
  useEffect(() => {
    holders += 1;
    document.documentElement.setAttribute(RAIL_OFFSET_ATTR, '');
    return () => {
      holders -= 1;
      if (holders <= 0) {
        holders = 0;
        document.documentElement.removeAttribute(RAIL_OFFSET_ATTR);
      }
    };
  }, []);
}
