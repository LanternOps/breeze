import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Keyboard behavior for a small action menu (`role="menu"`), per the WAI-ARIA
 * menu-button pattern: the first enabled item receives focus when the menu
 * opens, ArrowUp/ArrowDown cycle through items, Home/End jump to the ends, and
 * Tab closes the menu (focus then moves on naturally). Escape stays with the
 * caller's existing document-level handler, which should also refocus the
 * trigger. Menu items must carry `role="menuitem"` and `tabIndex={-1}` so Tab
 * can never land mid-menu.
 */
export function useMenuKeyboard(open: boolean, onClose: () => void) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus the first enabled item on open — without this, focus stays on the
    // trigger and the arrow keys have nothing to operate on.
    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Tab') { onClose(); }
  }, [onClose]);

  return { listRef, onKeyDown };
}
