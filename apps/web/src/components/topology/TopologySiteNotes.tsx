import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';

/**
 * A status-row toggle and the panel it opens, floating over the map below it (TopologySiteNotes, TopologySiteRoster).
 * The toggle's wrapper is positioned from `sm` up; on a phone the panel anchors to the status row instead, so it
 * starts at the row's left edge and stays on screen wherever its toggle wrapped to.
 */
export const STATUS_ANCHOR = 'sm:relative';
export const STATUS_TOGGLE = 'inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary aria-expanded:bg-muted';
/** Width is the caller's. */
export const STATUS_PANEL = 'absolute left-0 top-full z-30 mt-1 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-lg';

/**
 * Open state for a status-row disclosure (2026-10-25). Escape closes it and returns focus to its toggle; a press
 * outside it closes it too. Escape is marked handled (preventDefault) so an expanded map (TopologyEntry) stays expanded.
 */
export function useStatusPopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const root = useRef<T>(null), toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault(); setOpen(false); toggle.current?.focus();
  };
  return { open, setOpen, root, toggle, onKeyDown };
}

/**
 * The site's notes behind one toggle in the status row (2026-10-25): what the map cannot draw (no observed link
 * between two networks), the declare-networks hint and ignored declarations. They used to stack as rows above
 * the map and push it under the fold; each sentence is unchanged, one click away. `notes` are `<li>` elements.
 */
export default function TopologySiteNotes({ notes }: { notes: ReactNode[] }) {
  const { t } = useTranslation('topology');
  const { open, setOpen, root, toggle, onKeyDown } = useStatusPopover();
  const panelId = useId();
  if (!notes.length) return null;
  return <div ref={root} className={STATUS_ANCHOR} onKeyDown={onKeyDown}>
    <button ref={toggle} type="button" data-testid="topology-site-notes" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)} className={STATUS_TOGGLE}>
      <Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />{t('grouped.siteNotes', { count: notes.length })}
    </button>
    <ul id={panelId} data-testid="topology-site-notes-panel" hidden={!open} className={`${STATUS_PANEL} w-[28rem] list-outside list-disc space-y-2 pl-7 text-muted-foreground`}>{notes}</ul>
  </div>;
}
