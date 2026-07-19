import { useState } from 'react';

/**
 * Keyboard selection model shared by the search/browse/recents/filing
 * list-tables: Arrow Up/Down move a single selected row index, Enter
 * activates it (open), Cmd/Ctrl+C copies it, Escape clears the selection.
 * Row rendering (aria-selected, .ws-row-selected) and scroll-into-view are
 * the caller's responsibility — this hook only owns the index + key routing.
 */
export function useListSelection(count: number, h: { onActivate: (i: number) => void; onCopy: (i: number) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => s === null ? 0 : Math.min(count - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => s === null ? 0 : Math.max(0, s - 1)); }
    else if (e.key === 'Enter' && selected !== null) h.onActivate(selected);
    else if (e.key === 'c' && (e.metaKey || e.ctrlKey) && selected !== null) { e.preventDefault(); h.onCopy(selected); }
    else if (e.key === 'Escape') setSelected(null);
  };
  return { selected, setSelected, onKeyDown };
}
