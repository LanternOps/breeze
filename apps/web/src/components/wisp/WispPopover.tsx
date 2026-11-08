import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** One elevation (a border, no shadow) and the popover surface tokens. */
export const WISP_POPOVER_SURFACE = 'rounded-lg border bg-popover text-popover-foreground';

type PanelProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  testId?: string;
  className?: string;
  /** Clicks inside this element do not count as outside (the trigger's wrapper); defaults to the panel. */
  containerRef?: RefObject<HTMLElement | null>;
  /** Where Escape returns focus. Defaults to whatever had focus when the panel opened. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  id?: string;
  children: ReactNode;
};

/**
 * A non-modal dialog floating over the page (the docked pane's popovers,
 * #critique). Focus moves to its first control on open; Escape closes it and
 * returns focus; a mousedown outside closes it, except one inside a modal
 * dialog opened from it (the step-up modal, a confirm), which owns the
 * interaction. Positioning is the caller's (`className`).
 */
export function WispPopoverPanel({ open, onClose, label, testId, className = '', containerRef, returnFocusRef, id, children }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreRef.current = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const inside = containerRef?.current ?? panelRef.current;
      if (inside?.contains(target)) return;
      if (target instanceof Element && target.closest('[aria-modal="true"]')) return;
      onCloseRef.current();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, containerRef, returnFocusRef]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCloseRef.current();
    restoreRef.current?.focus();
  };

  if (!open) return null;
  return (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      tabIndex={-1}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={`z-30 focus:outline-hidden ${WISP_POPOVER_SURFACE} ${className}`}
    >
      {children}
    </div>
  );
}

type PopoverProps = {
  /** Accessible name of the dialog. */
  label: string;
  /** Accessible name of the trigger, when its content alone does not say it. */
  triggerLabel?: string;
  trigger: ReactNode;
  triggerClassName: string;
  testId?: string;
  panelTestId?: string;
  panelClassName: string;
  /** Shown and announced (`aria-disabled`, the reason as the tooltip) but never opens. */
  disabledReason?: string | null;
  /** A function child gets `close`, which also returns focus to the trigger. */
  children: ReactNode | ((close: () => void) => ReactNode);
};

/** A trigger button plus its {@link WispPopoverPanel}; a second click on the trigger closes it. */
export function WispPopover({ label, triggerLabel, trigger, triggerClassName, testId, panelTestId, panelClassName, disabledReason = null, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const disabled = disabledReason !== null;

  const dismiss = useCallback(() => setOpen(false), []);
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <div ref={rootRef} className="relative flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={triggerLabel}
        aria-disabled={disabled ? 'true' : undefined}
        title={disabledReason ?? triggerLabel ?? label}
        onClick={() => { if (!disabled) setOpen((v) => !v); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      <WispPopoverPanel
        open={open && !disabled}
        onClose={dismiss}
        label={label}
        testId={panelTestId}
        id={panelId}
        containerRef={rootRef}
        returnFocusRef={triggerRef}
        className={`absolute ${panelClassName}`}
      >
        {typeof children === 'function' ? children(close) : children}
      </WispPopoverPanel>
    </div>
  );
}
