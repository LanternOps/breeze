import { useEffect } from 'react';

export interface QueueKeyboardHandlers {
  onMove: (delta: 1 | -1) => void;
  onOpen: () => void;
  onAssignMe: () => void;
  onFocusReply: () => void;
  onFocusInternal: () => void;
  onResolve: () => void;
  onEscape: () => void;
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (EDITABLE.has(el.tagName) || el.isContentEditable);
}

export function useQueueKeyboard(h: QueueKeyboardHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { h.onEscape(); return; } // Escape works even from inputs (blur + back)
      if (isEditing()) return;
      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); h.onMove(1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); h.onMove(-1); break;
        case 'Enter': case 'o': e.preventDefault(); h.onOpen(); break;
        case 'a': e.preventDefault(); h.onAssignMe(); break;
        case 'r': e.preventDefault(); h.onFocusReply(); break;
        case 'n': e.preventDefault(); h.onFocusInternal(); break;
        case 'e': e.preventDefault(); h.onResolve(); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [h]);
}
