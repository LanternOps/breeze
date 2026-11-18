/**
 * Geometry shared by the panels that dock against the right edge of the
 * dashboard (the AI side panel and the Help panel).
 *
 * The panels start below the app header (`Header.tsx`, `h-16`) rather than at
 * the top of the viewport. Full height from `top-0`, they covered the right end
 * of the header, so the bell, theme and account menu sat under the open panel
 * and a click on them landed on it (#10107). `top-16` must track the header's
 * height; `Header.test.tsx` pins `h-16` for that reason.
 *
 * `max-w-full` keeps the 400px panel inside a phone-width viewport instead of
 * pushing its left edge (title, back button) off-screen.
 */
export const RIGHT_DOCK_PANEL_CLASS =
  'fixed right-0 top-16 bottom-0 z-40 flex w-[400px] max-w-full flex-col border-l bg-card transition-transform duration-300';

/**
 * Below `lg` the open panel dims the page behind it; a click there closes the
 * panel. The scrim starts below the header too, so the header stays usable.
 */
export const RIGHT_DOCK_BACKDROP_CLASS = 'fixed inset-x-0 top-16 bottom-0 z-30 bg-black/30 lg:hidden';
