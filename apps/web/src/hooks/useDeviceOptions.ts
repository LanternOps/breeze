import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceOption, DeviceOptionPage } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';

const DEFAULT_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 250;

export type DeviceOptionsState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'stale'
  | 'truncated';

export type UseDeviceOptionsInput = {
  search?: string;
  status?: string;
  siteId?: string;
  osType?: string;
  orgId?: string;
  includeIds?: string[];
  limit?: number;
  enabled?: boolean;
  requireCompleteSet?: boolean;
};

export type UseDeviceOptionsResult = {
  options: DeviceOption[];
  page: DeviceOptionPage['page'] | null;
  state: DeviceOptionsState;
  error: Error | null;
  canSubmit: boolean;
  loadMore(): Promise<void>;
  retry(): void;
};

type InternalState = Omit<UseDeviceOptionsResult, 'canSubmit' | 'loadMore' | 'retry'>;

const INITIAL_STATE: InternalState = {
  options: [],
  page: null,
  state: 'loading',
  error: null,
};

function normalizeSearch(search: string | undefined): string {
  return search?.trim() ?? '';
}

function normalizeIncludeIds(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))].sort();
}

function mergeOptions(current: readonly DeviceOption[], incoming: readonly DeviceOption[]): DeviceOption[] {
  const byId = new Map<string, DeviceOption>();
  for (const item of current) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

function hasUnresolvedIds(options: readonly DeviceOption[], includeIds: readonly string[]): boolean {
  if (includeIds.length === 0) return false;
  const resolved = new Set(options.map((item) => item.id));
  return includeIds.some((id) => !resolved.has(id));
}

function settledState(
  options: readonly DeviceOption[],
  includeIds: readonly string[],
): DeviceOptionsState {
  if (hasUnresolvedIds(options, includeIds)) return 'truncated';
  return options.length === 0 ? 'empty' : 'ready';
}

async function responseError(response: Response): Promise<Error> {
  let detail = '';
  try {
    const body = await response.json() as { error?: unknown; message?: unknown };
    const candidate = body.error ?? body.message;
    if (typeof candidate === 'string') detail = candidate;
  } catch {
    // A status is still enough to produce a stable, actionable error.
  }
  return new Error(detail || `Device options request failed (${response.status})`);
}

function isDeviceOptionPage(value: unknown): value is DeviceOptionPage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DeviceOptionPage>;
  return Array.isArray(candidate.data)
    && !!candidate.page
    && typeof candidate.page === 'object'
    && typeof candidate.page.hasMore === 'boolean'
    && typeof candidate.page.total === 'number';
}

export function useDeviceOptions(input: UseDeviceOptionsInput = {}): UseDeviceOptionsResult {
  const rawSearch = normalizeSearch(input.search);
  const [debouncedSearch, setDebouncedSearch] = useState(rawSearch);
  const includeIdsKey = normalizeIncludeIds(input.includeIds).join(',');
  const includeIds = useMemo(
    () => includeIdsKey ? includeIdsKey.split(',') : [],
    [includeIdsKey],
  );
  // The route intentionally caps label hydration at 500 IDs. A larger set is
  // safe only when those IDs are already present in this query's loaded pages;
  // otherwise the unhydrated remainder keeps the hook truncated.
  const requestIncludeIdsKey = includeIds.slice(0, 500).join(',');
  const enabled = input.enabled ?? true;
  const limit = input.limit ?? DEFAULT_LIMIT;

  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [retryGeneration, setRetryGeneration] = useState(0);
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const loadingMore = useRef(false);
  const settledScopeKey = useRef<string | null>(null);
  const observedRetryGeneration = useRef(0);
  const pendingSearch = useRef(false);

  const supportingScopeKey = [
    debouncedSearch,
    input.status ?? '',
    input.siteId ?? '',
    input.osType ?? '',
    input.orgId ?? '',
    String(limit),
    enabled ? 'enabled' : 'disabled',
  ].join('\u0000');

  // Search changes invalidate the old supporting scope immediately, while the
  // network request itself remains debounced. That prevents a user from
  // submitting labels from the old search during the debounce window.
  useEffect(() => {
    if (rawSearch === debouncedSearch) {
      if (!pendingSearch.current) return;
      pendingSearch.current = false;
      if (settledScopeKey.current === supportingScopeKey) {
        setState((current) => ({
          ...current,
          state: settledState(current.options, includeIds),
          error: null,
        }));
      } else {
        // The request invalidated by the abandoned search had not settled (or
        // another scope field also changed), so restart the current query.
        setRetryGeneration((generation) => generation + 1);
      }
      return;
    }

    pendingSearch.current = true;
    requestGeneration.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    setState((current) => ({
      ...current,
      state: current.options.length > 0 ? 'stale' : 'loading',
      error: null,
    }));

    const timeout = window.setTimeout(() => {
      pendingSearch.current = false;
      setDebouncedSearch(rawSearch);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [rawSearch, debouncedSearch, includeIds, supportingScopeKey]);

  const requestKey = [
    supportingScopeKey,
    includeIdsKey,
    String(retryGeneration),
  ].join('\u0000');

  const buildUrl = useCallback((cursor?: string | null) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (input.status) params.set('status', input.status);
    if (input.siteId) params.set('siteId', input.siteId);
    if (input.osType) params.set('osType', input.osType);
    if (input.orgId) params.set('orgId', input.orgId);
    if (requestIncludeIdsKey) params.set('includeIds', requestIncludeIdsKey);
    if (cursor) params.set('cursor', cursor);
    return `/devices/options?${params.toString()}`;
  }, [debouncedSearch, input.orgId, input.osType, input.siteId, input.status, limit, requestIncludeIdsKey]);

  useEffect(() => {
    const isRetry = retryGeneration !== observedRetryGeneration.current;
    observedRetryGeneration.current = retryGeneration;

    // Selecting rows that are already loaded must not issue a hydration query.
    // Besides avoiding needless work, this is what makes an exhaustive 10k-row
    // selection compatible with the endpoint's 500-ID hydration cap.
    const loadedIds = new Set(stateRef.current.options.map((option) => option.id));
    const selectionAlreadyResolved = includeIds.every((id) => loadedIds.has(id));
    if (
      enabled
      && !isRetry
      && settledScopeKey.current === supportingScopeKey
      && selectionAlreadyResolved
    ) {
      const controller = new AbortController();
      activeController.current = controller;
      setState((current) => ({
        ...current,
        state: settledState(current.options, includeIds),
        error: null,
      }));
      return () => controller.abort();
    }

    const generation = ++requestGeneration.current;
    activeController.current?.abort();
    loadingMore.current = false;

    if (!enabled) {
      activeController.current = null;
      setState({
        options: [],
        page: null,
        state: includeIds.length > 0 ? 'truncated' : 'empty',
        error: null,
      });
      return;
    }

    const controller = new AbortController();
    activeController.current = controller;
    setState((current) => ({
      ...current,
      state: current.options.length > 0 ? 'stale' : 'loading',
      error: null,
    }));

    const run = async () => {
      try {
        const response = await fetchWithAuth(buildUrl(), { signal: controller.signal });
        if (generation !== requestGeneration.current) return;
        if (!response.ok) throw await responseError(response);

        const body: unknown = await response.json();
        if (generation !== requestGeneration.current) return;
        if (!isDeviceOptionPage(body)) throw new Error('Device options response was malformed');

        settledScopeKey.current = supportingScopeKey;
        setState({
          options: mergeOptions([], body.data),
          page: body.page,
          state: settledState(body.data, includeIds),
          error: null,
        });
      } catch (error) {
        if (generation !== requestGeneration.current || controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          state: 'error',
          error: error instanceof Error ? error : new Error('Device options request failed'),
        }));
      }
    };

    void run();
    return () => controller.abort();
  }, [requestKey, buildUrl, enabled, includeIds, retryGeneration, supportingScopeKey]);

  const loadMore = useCallback(async () => {
    const cursor = state.page?.nextCursor;
    const controller = activeController.current;
    if (!enabled || !cursor || !controller || controller.signal.aborted || loadingMore.current) return;

    loadingMore.current = true;
    const generation = requestGeneration.current;
    try {
      const response = await fetchWithAuth(buildUrl(cursor), { signal: controller.signal });
      if (generation !== requestGeneration.current) return;
      if (!response.ok) throw await responseError(response);

      const body: unknown = await response.json();
      if (generation !== requestGeneration.current) return;
      if (!isDeviceOptionPage(body)) throw new Error('Device options response was malformed');

      setState((current) => {
        const options = mergeOptions(current.options, body.data);
        return {
          options,
          page: body.page,
          state: settledState(options, includeIds),
          error: null,
        };
      });
    } catch (error) {
      if (generation !== requestGeneration.current || controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        state: 'error',
        error: error instanceof Error ? error : new Error('Device options request failed'),
      }));
    } finally {
      if (generation === requestGeneration.current) loadingMore.current = false;
    }
  }, [buildUrl, enabled, includeIds, state.page?.nextCursor]);

  const retry = useCallback(() => {
    setState((current) => ({
      ...current,
      state: current.options.length > 0 ? 'stale' : 'loading',
      error: null,
    }));
    setRetryGeneration((generation) => generation + 1);
  }, []);

  const resultState = state.state !== 'error'
    && state.state !== 'loading'
    && state.state !== 'stale'
    && input.requireCompleteSet
    && state.page?.hasMore
      ? 'truncated'
      : state.state;
  const canSubmit = resultState === 'ready' || resultState === 'empty';

  return {
    options: state.options,
    page: state.page,
    state: resultState,
    error: state.error,
    canSubmit,
    loadMore,
    retry,
  };
}
