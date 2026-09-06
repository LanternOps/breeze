import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { acquireScrollLock } from './scrollLock';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

// Chrome/animation/a11y were copied from settings/CatalogItemEditorDrawer.tsx,
// which still carries its own inline copy and was NOT migrated onto this
// primitive — the two are independent duplicates; changes here do not
// propagate there.
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The genuinely TABBABLE nodes, in DOM order.
 *
 * `FOCUSABLE` alone is not that list. Its `button:not([disabled])` clause
 * matches a button whatever its tabindex, so a roving-tabindex radiogroup — the
 * pattern every option-card group in this app uses — contributes its
 * `tabindex="-1"` members too. Initial focus then landed on an UNSELECTED
 * option, and the group's own arrow handler moved selection off it on the first
 * ArrowRight: one keystroke from silently changing a privileged choice.
 * `node.tabIndex` reads the resolved value, so this filter is what the
 * selector's `[tabindex]:not([tabindex="-1"])` clause was always meant to do.
 */
function tabbableNodes(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.tabIndex >= 0);
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Tailwind max-width class for the panel. */
  width?: string;
  dataTestId?: string;
  /**
   * Blocks EVERY close affordance — backdrop click, Escape and the header X
   * (e.g. while a mutation is in flight, or while the body holds unsaved work
   * the call site wants resolved deliberately). It used to guard the backdrop
   * alone, which left the two most reflexive exits wide open.
   */
  closeDisabled?: boolean;
  /**
   * Why closing is blocked. Rendered as a real described-by node on the close
   * button rather than a `title=` tooltip, which is invisible to touch and to
   * keyboard users — the repo's tooltip rule.
   */
  closeDisabledReason?: string;
  children: ReactNode;
}

export function Drawer({
  open,
  onClose,
  title,
  width = 'max-w-md',
  dataTestId = 'drawer',
  closeDisabled = false,
  closeDisabledReason,
  children,
}: DrawerProps) {
  const { t } = useTranslation('common');
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const titleId = useId();
  const closeReasonId = useId();

  // ---- a11y: focus, scroll-lock, escape, focus-trap -----------------------
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    const raf = requestAnimationFrame(() => {
      // Review finding #4: search the BODY content first — the header close
      // button used to win here every time (it's first in DOM under the
      // whole-panel FOCUSABLE query), so a drawer that opened onto a form or
      // detail view always put keyboard focus on "exit" instead of the task.
      // Falls back to the panel itself (not the close button) when the body
      // has nothing focusable.
      const [first] = tabbableNodes(bodyRef.current);
      (first ?? panelRef.current)?.focus();
    });
    const releaseScrollLock = acquireScrollLock();
    return () => {
      cancelAnimationFrame(raf);
      releaseScrollLock();
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        // Still swallowed while blocked: the drawer is modal either way, and
        // letting Escape bubble to an outer dialog would close the WRONG thing.
        e.stopPropagation();
        if (!closeDisabled) onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const nodes = tabbableNodes(panelRef.current);
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
    [onClose, closeDisabled],
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
          {/* aria-disabled, never `disabled`: a `disabled` button drops out of
              the focus trap AND out of the accessibility tree, so the one place
              that can explain why the drawer will not close becomes
              unreachable by exactly the users who need it. It stays rendered,
              stays tabbable, and does nothing. */}
          <button
            type="button"
            onClick={() => {
              if (!closeDisabled) onClose();
            }}
            aria-disabled={closeDisabled || undefined}
            aria-describedby={closeDisabled && closeDisabledReason ? closeReasonId : undefined}
            className={`rounded-md p-1.5 text-muted-foreground ${
              closeDisabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-muted hover:text-foreground'
            }`}
            aria-label={t('actions.close')}
            data-testid={`${dataTestId}-close`}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {closeDisabled && closeDisabledReason && (
          <p
            id={closeReasonId}
            // Muted, not the warning tint the blocked ACTION uses in the
            // footer: this is a standing explanation of why the X is inert,
            // and two amber bars in one drawer read as an emergency rather
            // than as a guard.
            className="border-b bg-muted/40 px-5 py-2 text-xs text-muted-foreground"
            data-testid={`${dataTestId}-close-blocked`}
          >
            {closeDisabledReason}
          </p>
        )}
        {/* `display: contents` so this ref wrapper doesn't affect the
            drawer-panel flex layout — children stay direct flex items. */}
        <div ref={bodyRef} className="contents">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default Drawer;
