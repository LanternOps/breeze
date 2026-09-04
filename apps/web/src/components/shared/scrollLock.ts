/**
 * Refcounted <body> scroll lock shared by every overlay (Dialog, Drawer).
 *
 * Overlays nest — a ConfirmDialog opened from inside a Drawer is the common
 * case — so each one must hold its own reference; releasing the last one
 * restores scrolling. A per-component `document.body.style.overflow = ''`
 * would let the page scroll behind a still-open parent overlay.
 */
let scrollLockCount = 0;

export function acquireScrollLock(): () => void {
  scrollLockCount++;
  if (scrollLockCount === 1) document.body.style.overflow = 'hidden';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLockCount--;
    if (scrollLockCount === 0) document.body.style.overflow = '';
  };
}

/** Test-only: number of overlays currently holding the lock. */
export function scrollLockHolders(): number {
  return scrollLockCount;
}
