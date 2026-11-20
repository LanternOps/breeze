// A header fact that opens a small read-only panel: a non-modal disclosure,
// not a dialog. No focus trap; Escape and an outside click close it, and
// Escape hands focus back to the chip. Edits never happen in the panel — it
// links to the place the record is edited.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export type FactTone = 'neutral' | 'success' | 'warning' | 'danger';

// Tone tints the ICON only: amber text on a light card is ~2.3:1, under the
// 4.5:1 floor, so the words stay in the foreground colour.
const TONE_CLASS: Record<FactTone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
};

const PANEL_WIDTH_PX = 288; // w-72

export function FactPopover({
  icon,
  children,
  panel,
  tone = 'neutral',
  testId,
  label,
}: {
  icon: ReactNode;
  /** The chip's visible text. */
  children: ReactNode;
  /** Panel content, rendered only while open. */
  panel: ReactNode;
  tone?: FactTone;
  testId: string;
  /** Accessible name when the visible text alone is ambiguous. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Panel opens left-aligned under the chip unless that would run past the
  // viewport's right edge (a chip at the end of a wrapped row), then right-aligned.
  const [alignRight, setAlignRight] = useState(false);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setAlignRight(rect.left + PANEL_WIDTH_PX + 16 > window.innerWidth);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex min-w-0">
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1.5 inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-foreground hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
      >
        <span className={`shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5 ${TONE_CLASS[tone]}`} aria-hidden="true">{icon}</span>
        <span className="min-w-0 truncate">{children}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={panelId}
          data-testid={`${testId}-panel`}
          className={`absolute ${alignRight ? 'right-0' : 'left-0'} top-full z-40 mt-1.5 w-72 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg`}
        >
          {panel}
        </div>
      )}
    </span>
  );
}
