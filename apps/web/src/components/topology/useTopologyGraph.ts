import { useCallback, useEffect, useRef, useState } from 'react';
import { graphResponseSchema } from '@breeze/shared/validators/topology';
import type { GraphResponse, TopologyView } from '@breeze/shared';
import { topologyApi, topologyHealthSchema, topologyRead, TopologyReadError } from './topologyApi';

/** Passive reads only. Health updates preserve structure and never trigger layout. */
export function useTopologyGraph(scope: { siteId: string }, query: { view: TopologyView; focusNodeId?: string }, enabled = true) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const graphRef = useRef(graph); graphRef.current = graph;
  const [refresh, setRefresh] = useState(0);
  const activeScope = useRef('');
  const scopeKey = `${scope.siteId}/${query.view}/${query.focusNodeId ?? ''}`;
  const refreshGraph = useCallback(() => setRefresh((n) => n + 1), []);
  useEffect(() => {
    activeScope.current = scopeKey; setGraph(null); setError(null);
  }, [scopeKey]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let graphBusy = false, healthBusy = false;
    const valid = () => !controller.signal.aborted && activeScope.current === scopeKey;
    const fail = (cause: unknown) => {
      if (!valid()) return;
      if (cause instanceof TopologyReadError && [401, 403, 404].includes(cause.status)) setGraph(null);
      setError(cause instanceof Error ? cause.message : 'Unable to load topology');
    };
    const structure = async () => {
      if (document.hidden || graphBusy) return;
      graphBusy = true; if (!graphRef.current) setLoading(true);
      try {
        const params = new URLSearchParams({ view: query.view, includeHealth: 'true', ...(query.focusNodeId ? { focusNodeId: query.focusNodeId, hops: '1' } : {}) });
        const next = await topologyApi.graph(scope.siteId, params, controller.signal);
        if (valid()) { setGraph(next); setError(null); }
      } catch (cause) { fail(cause); }
      finally { graphBusy = false; if (valid()) setLoading(false); }
    };
    const health = async () => {
      const current = graphRef.current;
      if (document.hidden || !current || current.siteId !== scope.siteId || healthBusy) return;
      healthBusy = true;
      try {
        const params = new URLSearchParams({ nodeIds: current.nodes.map((n) => n.id).join(','), relationshipIds: current.relationships.map((r) => r.id).join(','), graphRevision: current.revisions.graph });
        const next = await topologyRead(`/topology/sites/${scope.siteId}/health?${params}`, topologyHealthSchema, controller.signal);
        if (valid()) setGraph((latest) => {
          if (!latest || latest.revisions.graph !== next.graphRevision) return latest;
          const nodes = new Map(next.nodes.map((n) => [n.id, n.health])), edges = new Map(next.relationships.map((r) => [r.id, r.health]));
          return { ...latest, revisions: { ...latest.revisions, health: next.healthRevision }, nodes: latest.nodes.map((n) => ({ ...n, health: nodes.get(n.id) ?? n.health })), relationships: latest.relationships.map((r) => ({ ...r, health: edges.get(r.id) ?? r.health })) };
        });
      } catch (cause) { fail(cause); }
      finally { healthBusy = false; }
    };
    void structure();
    const structuralTimer = setInterval(() => void structure(), 60_000), healthTimer = setInterval(() => void health(), 15_000);
    const visibility = () => { if (!document.hidden) { void structure(); void health(); } };
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); clearInterval(structuralTimer); clearInterval(healthTimer); document.removeEventListener('visibilitychange', visibility); };
  }, [scopeKey, enabled, refresh]);
  const expand = async (token: string) => {
    const key = activeScope.current;
    try {
      const next = await topologyRead(`/topology/sites/${scope.siteId}/expansions/${encodeURIComponent(token)}`, graphResponseSchema);
      if (key === activeScope.current) setGraph(next);
    } catch (cause) { if (key === activeScope.current) setError(cause instanceof Error ? cause.message : 'Unable to expand topology'); }
  };
  return { graph, loading, error, refreshGraph, expand };
}
