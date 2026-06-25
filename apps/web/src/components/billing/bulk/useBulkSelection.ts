import { useCallback, useState } from 'react';

export interface BulkSelection {
  selectedIds: Set<string>;
  size: number;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clear: () => void;
}

export function useBulkSelection(): BulkSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelectedIds((prev) => new Set([...prev, ...ids]));
  }, []);

  const clear = useCallback(() => setSelectedIds(new Set()), []);
  const has = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  return { selectedIds, size: selectedIds.size, has, toggle, selectAll, clear };
}
