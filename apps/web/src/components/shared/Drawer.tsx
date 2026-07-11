import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

// Chrome/animation/a11y were copied from settings/CatalogItemEditorDrawer.tsx,
// which still carries its own inline copy and was NOT migrated onto this
// primitive — the two are independent duplicates; changes here do not
// propagate there.
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Tailwind max-width class for the panel. */
  width?: string;
  dataTestId?: string;
  /** Blocks backdrop-click close (e.g. while a mutation is in flight). */
  closeDisabled?: boolean;
  children: ReactNode;
}

export function Drawer({
  open,
  onClose,
  title,
  width = 'max-w-md',
  dataTestId = 'drawer',
  closeDisabled = false,
  children,
}: DrawerProps) {
  const { t } = useTranslation('common');
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const titleId = useId();

  // ---- a11y: focus, scroll-lock, escape, focus-trap -----------------------
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    const raf = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panelRef.current)?.focus();
    });
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = '';
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last!.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first!.focus();
        }
      }
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget && !closeDisabled) onClose();
    },
    [onClose, closeDisabled],
  );

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex justify-end bg-background/80"
      style={{ animation: 'dialog-backdrop-in 150ms ease-out' }}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      data-testid={`${dataTestId}-backdrop`}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`drawer-panel flex h-full w-full ${width} flex-col border-l bg-card shadow-xl focus:outline-hidden`}
        style={{ animation: 'slide-in-from-right 220ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        data-testid={dataTestId}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 id={titleId} className="min-w-0 text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('actions.close')}
            data-testid={`${dataTestId}-close`}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export default Drawer;
