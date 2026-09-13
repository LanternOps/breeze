import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useMenuKeyboard } from '../billing/shared/menuKeyboard';

export interface ActionMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  /** `destructive` renders the item in the destructive colour: reserve it for
   *  actions that cannot be undone (merge), not for reversible ones (archive). */
  tone?: 'default' | 'destructive';
  testId?: string;
}

export interface ActionMenuProps {
  /** Accessible name of the trigger, e.g. "More actions". */
  label: string;
  items: ActionMenuItem[];
  testId?: string;
  /** Classes on the trigger button. Defaults to the secondary-button look. */
  triggerClassName?: string;
}

/**
 * Overflow menu for a header's rare actions, per the WAI-ARIA menu-button
 * pattern: trigger carries `aria-haspopup="menu"` + `aria-expanded`, the popup
 * is `role="menu"` of `role="menuitem"`s, the first item takes focus on open,
 * Arrow/Home/End move between items, Tab and an outside click close, and
 * Escape closes and returns focus to the trigger. Renders nothing when there
 * are no items, so callers can pass a permission-filtered list without
 * guarding the trigger themselves.
 */
export function ActionMenu({ label, items, testId, triggerClassName }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const { listRef, onKeyDown: onMenuKeyDown } = useMenuKeyboard(open, close);

  useEffect(() => {
    if (!open) return;
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentMouseDown);
    return () => document.removeEventListener('mousedown', onDocumentMouseDown);
  }, [open]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    onMenuKeyDown(event);
  };

  if (items.length === 0) return null;

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
        onClick={() => setOpen((value) => !value)}
        className={
          triggerClassName ??
          'inline-flex h-9 items-center justify-center rounded-md border bg-background px-2.5 text-sm font-medium transition hover:bg-muted'
        }
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={listRef}
          role="menu"
          aria-label={label}
          onKeyDown={handleKeyDown}
          className="absolute right-0 z-20 mt-1 min-w-44 overflow-hidden rounded-md border bg-popover py-1 shadow-md"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-testid={item.testId}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`block w-full whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent ${
                item.tone === 'destructive' ? 'text-destructive' : ''
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
