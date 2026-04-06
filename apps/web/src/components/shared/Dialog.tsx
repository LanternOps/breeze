import {
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';

// Reference counter for stacked dialogs — only restore scroll when all dialogs close
let scrollLockCount = 0;

type DialogMaxWidth = 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl';

const maxWidthClass: Record<DialogMaxWidth, string> = {
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Accessible label (used as aria-label) */
  title: string;
  /** Maps to Tailwind max-w-{value}. Default: 'lg' */
  maxWidth?: DialogMaxWidth;
  /** Top-align instead of center (for tall content that scrolls the backdrop) */
  alignTop?: boolean;
  /** Classes on the dialog panel (e.g. 'p-6', 'flex flex-col max-h-[90vh]') */
  className?: string;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  maxWidth = 'lg',
  alignTop = false,
  className = '',
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    const raf = requestAnimationFrame(() => {
      if (!panelRef.current) return;
      const first = panelRef.current.querySelector<HTMLElement>(FOCUSABLE);
      if (first) first.focus();
      else panelRef.current.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    scrollLockCount++;
    if (scrollLockCount === 1) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      scrollLockCount--;
      if (scrollLockCount === 0) {
        document.body.style.overflow = '';
      }
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
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={`dialog-backdrop fixed inset-0 z-50 flex ${
        alignTop ? 'items-start overflow-y-auto' : 'items-center'
      } justify-center bg-background/80 px-4 py-8`}
      style={{ animation: 'dialog-backdrop-in 150ms ease-out' }}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`dialog-panel w-full ${maxWidthClass[maxWidth]} rounded-lg border bg-card shadow-lg focus:outline-none ${className}`}
        style={{ animation: 'dialog-panel-in 200ms cubic-bezier(0.25, 1, 0.5, 1)' }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
