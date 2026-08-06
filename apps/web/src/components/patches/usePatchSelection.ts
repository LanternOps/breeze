import { useState, useCallback, useMemo } from 'react';

/**
 * Checkbox selection for the patch table.
 *
 * `filteredIds` is the *current page* — the header checkbox and its
 * indeterminate state describe that page only. `matchingIds` is every patch
 * that survives the active filters across all pages; it backs the
 * "select all N matching" escape hatch, without which approving a catalog
 * larger than one page means one select-all click per page (#3157).
 * Selection itself is a Set that persists across page changes either way.
 */
export function usePatchSelection(filteredIds: string[], matchingIds: string[] = filteredIds) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const pageIds = useMemo(() => new Set(filteredIds), [filteredIds]);
  const allPageSelected = filteredIds.length > 0 && filteredIds.every(id => selectedIds.has(id));
  const somePageSelected = filteredIds.some(id => selectedIds.has(id));
  const allMatchingSelected =
    matchingIds.length > 0 && matchingIds.every(id => selectedIds.has(id));

  const selectAllMatching = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const id of matchingIds) next.add(id);
      return next;
    });
  }, [matchingIds]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }, [allPageSelected, pageIds]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  return {
    selectedIds,
    setSelectedIds,
    allPageSelected,
    somePageSelected,
    allMatchingSelected,
    selectAllMatching,
    toggleSelect,
    toggleSelectAll,
    clearSelection,
  };
}
