import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphNode, TopologyView } from '@breeze/shared';
import { useHashState } from '../../lib/useHashState';
import { ActionError, handleActionError } from '../../lib/runAction';
import { TopologyLayoutController } from './layoutController';
import { TopologyLayoutDraft, saveTopologyLayout } from './layoutPersistence';
import { LAYOUT_VERSION, type LayoutBox, type LayoutPosition } from './layoutTypes';
import { useTopologyGraph } from './useTopologyGraph';
import { parseTopologyHash, writeTopologyHash, type TopologyNavigation } from './topologyHash';
import { isPresentation, selectedTopologyEntity, type TopologySelection } from './topologyPresentation';
import { topologyRead, topologyNodeListSchema, type TopologySettings } from './topologyApi';
import TopologyCanvas from './TopologyCanvas';
import TopologyList from './TopologyList';
import TopologyInspector from './TopologyInspector';
import TopologyDiagnosticsPanel from './TopologyDiagnosticsPanel';
import TopologyConfiguration from './TopologyConfiguration';

export default function TopologyExplorer({ siteId, focusNodeId, settings }: { siteId: string; focusNodeId?: string; settings: TopologySettings }) {
  const { t } = useTranslation('topology');
  const [navigation, setNavigation] = useHashState<TopologyNavigation>({ siteId, view: 'overview', search: '' }, (hash) => {
    const value = parseTopologyHash(hash); return value && (!value.siteId || value.siteId === siteId) ? value : undefined;
  });
  const [searchFocus, setSearchFocus] = useState<string>(), [searchNodes, setSearchNodes] = useState<GraphNode[]>([]), [searchError, setSearchError] = useState<string>();
  const [fullSite, setFullSite] = useState(false), [list, setList] = useState(false), [diagnostic, setDiagnostic] = useState<TopologySelection>(), [configuration, setConfiguration] = useState(false);
  const view = navigation.view === 'physical' && !settings.capabilities.physical.available ? 'overview' : navigation.view;
  const { graph, loading, error, refreshGraph, expand } = useTopologyGraph({ siteId }, { view, focusNodeId: searchFocus ?? (fullSite ? undefined : focusNodeId) }, settings.capabilities.ui.available);
  const controller = useMemo(() => new TopologyLayoutController(), [siteId, view]);
  const draft = useMemo(() => new TopologyLayoutDraft(), [siteId, view]);
  const [positions, setPositions] = useState<LayoutPosition[]>([]), [boxes, setBoxes] = useState<LayoutBox[]>([]);
  const [warning, setWarning] = useState<string>(), [announcement, setAnnouncement] = useState(''), [saving, setSaving] = useState(false), [conflict, setConflict] = useState(false);
  const measured = useRef<HTMLDivElement>(null), fitRef = useRef<(() => void) | null>(null), listToggle = useRef<HTMLButtonElement>(null);
  const navigate = useCallback((next: TopologyNavigation) => { const value = { ...next, siteId }; setNavigation(value); writeTopologyHash(value); }, [siteId]);
  const selection = navigation.selection;
  const selected = graph ? selectedTopologyEntity(graph, selection) : undefined;
  // A bounded expansion can change the visible projection without changing the
  // site's structural revision. Health-only updates keep this key unchanged.
  const measurementKey = JSON.stringify(graph ? [...graph.nodes, ...graph.presentation.nodes].map(node => [node.id, node.label, 'kind' in node ? node.kind : node.role]) : []);
  const nodes = useMemo(() => graph ? [...graph.nodes, ...graph.presentation.nodes] : [], [measurementKey, graph?.view]);
  useEffect(() => {
    if (!navigation.search.trim()) { setSearchNodes([]); return; }
    const abort = new AbortController(); setSearchError(undefined);
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ q: navigation.search, limit: '200' });
      void topologyRead(`/topology/sites/${siteId}/nodes?${query}`, topologyNodeListSchema, abort.signal).then((result) => {
        if (!abort.signal.aborted) setSearchNodes(result.nodes);
      }).catch((cause) => { if (!abort.signal.aborted) { setSearchNodes([]); setSearchError(cause instanceof Error ? cause.message : t('loadFailed')); } });
    }, 200);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [navigation.search, siteId]);
  useEffect(() => () => controller.cancel(), [controller]);
  useEffect(() => {
    setPositions([]); setBoxes([]); setConflict(false); setWarning(undefined); setDiagnostic(undefined);
  }, [siteId, view]);
  useEffect(() => {
    if (graph && selection && !selected) { navigate({ ...navigation, selection: undefined }); setAnnouncement(t('selectionRemoved')); }
  }, [graph?.revisions.graph]);
  useEffect(() => {
    if (!graph) return;
    draft.load(graph.revisions.layout, graph.layout.positions);
    let alive = true;
    const measure = () => {
      if (!alive || !measured.current) return;
      setBoxes(nodes.map((node) => {
        const element = [...measured.current!.children].find((child) => child.getAttribute('data-node-id') === node.id);
        const rect = element?.getBoundingClientRect();
        return { id: node.id, role: 'kind' in node ? node.kind : node.role, width: Math.min(360, Math.max(220, rect?.width || 220)), height: Math.min(240, Math.max(88, rect?.height || 88)) };
      }));
    };
    void (document.fonts?.ready ?? Promise.resolve()).then(measure);
    const observer = new ResizeObserver(measure); if (measured.current) observer.observe(measured.current);
    return () => { alive = false; observer.disconnect(); };
  }, [nodes, graph?.revisions.layout, draft]);
  const arrange = useCallback(async (mode: 'incremental' | 'reflow') => {
    if (!graph || !boxes.length) return;
    const result = await controller.run({ requestId: crypto.randomUUID(), graphRevision: graph.revisions.graph, layoutRevision: draft.revision,
      measurementRevision: JSON.stringify(boxes), algorithmVersion: LAYOUT_VERSION, nodes: boxes,
      edges: [...graph.relationships, ...graph.presentation.edges].map((edge) => ({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId })),
      positions: [...draft.positions.values()], mode });
    if (!result) return;
    draft.preview(result.positions); setPositions(result.positions); setWarning(result.warning); setAnnouncement(t('arranged'));
  }, [graph?.revisions.graph, boxes, controller, draft, t]);
  useEffect(() => { if (boxes.length) void arrange('incremental'); }, [boxes, controller]);
  const changePosition = (position: LayoutPosition) => {
    if (!graph?.permissions.canEdit) return;
    draft.positions.set(position.nodeId, position); draft.preview([...draft.positions.values()]); setPositions([...draft.positions.values()]);
  };
  const save = async () => {
    if (!graph?.permissions.canEdit || conflict) return;
    setSaving(true);
    try {
      const ids = new Set(graph.nodes.map((node) => node.id));
      const result = await saveTopologyLayout({ siteId }, view, draft.revision, [...draft.positions.values()].filter((p) => ids.has(p.nodeId)).map(({ nodeId, x, y, pinned }) => ({ nodeId, x, y, pinned })));
      draft.accept(result); setPositions([...draft.positions.values()]); setAnnouncement(t('saved'));
    } catch (cause) { if (cause instanceof ActionError && cause.status === 409) setConflict(true); handleActionError(cause, t('loadFailed'));  }
    finally { setSaving(false); }
  };
  const select = (next: TopologySelection) => { if (navigation.search) setSearchFocus(next.id); navigate({ ...navigation, selection: next, search: '' }); setAnnouncement(t('selected')); };
  const closeInspector = () => { navigate({ ...navigation, selection: undefined }); listToggle.current?.focus(); };
  return <section data-testid="topology-explorer" className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-40 flex-1 text-sm">{t('search')}<input data-testid="topology-search" className="mt-1 w-full rounded border bg-background px-3 py-2" value={navigation.search} maxLength={200} onChange={(event) => navigate({ ...navigation, search: event.target.value })} /></label>
      <label className="text-sm">{t('view')}<select data-testid="topology-view" className="ml-2 rounded border bg-background p-2" value={view} onChange={(event) => navigate({ ...navigation, view: event.target.value as TopologyView, selection: undefined })}><option value="overview">{t('overview')}</option><option value="logical">{t('logical')}</option><option value="physical" disabled={!settings.capabilities.physical.available}>{t('physical')}</option></select></label>
      <button ref={listToggle} data-testid="topology-list-toggle" className="rounded border px-3 py-2" aria-pressed={list} onClick={() => setList(!list)}>{list ? t('showMap') : t('showList')}</button>
      <button data-testid="topology-refresh" className="rounded border px-3 py-2" onClick={refreshGraph}>{t('refresh')}</button>
      <button data-testid="topology-configure" className="rounded border px-3 py-2" onClick={() => setConfiguration(!configuration)}>{t('configuration')}</button>
    </div>
    {(focusNodeId || searchFocus) && !fullSite && <button className="text-sm text-primary underline" onClick={() => { setFullSite(true); setSearchFocus(undefined); }}>{t('fullSite')}</button>}
    {configuration && <TopologyConfiguration siteId={siteId} />}
    {loading && <p role="status">{t('loading')}</p>}
    {searchError && <p role="alert">{searchError}</p>}
    {error && <p role="alert" className="text-destructive">{error} <button className="underline" onClick={refreshGraph}>{t('retry')}</button></p>}
    {graph && <>
      <div className="flex flex-wrap items-center gap-3 text-sm"><span>{t('coverage', { state: graph.coverage.state })}</span><span>{t('counts', { nodes: graph.counts.visibleNodes, edges: graph.counts.visibleRelationships })}</span><span>{t('omitted', { nodes: graph.counts.omittedNodes, edges: graph.counts.omittedRelationships })}</span></div>
      {graph.coverage.reasons.map((reason) => <p className="text-sm text-muted-foreground" key={reason.code}>{reason.message}</p>)}
      <p data-testid="topology-health-internet" className="text-sm">{graph.nodes.some((node) => node.kind === 'internet' && node.health.status !== 'unknown') ? graph.nodes.filter((node) => node.kind === 'internet').map((node) => `${node.label}: ${t(/* i18n-dynamic */ `healthStatus.${node.health.status}`)}`).join(' · ') : t('notMeasured')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button data-testid="topology-fit" className="rounded border px-3 py-2 text-sm" onClick={() => fitRef.current?.()}>{t('fit')}</button>
        <button data-testid="topology-arrange" className="rounded border px-3 py-2 text-sm" onClick={() => void arrange('incremental')}>{t('arrange')}</button>
        <button data-testid="topology-reflow" className="rounded border px-3 py-2 text-sm" onClick={() => void arrange('reflow')}>{t('reflow')}</button>
        {graph.permissions.canEdit && <button data-testid="topology-layout-save" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={!draft.dirty || saving || conflict} onClick={() => void save()}>{saving ? t('saving') : t('saveLayout')}</button>}
        {draft.dirty && <span data-testid="topology-unsaved-layout" className="text-sm text-muted-foreground">{graph.permissions.canEdit ? t('unsaved') : t('localLayout')}</span>}
      </div>
      {conflict && <div data-testid="topology-layout-conflict" role="alert" className="rounded border p-3"><p>{t('layoutConflict')}</p><button className="mt-2 underline" onClick={() => { draft.dirty = false; setConflict(false); refreshGraph(); }}>{t('reloadLayout')}</button></div>}
      {warning && <p role="status">{t(/* i18n-dynamic */ warning)}</p>}
      {!nodes.length ? <p className="py-12 text-center text-muted-foreground">{t('empty')}</p> : <div className="flex flex-col overflow-hidden rounded-lg border lg:flex-row">
        <div className="min-w-0 flex-1">{list || navigation.search ? <TopologyList graph={navigation.search ? { ...graph, nodes: searchNodes, relationships: [], presentation: { nodes: [], edges: [] } } : graph} onSelect={select} /> : <TopologyCanvas graph={graph} positions={positions} boxes={boxes} selection={selection} editable={graph.permissions.canEdit} onSelect={select} onMove={changePosition} fitRef={fitRef} />}</div>
        {selection && selected && <TopologyInspector graph={graph} selection={selection} canDiagnose={!isPresentation(selected) && graph.permissions.canDiagnose && settings.capabilities.diagnostics.available} onDiagnose={() => setDiagnostic(selection)} onClose={closeInspector} onExpand={(token) => void expand(token)} pinned={draft.positions.get(selection.id)?.pinned} onPin={graph.permissions.canEdit ? () => { const point = draft.positions.get(selection.id); if (point) changePosition({ ...point, pinned: !point.pinned }); } : undefined} />}
      </div>}
      <p className="text-xs text-muted-foreground">{t('legend')}</p>
      {graph.frontier.map((frontier) => <button key={frontier.token} data-testid="topology-frontier" className="mr-2 rounded border px-3 py-2 text-sm" onClick={() => void expand(frontier.token)}>{frontier.label} ({frontier.memberCount})</button>)}
      {diagnostic && <TopologyDiagnosticsPanel siteId={siteId} graphRevision={graph.revisions.graph} subject={{ kind: diagnostic.kind === 'edge' ? 'relationship' : 'node', id: diagnostic.id }} onClose={() => setDiagnostic(undefined)} />}
    </>}
    <div aria-live="polite" className="sr-only">{announcement}</div>
    <div ref={measured} aria-hidden="true" className="pointer-events-none fixed -left-[10000px] top-0 w-64 opacity-0">{nodes.map((node) => <div data-node-id={node.id} key={node.id} className="w-64 break-words rounded border px-4 py-5 text-sm">{node.label}</div>)}</div>
  </section>;
}
