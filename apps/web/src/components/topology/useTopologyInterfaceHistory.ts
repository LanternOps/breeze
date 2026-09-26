import { useEffect, useState } from 'react';
import type { TopologyInterfaceHistoryResponse } from '@breeze/shared';
import { interfaceHistoryParams, topologyApi, type InterfaceHistoryParams } from './topologyApi';

/**
 * Minimal passive data hook for one interface's bounded history (M3 Task 6).
 * One GET per (site, interface, query); no polling — history is on demand and
 * a read never triggers a poll server-side. Panels arrive in Task 11.
 */
export function useTopologyInterfaceHistory(scope: { siteId: string }, interfaceId: string | null, query: InterfaceHistoryParams) {
  const [history, setHistory] = useState<TopologyInterfaceHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = interfaceId ? `${scope.siteId}/${interfaceId}?${interfaceHistoryParams(query)}` : '';
  useEffect(() => {
    setHistory(null); setError(null);
    if (!interfaceId) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    topologyApi.interfaceHistory(scope.siteId, interfaceId, query, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setHistory(next); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load interface history'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [key]);
  return { history, loading, error };
}
