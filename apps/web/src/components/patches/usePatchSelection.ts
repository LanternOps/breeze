import { useState, useCallback, useMemo } from 'react';

export function usePatchSelection(filteredIds: string[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const pageIds = useMemo(() => new Set(filteredIds), [filteredIds]);
  const allPageSelected = filteredIds.length > 0 && filteredIds.every(id => selectedIds.has(id));
  const somePageSelected = filteredIds.some(id => selectedIds.has(id));

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
    toggleSelect,
    toggleSelectAll,
    clearSelection,
  };
}
