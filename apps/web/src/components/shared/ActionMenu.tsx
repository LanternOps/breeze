import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { useMenuKeyboard } from '../billing/shared/menuKeyboard';

export interface ActionMenuItem {
  id: string;
  label: string;
  /** Second, muted line under the label (e.g. a contact's email and phone). */
  description?: string;
  /** Renders the item as a real link (`<a role="menuitem">`) so `mailto:`/`tel:`
   *  and record links stay middle-clickable. `onSelect` is optional then. */
  href?: string;
  /** Required unless `href` is set; still called (after focus returns to the
   *  trigger) when both are present. */
  onSelect?: () => void;
  /** `destructive` renders the item in the destructive colour: reserve it for
   *  actions that cannot be undone (merge), not for reversible ones (archive). */
  tone?: 'default' | 'destructive';
  /** Draws a divider above this item — grouping without a separate item type. */
  separatorBefore?: boolean;
  testId?: string;
}

export interface ActionMenuProps {
  /** Accessible name of the trigger, e.g. "More actions". */
  label: string;
  items: ActionMenuItem[];
  testId?: string;
  /** Classes on the trigger button. Defaults to the secondary-button look. */
  triggerClassName?: string;
  /** Tab index of the trigger; a roving-tabindex row passes -1 for every row but the active one. */
  triggerTabIndex?: number;
}

/**
 * Overflow menu for a header's or a row's rare actions, per the WAI-ARIA
 * menu-button pattern: trigger carries `aria-haspopup="menu"` + `aria-expanded`,
 * the popup is `role="menu"` of `role="menuitem"`s, the first item takes focus
 * on open, Arrow/Home/End move between items, Tab and an outside click close,
 * and Escape closes and returns focus to the trigger. Renders nothing when there
 * are no items, so callers can pass a permission-filtered list without
 * guarding the trigger themselves.
 *
 * The popup renders through a portal into `document.body` with `position:
 * fixed`, anchored to the trigger's rect. A row menu lives inside
 * `ResponsiveTable`'s `overflow-x-auto` wrapper, and any non-visible overflow
 * on one axis clips BOTH axes — an `absolute` popup was cut off by the table
 * on the last rows. It flips above the trigger when there is no room below,
 * and follows the trigger on scroll/resize.
 */
const MENU_GAP_PX = 4;

export function ActionMenu({ label, items, testId, triggerClassName, triggerTabIndex }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const { listRef, onKeyDown: onMenuKeyDown } = useMenuKeyboard(open, close);

  useEffect(() => {
    if (!open) return;
    const onDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // The popup is portalled out of `rootRef`, so it has to be checked too —
      // otherwise a mousedown on an item closes the menu before its click lands.
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentMouseDown);
    return () => document.removeEventListener('mousedown', onDocumentMouseDown);
  }, [open]);

  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, right: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const menuHeight = listRef.current?.offsetHeight ?? 0;
      const below = rect.bottom + MENU_GAP_PX;
      // Flip above the trigger when the menu would run off the viewport bottom
      // and there is more room above than below.
      const flip = below + menuHeight > window.innerHeight && rect.top > window.innerHeight - rect.bottom;
      setMenuStyle({
        position: 'fixed',
        top: flip ? Math.max(MENU_GAP_PX, rect.top - MENU_GAP_PX - menuHeight) : below,
        right: Math.max(0, window.innerWidth - rect.right),
      });
    };
    place();
    // Capture phase: a scroll inside ANY ancestor (the table's own x-scroller
    // included) moves the trigger, and scroll events do not bubble.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, listRef]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    // The popup is portalled to the end of <body>, so a natural Tab from an
    // item would leave the page. Hand focus to the trigger first (no
    // preventDefault): the browser's Tab / Shift+Tab then moves on from the row.
    if (event.key === 'Tab') triggerRef.current?.focus();
    onMenuKeyDown(event);
  };

  if (items.length === 0) return null;

  const itemClass = (item: ActionMenuItem) =>
    `block w-full whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent ${
      item.tone === 'destructive' ? 'text-destructive' : ''
    }`;

  const activate = (item: ActionMenuItem) => {
    // Focus the trigger BEFORE the item unmounts and before the handler runs:
    // a dialog opened by `onSelect` captures `document.activeElement` on mount
    // as its restore target, and without this it captured <body> (the
    // menuitem was already gone in the same commit).
    triggerRef.current?.focus();
    setOpen(false);
    item.onSelect?.();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        tabIndex={triggerTabIndex}
        onClick={() => setOpen((value) => !value)}
        className={
          triggerClassName ??
          'inline-flex h-9 items-center justify-center rounded-md border bg-background px-2.5 text-sm font-medium transition hover:bg-muted'
        }
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={listRef}
          role="menu"
          aria-label={label}
          onKeyDown={handleKeyDown}
          style={menuStyle}
          className="z-50 min-w-44 overflow-hidden rounded-md border bg-popover py-1 shadow-md"
        >
          {items.map((item) => {
            const body = (
              <>
                {item.label}
                {item.description && <span className="block text-xs text-muted-foreground">{item.description}</span>}
              </>
            );
            return (
              <Fragment key={item.id}>
                {item.separatorBefore && <div role="separator" className="my-1 border-t" />}
                {item.href ? (
                  <a role="menuitem" tabIndex={-1} href={item.href} data-testid={item.testId} onClick={() => activate(item)} className={itemClass(item)}>
                    {body}
                  </a>
                ) : (
                  <button type="button" role="menuitem" tabIndex={-1} data-testid={item.testId} onClick={() => activate(item)} className={itemClass(item)}>
                    {body}
                  </button>
                )}
              </Fragment>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
