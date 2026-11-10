import { useEffect } from 'react';
import { isFormDirtyBlocking, shouldHandleBareKey } from '@/lib/keyboard/bareKeyGuard';
import { QUEUE_SHORTCUTS, type QueueAction } from './queueShortcuts';

export interface QueueKeyboardHandlers {
  onMove: (delta: 1 | -1) => void;
  onOpen: () => void;
  onAssignMe: () => void;
  onFocusReply: () => void;
  onFocusInternal: () => void;
  onResolve: () => void;
  /** `x`: add/remove the active ticket from the bulk selection. */
  onToggleBulk?: () => void;
  onEscape: () => void;
}

const ACTION_BY_KEY = new Map<string, QueueAction>(
  QUEUE_SHORTCUTS.flatMap((s) => s.keys.map((key) => [key, s.action] as const))
);

/** Elements whose own activation key is Enter. Queue rows (role=option) are
 *  not here: Enter on a row is the "open full page" shortcut. */
const ENTER_OWNERS =
  'a[href],button,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],' +
  '[role="menuitemcheckbox"],[role="menuitemradio"],[role="checkbox"],[role="radio"],[role="switch"]';
/** Composite widgets that move their own focus with the arrow keys. */
const ARROW_OWNERS =
  '[role="radiogroup"],[role="tablist"],[role="menu"],[role="menubar"],[role="grid"],' +
  '[role="tree"],[role="treegrid"],[role="slider"]';

function ownedByFocus(e: KeyboardEvent): boolean {
  const el = e.target instanceof Element ? e.target : document.activeElement;
  if (!el || el === document.body) return false;
  if (e.key === 'Enter') return el.closest(ENTER_OWNERS) !== null;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return el.closest(ARROW_OWNERS) !== null;
  return false;
}

export function useQueueKeyboard(h: QueueKeyboardHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // j/k only move the selection and must keep working when held down, so
      // they skip the typing-cadence check (they still feed the clock).
      const bare = shouldHandleBareKey(e, { ignoreCadence: e.key === 'j' || e.key === 'k' });
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { h.onEscape(); return; } // Escape works even from inputs (blur + back)
      if (!bare || isFormDirtyBlocking()) return;
      const action = ACTION_BY_KEY.get(e.key);
      if (!action || ownedByFocus(e)) return;
      if (action === 'toggleBulk' && !h.onToggleBulk) return;
      e.preventDefault();
      switch (action) {
        case 'next': h.onMove(1); break;
        case 'previous': h.onMove(-1); break;
        case 'open': h.onOpen(); break;
        case 'assignMe': h.onAssignMe(); break;
        case 'reply': h.onFocusReply(); break;
        case 'internal': h.onFocusInternal(); break;
        case 'resolve': h.onResolve(); break;
        case 'toggleBulk': h.onToggleBulk?.(); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [h]);
}
