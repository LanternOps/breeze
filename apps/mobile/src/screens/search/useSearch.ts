import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import {
  createSearchCoordinator,
  type SearchCoordinator,
  type SearchSnapshot,
} from './searchCoordinator';

export interface UseSearchHandle extends SearchSnapshot {
  setQuery: (q: string) => void;
  clear: () => void;
}

/**
 * React-side wrapper around the pure search coordinator. Keeps the hook
 * surface minimal (query / results / loading / error) and delegates all
 * timing/abort coordination to searchCoordinator.ts so it can be tested
 * without a React renderer.
 */
export function useSearch(): UseSearchHandle {
  const coordRef = useRef<SearchCoordinator | null>(null);
  if (!coordRef.current) {
    coordRef.current = createSearchCoordinator();
  }
  const coord = coordRef.current;

  useEffect(() => {
    return () => {
      coord.destroy();
    };
  }, [coord]);

  const subscribe = useCallback(
    (listener: () => void) => coord.subscribe(() => listener()),
    [coord],
  );
  const snapshot = useSyncExternalStore(subscribe, coord.getSnapshot, coord.getSnapshot);

  const setQuery = useCallback((q: string) => coord.setQuery(q), [coord]);
  const clear = useCallback(() => coord.clear(), [coord]);

  return { ...snapshot, setQuery, clear };
}
