import { searchAll, type MobileSearchResult } from '../../services/search';

/**
 * Pure coordinator for the search input → debounce → fetch → result lifecycle.
 *
 * Pulled out of useSearch so we can test the timing/abort logic without a
 * React renderer. The hook is just a thin shell that wires this to React
 * state via subscribe(). Anyone testing or driving searches outside React
 * (e.g. a future widget surface) can use the coordinator directly.
 */

export interface SearchSnapshot {
  query: string;
  results: MobileSearchResult[];
  loading: boolean;
  error: string | null;
}

export interface SearchCoordinatorOptions {
  debounceMs?: number;
  limit?: number;
  // Override for tests: lets us inject a fake searcher with no fetch.
  searcher?: (
    q: string,
    limit: number,
    signal: AbortSignal,
  ) => Promise<{ results: MobileSearchResult[] }>;
}

export interface SearchCoordinator {
  setQuery: (q: string) => void;
  clear: () => void;
  destroy: () => void;
  subscribe: (listener: (snap: SearchSnapshot) => void) => () => void;
  getSnapshot: () => SearchSnapshot;
}

const initialSnapshot: SearchSnapshot = {
  query: '',
  results: [],
  loading: false,
  error: null,
};

export function createSearchCoordinator(
  options: SearchCoordinatorOptions = {},
): SearchCoordinator {
  const debounceMs = options.debounceMs ?? 250;
  const limit = options.limit ?? 20;
  const searcher = options.searcher ?? searchAll;

  let snapshot: SearchSnapshot = { ...initialSnapshot };
  const listeners = new Set<(snap: SearchSnapshot) => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let destroyed = false;

  const emit = (next: Partial<SearchSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const l of listeners) l(snapshot);
  };

  const cancelInFlight = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (controller) {
      controller.abort();
      controller = null;
    }
  };

  return {
    setQuery(q: string) {
      if (destroyed) return;
      cancelInFlight();
      const trimmed = q.trim();
      if (!trimmed) {
        emit({ query: q, results: [], loading: false, error: null });
        return;
      }
      emit({ query: q, loading: true, error: null });

      timer = setTimeout(() => {
        const c = new AbortController();
        controller = c;
        searcher(trimmed, limit, c.signal)
          .then((res) => {
            if (c.signal.aborted) return;
            emit({ results: res.results, loading: false, error: null });
          })
          .catch((err: unknown) => {
            if (c.signal.aborted) return;
            if (err instanceof Error && err.name === 'AbortError') return;
            const msg = err instanceof Error ? err.message : 'Search failed.';
            emit({ results: [], loading: false, error: msg });
          });
      }, debounceMs);
    },
    clear() {
      if (destroyed) return;
      cancelInFlight();
      emit({ ...initialSnapshot });
    },
    destroy() {
      destroyed = true;
      cancelInFlight();
      listeners.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
  };
}
