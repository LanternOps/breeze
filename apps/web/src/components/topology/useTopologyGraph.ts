import { useCallback, useEffect, useRef, useState } from 'react';
import { graphResponseSchema } from '@breeze/shared/validators/topology';
import type { GraphResponse, TopologyView } from '@breeze/shared';
import { topologyApi, topologyHealthSchema, topologyRead, TopologyReadError } from './topologyApi';
import { takePrefetchedGraph } from './topologyPrefetch';

/** Server codes for an expansion token that is no longer usable (graphCursor.ts, graph.ts). */
const STALE_EXPANSION: ReadonlySet<string> = new Set(['invalid_topology_cursor', 'graph_revision_changed', 'presentation_group_changed']);
/**
 * Passive reads only. Health updates preserve structure and never trigger layout.
 * An expansion (a group card or frontier, #7818) stays on screen: the structural poll
 * re-reads that same server-issued token until `collapse()` or until the server refuses
 * it (graph changed, token expired), when the view falls back to the base read.
 */
export function useTopologyGraph(scope: { siteId: string }, query: { view: TopologyView; focusNodeId?: string }, enabled = true) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const graphRef = useRef(graph); graphRef.current = graph;
  const [refresh, setRefresh] = useState(0);
  const activeScope = useRef('');
  const [expansion, setExpansion] = useState<string | null>(null);
  const expansionRef = useRef(expansion); expansionRef.current = expansion;
  const scopeKey = `${scope.siteId}/${query.view}/${query.focusNodeId ?? ''}`;
  const refreshGraph = useCallback(() => setRefresh((n) => n + 1), []);
  /** Bumped by every expand/collapse, so a late expansion response never re-enters a view the user left. */
  const intent = useRef(0);
  const leave = useCallback(() => { intent.current += 1; expansionRef.current = null; setExpansion(null); setRefresh((n) => n + 1); }, []);
  useEffect(() => {
    // The ref is cleared here too: the structural effect below runs in this same commit,
    // and must not replay the previous scope's expansion token against the new one.
    activeScope.current = scopeKey; setGraph(null); setError(null); expansionRef.current = null; setExpansion(null);
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
      const token = expansionRef.current;
      try {
        const params = new URLSearchParams({ view: query.view, includeHealth: 'true', ...(query.focusNodeId ? { focusNodeId: query.focusNodeId, hops: '1' } : {}) });
        // The first unfocused read may already be in flight, started alongside the settings read (#7880).
        const prefetched = !token && !graphRef.current && !query.focusNodeId ? takePrefetchedGraph(scope.siteId, query.view) : undefined;
        const next = token
          ? await topologyRead(`/topology/sites/${scope.siteId}/expansions/${encodeURIComponent(token)}`, graphResponseSchema, controller.signal)
          : await (prefetched ?? topologyApi.graph(scope.siteId, params, controller.signal));
        if (valid() && token === expansionRef.current) { setGraph(next); setError(null); }
      } catch (cause) {
        // A response for a view the user already left is moot, success or failure.
        if (token !== expansionRef.current) return;
        // A refused expansion (expired/foreign cursor, revision or group changed) is stale,
        // not an error: drop back to the base read. Anything else is a real fault.
        if (token && valid() && cause instanceof TopologyReadError && STALE_EXPANSION.has(cause.code ?? '')) leave();
        else fail(cause);
      }
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
    const key = activeScope.current; const request = ++intent.current;
    const current = () => key === activeScope.current && request === intent.current;
    try {
      const next = await topologyRead(`/topology/sites/${scope.siteId}/expansions/${encodeURIComponent(token)}`, graphResponseSchema);
      if (current()) { expansionRef.current = token; setExpansion(token); setGraph(next); }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Unable to expand topology'); }
  };
  return { graph, loading, error, refreshGraph, expand, expanded: expansion !== null,
    /** Leave the expansion and reload the base (overview or focused) read. */
    collapse: leave };
}
