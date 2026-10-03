import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, RefreshCw, Settings2 } from 'lucide-react';
import type { GraphNode, TopologyView } from '@breeze/shared';
import { useHashState } from '../../lib/useHashState';
import { ActionError, handleActionError } from '../../lib/runAction';
import { TopologyLayoutController } from './layoutController';
import { TopologyLayoutDraft, saveTopologyLayout } from './layoutPersistence';
import { LAYOUT_VERSION, type LayoutBox, type LayoutPosition } from './layoutTypes';
import { useTopologyGraph } from './useTopologyGraph';
import { compileTopologyRender, type RenderNode, type RenderText } from './renderProjection';
import { memberRank, sectionIndex } from './cardSections';
import { parseTopologyHash, writeTopologyHash, type TopologyNavigation } from './topologyHash';
import { isPresentation, selectedTopologyEntity, type TopologySelection } from './topologyPresentation';
import { topologyApi, topologyRead, topologyNodeListSchema, type HiddenConnection, type TopologySettings } from './topologyApi';
import PhysicalCoveragePanel from './PhysicalCoveragePanel';
import { restoreTopologyRelationship } from './RelationshipExclusionAction';
import TopologyCanvas from './TopologyCanvas';
import TopologyList from './TopologyList';
import TopologyInspector from './TopologyInspector';
import TopologyDiagnosticsPanel from './TopologyDiagnosticsPanel';
import TopologyConfiguration from './TopologyConfiguration';
import MonitoringPolicyPanel from './MonitoringPolicyPanel';
import RecentChangesPanel from './RecentChangesPanel';

const sameBoxes = (a: LayoutBox[], b: LayoutBox[]) => a.length === b.length && a.every((box, index) => {
  const other = b[index]!;
  return box.id === other.id && box.role === other.role && box.width === other.width && box.height === other.height && box.groupId === other.groupId
    && box.section === other.section && box.rank === other.rank && box.address === other.address && box.name === other.name;
});
const isCard = (node: RenderNode) => node.kind === 'group' || node.kind === 'unidentified';
/** Tiles drawn inside a card: always packed by the card grid, whatever their saved pin says (revised Q3, #7880). */
const cardMemberIds = (boxes: LayoutBox[]) => {
  const cards = new Set(boxes.filter((box) => box.role === 'group' || box.role === 'unidentified').map((box) => box.id));
  return new Set(boxes.filter((box) => box.groupId && cards.has(box.groupId)).map((box) => box.id));
};

const ICON_BUTTON = 'inline-flex h-9 w-9 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary aria-pressed:bg-muted aria-pressed:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground';
const LAYOUT_BUTTON = 'h-8 rounded-md border bg-background px-2.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

/** `toolbarStart`: a control the entry puts at the start of the toolbar row (the site select), so it does not take a row of its own. */
export default function TopologyExplorer({ siteId, siteName, focusNodeId, settings, toolbarStart }: { siteId: string; siteName?: string; focusNodeId?: string; settings: TopologySettings; toolbarStart?: ReactNode }) {
  const { t } = useTranslation('topology');
  const [navigation, setNavigation] = useHashState<TopologyNavigation>({ siteId, view: 'overview', search: '' }, (hash) => {
    const value = parseTopologyHash(hash); return value && (!value.siteId || value.siteId === siteId) ? value : undefined;
  });
  const [searchFocus, setSearchFocus] = useState<string>(), [searchNodes, setSearchNodes] = useState<GraphNode[]>([]), [searchError, setSearchError] = useState<string>();
  const [showAllNetworks, setShowAllNetworks] = useState(false);
  const [fullSite, setFullSite] = useState(false), [list, setList] = useState(false), [diagnostic, setDiagnostic] = useState<TopologySelection>(), [configuration, setConfiguration] = useState(false);
  const view = navigation.view === 'physical' && !settings.capabilities.physical.available ? 'overview' : navigation.view;
  const { graph, loading, error, refreshGraph, expand, collapse, expanded } = useTopologyGraph({ siteId }, { view, focusNodeId: searchFocus ?? (fullSite ? undefined : focusNodeId) }, settings.capabilities.ui.available);
  const controller = useMemo(() => new TopologyLayoutController(), [siteId, view]);
  const draft = useMemo(() => new TopologyLayoutDraft(), [siteId, view]);
  const [positions, setPositions] = useState<LayoutPosition[]>([]), [boxes, setBoxes] = useState<LayoutBox[]>([]);
  const [warning, setWarning] = useState<string>(), [announcement, setAnnouncement] = useState(''), [saving, setSaving] = useState(false), [conflict, setConflict] = useState(false);
  // The floating layout toolbar covers the map's top edge; Fit map keeps that strip clear.
  const layoutBar = useRef<HTMLDivElement>(null), [fitInsetTop, setFitInsetTop] = useState(0);
  useEffect(() => {
    const bar = layoutBar.current;
    if (!bar) return;
    const update = () => setFitInsetTop(getComputedStyle(bar).position === 'absolute' ? bar.offsetHeight + 8 : 0);
    update();
    const observer = new ResizeObserver(update); observer.observe(bar);
    return () => observer.disconnect();
  });
  const measured = useRef<HTMLDivElement>(null), fitRef = useRef<(() => void) | null>(null), listToggle = useRef<HTMLButtonElement>(null);
  const navigate = useCallback((next: TopologyNavigation) => { const value = { ...next, siteId }; setNavigation(value); writeTopologyHash(value); }, [siteId]);
  const selection = navigation.selection;
  const selected = graph ? selectedTopologyEntity(graph, selection) : undefined;
  // D17: connections hidden from this view, listed (and restorable) from the accessible list.
  const [hidden, setHidden] = useState<HiddenConnection[]>([]), [hiddenError, setHiddenError] = useState<string>(), [hiddenRefresh, setHiddenRefresh] = useState(0);
  const hiddenIds = useMemo(() => new Set(hidden.map((item) => item.relationshipId)), [hidden]);
  const hiddenSelected = selection?.kind === 'edge' && hiddenIds.has(selection.id);
  useEffect(() => {
    if (!list || !graph) return;
    const abort = new AbortController(); setHiddenError(undefined);
    void topologyApi.exclusions(siteId, view, undefined, abort.signal).then((result) => { if (!abort.signal.aborted) setHidden(result.items); })
      .catch(() => { if (!abort.signal.aborted) { setHidden([]); setHiddenError(t('exclusions.hiddenLoadFailed')); } });
    return () => abort.abort();
  }, [list, siteId, view, graph?.revisions.graph, hiddenRefresh]);
  const changed = () => { refreshGraph(); setHiddenRefresh((n) => n + 1); };
  const restore = async (item: HiddenConnection) => {
    try {
      await restoreTopologyRelationship({ siteId, relationshipId: item.relationshipId, exclusionId: item.id, errorFallback: t('exclusions.restoreFailed'), successMessage: t('exclusions.restored') });
      changed();
    } catch (cause) { handleActionError(cause, t('exclusions.restoreFailed')); }
  };
  // A bounded expansion can change the visible projection without changing the
  // site's structural revision. Health-only updates keep this key unchanged.
  const renderText = useMemo<RenderText>(() => ({ devices: (count) => t('grouped.devices', { count }), gatewayFor: (count) => t('grouped.gatewayFor', { count }),
    via: (gateways) => t('grouped.cardVia', { gateways }), gatewaysDiffer: t('grouped.gatewaysDiffer'), agentOffline: t('grouped.presence.agent.offline'),
    sharedEdge: (count) => t('grouped.sharedEdge', { count }), linkVia: (name) => t('grouped.linkVia', { name }) }), [t]);
  const render = useMemo(() => graph ? compileTopologyRender(graph, { showAllNetworks, text: renderText, sharedAddress: (count) => t('grouped.sharedAddress', { count }) }) : undefined, [graph, showAllNetworks, t, renderText]);
  const measurementKey = JSON.stringify(render ? render.nodes.map((node) => [node.id, node.label, node.detail, node.note, node.address, node.kind, node.parent]) : []);
  const nodes = useMemo(() => render?.nodes ?? [], [measurementKey, graph?.view]);
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
    if (graph && selection && !selected && !hiddenSelected) { navigate({ ...navigation, selection: undefined }); setAnnouncement(t('selectionRemoved')); }
  }, [graph?.revisions.graph]);
  useEffect(() => {
    if (!graph) return;
    draft.load(graph.revisions.layout, graph.layout.positions);
    let alive = true, last: LayoutBox[] | undefined;
    const measure = () => {
      if (!alive || !measured.current) return;
      // One pass over the measurement cards, not a scan per node (O(n²) at V1000).
      const elements = new Map([...measured.current.children].map((child) => [child.getAttribute('data-node-id'), child]));
      // Tiles have a fixed width (labels ellipsize); cards are sized by the layout from their members.
      const next: LayoutBox[] = nodes.map((node) => {
        if (isCard(node)) return { id: node.id, role: node.kind, width: 0, height: 0 };
        const rect = elements.get(node.id)?.getBoundingClientRect();
        const width = node.kind === 'gateway' || node.kind === 'internet' ? 236 : 208;
        return { id: node.id, role: node.kind, width, height: Math.min(96, Math.max(60, rect?.height || 60)),
          ...(node.parent ? { groupId: node.parent, section: sectionIndex(node.glyph), rank: memberRank(node), ...(node.address ? { address: node.address } : {}), name: node.label } : {}) };
      });
      // Within one run of this effect, a repeat measurement with unchanged sizes
      // (fonts.ready plus the ResizeObserver's initial callback) is dropped. A new
      // `boxes` identity re-runs `arrange`, which terminates the in-flight worker
      // and starts over. The first measurement of every run still sets a fresh
      // array, so a new layout revision always re-arranges: `arrange` is also
      // what moves freshly loaded draft positions onto the canvas.
      if (last && sameBoxes(last, next)) return;
      last = next; setBoxes(next);
    };
    void (document.fonts?.ready ?? Promise.resolve()).then(measure);
    const observer = new ResizeObserver(measure); if (measured.current) observer.observe(measured.current);
    return () => { alive = false; observer.disconnect(); };
  }, [nodes, graph?.revisions.layout, draft]);
  /** `userAction`: Arrange, Reflow, Use grouped layout or a drag. Only those make the draft an unsaved change (#7880). */
  const arrange = useCallback(async (mode: 'incremental' | 'reflow', userAction: boolean) => {
    if (!graph || !boxes.length) return;
    const result = await controller.run({ requestId: crypto.randomUUID(), graphRevision: graph.revisions.graph, layoutRevision: draft.revision,
      measurementRevision: JSON.stringify(boxes), algorithmVersion: LAYOUT_VERSION, nodes: boxes,
      edges: (render?.edges ?? []).map((edge) => {
        const canonical = graph.relationships.find((relationship) => relationship.id === edge.id);
        return { id: edge.id, source: edge.layoutSource, target: edge.layoutTarget,
          ...(canonical?.sourceInterfaceId && edge.layoutSource === canonical.sourceNodeId ? { sourcePort: canonical.sourceInterfaceId } : {}),
          ...(canonical?.targetInterfaceId && edge.layoutTarget === canonical.targetNodeId ? { targetPort: canonical.targetInterfaceId } : {}) };
      }),
      positions: [...draft.positions.values()], mode });
    if (!result) return;
    draft.applyLayout(result.positions, { cardMembers: cardMemberIds(boxes), userAction });
    setPositions(result.positions); setWarning(result.warning); setAnnouncement(t('arranged'));
  }, [graph?.revisions.graph, boxes, controller, draft, t, render]);
  /** Discards saved and pinned coordinates in this draft and lays the map out fresh; nothing persists until Save. */
  const useGroupedLayout = () => {
    for (const [nodeId, point] of draft.positions) draft.positions.set(nodeId, { ...point, pinned: false });
    void arrange('reflow', true);
  };
  const hasPins = [...draft.positions.values()].some((point) => point.pinned);
  // Automatic: placing the map on load or after a resize is not a change the user made (#7880).
  useEffect(() => { if (boxes.length) void arrange('incremental', false); }, [boxes, controller]);
  const changePositions = (moved: LayoutPosition[]) => {
    if (!graph?.permissions.canEdit || !moved.length) return;
    for (const position of moved) draft.positions.set(position.nodeId, position);
    draft.dirty = true;
    // A card member is never drawn at its pin: the pin re-anchors its card, and the card re-packs (revised Q3).
    const members = cardMemberIds(boxes);
    if (moved.some((position) => members.has(position.nodeId))) { void arrange('incremental', true); return; }
    setPositions((current) => { const next = new Map(current.map((point) => [point.nodeId, point])); for (const position of moved) next.set(position.nodeId, position); return [...next.values()]; });
  };
  const save = async () => {
    if (!graph?.permissions.canEdit || conflict) return;
    setSaving(true);
    try {
      const ids = new Set(graph.nodes.map((node) => node.id));
      const result = await saveTopologyLayout({ siteId }, view, draft.revision, [...draft.positions.values()].filter((p) => ids.has(p.nodeId)).map(({ nodeId, x, y, pinned }) => ({ nodeId, x, y, pinned })));
      // The canvas keeps what it draws: the draft holds saved pins, which are not where card members are drawn (revised Q3).
      draft.accept(result); setAnnouncement(t('saved'));
    } catch (cause) { if (cause instanceof ActionError && cause.status === 409) setConflict(true); handleActionError(cause, t('loadFailed'));  }
    finally { setSaving(false); }
  };
  const select = (next: TopologySelection) => { if (navigation.search) setSearchFocus(next.id); navigate({ ...navigation, selection: next, search: '', interfaceId: undefined }); setAnnouncement(t('selected')); };
  const closeInspector = () => { navigate({ ...navigation, selection: undefined, interfaceId: undefined }); listToggle.current?.focus(); };
  // The site settings read carries execute/configure + MFA authority; the graph projection reports neither.
  const canDiagnose = settings.permissions?.canDiagnose ?? !!graph?.permissions.canDiagnose;
  const canConfigureMonitoring = settings.permissions?.canConfigureMonitoring ?? !!graph?.permissions.canConfigureMonitoring;
  // M4 Task 5: "Explain this" is offered only when the server reports AI available for the site (M4-D4).
  const explain = settings.capabilities.ai?.available ? {
    canApprove: canDiagnose && settings.capabilities.diagnostics.available,
    investigationId: navigation.investigationId, runId: navigation.aiRunId,
    onInvestigation: (investigationId: string | undefined) => { const current = parseTopologyHash(window.location.hash) ?? navigation; navigate({ ...current, investigationId, ...(investigationId ? {} : { aiRunId: undefined }) }); },
    onRun: (aiRunId: string | undefined) => { const current = parseTopologyHash(window.location.hash) ?? navigation; navigate({ ...current, aiRunId }); },
    onEvidenceSelect: (target: { kind: 'node' | 'relationship'; id: string }) => select({ kind: target.kind === 'relationship' ? 'edge' : 'node', id: target.id }),
  } : undefined;
  const aiNotConfigured = settings.capabilities.ai?.reason === 'ai_not_configured';
  const operations = { interfaceHealth: !!settings.capabilities.interfaceHealth?.available, monitoring: !!settings.capabilities.recurringMonitoring?.available, canConfigure: canConfigureMonitoring };
  // `data-layout-applied`: a layout result reached the canvas. Browser gates wait on it; the unsaved
  // indicator is no signal since an automatic arrangement is not an unsaved change (#7880).
  return <section data-testid="topology-explorer" data-layout-applied={positions.length ? 'true' : undefined} className="min-w-0 space-y-3">
    {/* One toolbar row (2026-10-03): site, search, view, list; refresh/configuration/operations as a compact icon group. */}
    <div data-testid="topology-toolbar" className="flex flex-wrap items-center gap-2">
      {toolbarStart}
      <label className="min-w-48 flex-1"><span className="sr-only">{t('search')}</span>
        <input data-testid="topology-search" type="search" placeholder={t('search')} className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={navigation.search} maxLength={200} onChange={(event) => navigate({ ...navigation, search: event.target.value })} /></label>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">{t('view')}<select data-testid="topology-view" className="h-9 rounded-md border bg-background px-2 text-sm text-foreground" value={view} onChange={(event) => navigate({ ...navigation, view: event.target.value as TopologyView, selection: undefined })}><option value="overview">{t('overview')}</option><option value="logical">{t('logical')}</option><option value="physical" disabled={!settings.capabilities.physical.available}>{t('physical')}</option></select></label>
      <button ref={listToggle} data-testid="topology-list-toggle" className="h-9 rounded-md border px-3 text-sm" aria-pressed={list} onClick={() => setList(!list)}>{list ? t('showMap') : t('showList')}</button>
      <div role="group" aria-label={t('moreActions')} className="flex items-center rounded-md border">
        <button data-testid="topology-refresh" className={ICON_BUTTON} aria-label={t('refresh')} title={t('refresh')} onClick={refreshGraph}><RefreshCw className="h-4 w-4" aria-hidden="true" /></button>
        <button data-testid="topology-configure" className={`${ICON_BUTTON} border-l`} aria-label={t('configuration')} title={t('configuration')} aria-expanded={configuration} onClick={() => setConfiguration(!configuration)}><Settings2 className="h-4 w-4" aria-hidden="true" /></button>
        <button data-testid="topology-operations-toggle" className={`${ICON_BUTTON} border-l`} aria-label={t('operations.toggle')} title={t('operations.toggle')} aria-pressed={!!navigation.operations} onClick={() => navigate({ ...navigation, operations: !navigation.operations })}><Activity className="h-4 w-4" aria-hidden="true" /></button>
      </div>
    </div>
    {(focusNodeId || searchFocus) && !fullSite && <button className="text-sm text-primary underline" onClick={() => { setFullSite(true); setSearchFocus(undefined); }}>{t('fullSite')}</button>}
    {configuration && <TopologyConfiguration siteId={siteId} />}
    {navigation.operations && <section data-testid="topology-operations" aria-label={t('operations.heading')} className="space-y-2 rounded border bg-card p-4">
      {operations.monitoring && <MonitoringPolicyPanel siteId={siteId} canConfigure={canConfigureMonitoring} />}
      <RecentChangesPanel siteId={siteId} />
    </section>}
    {loading && <p role="status">{t('loading')}</p>}
    {searchError && <p role="alert">{searchError}</p>}
    {error && <p role="alert" className="text-destructive">{error} <button className="underline" onClick={refreshGraph}>{t('retry')}</button></p>}
    {graph && <>
      {/* One status row: the site and its networks, collection coverage (reasons behind a disclosure), health, counts. */}
      <div data-testid="topology-status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {render?.grouped && view === 'overview' && <SiteHeader render={render} siteName={siteName} />}
        <PhysicalCoveragePanel coverage={graph.coverage} />
        <span data-testid="topology-health-internet">{graph.nodes.some((node) => node.kind === 'internet' && node.health.status !== 'unknown') ? graph.nodes.filter((node) => node.kind === 'internet').map((node) => `${node.label}: ${t(/* i18n-dynamic */ `healthStatus.${node.health.status}`)}`).join(' · ') : t('notMeasured')}</span>
        <span data-testid="topology-counts">{t('counts', { nodes: t('nodeCount', { count: graph.counts.visibleNodes }), edges: t('connectionCount', { count: graph.counts.visibleRelationships }) })}</span>
        {graph.counts.omittedNodes + graph.counts.omittedRelationships > 0 && <span>{t('omitted', { nodes: t('nodeCount', { count: graph.counts.omittedNodes }), edges: t('connectionCount', { count: graph.counts.omittedRelationships }) })}</span>}
      </div>
      {conflict && <div data-testid="topology-layout-conflict" role="alert" className="rounded border p-3"><p>{t('layoutConflict')}</p><button className="mt-2 underline" onClick={() => { draft.dirty = false; setConflict(false); refreshGraph(); }}>{t('reloadLayout')}</button></div>}
      {warning && <p data-testid="topology-layout-warning" role="status">{t(/* i18n-dynamic */ warning)}</p>}
      {!nodes.length ? (view === 'physical'
        ? <div data-testid="topology-physical-empty" className="py-12 text-center text-muted-foreground"><p>{t('physicalView.empty')}</p>
          <button data-testid="topology-view-overview" className="mt-3 rounded border px-3 py-2" onClick={() => navigate({ ...navigation, view: 'overview', selection: undefined })}>{t('physicalView.viewOverview')}</button></div>
        : <p className="py-12 text-center text-muted-foreground">{t('empty')}</p>) : <div className="flex flex-col overflow-hidden rounded-lg border lg:flex-row">
        <div className="relative min-w-0 flex-1">
        {/* Layout actions float over the map's top-left on wide screens (a row above it on narrow ones), so the map starts higher. */}
        <div ref={layoutBar} data-testid="topology-layout-actions" role="toolbar" aria-label={t('layoutActions')}
          className={`flex flex-wrap items-center gap-1.5 border-b bg-card/95 p-2 ${list || navigation.search ? '' : 'lg:absolute lg:left-2 lg:top-2 lg:z-10 lg:max-w-[calc(100%-12rem)] lg:rounded-lg lg:border lg:shadow-sm'}`}>
        {expanded && <button data-testid="topology-collapse" className={LAYOUT_BUTTON} onClick={collapse}>{t('collapse')}</button>}
        <button data-testid="topology-fit" className={LAYOUT_BUTTON} onClick={() => fitRef.current?.()}>{t('fit')}</button>
        <button data-testid="topology-arrange" className={LAYOUT_BUTTON} onClick={() => void arrange('incremental', true)}>{t('arrange')}</button>
        <button data-testid="topology-reflow" className={LAYOUT_BUTTON} onClick={() => void arrange('reflow', true)}>{t('reflow')}</button>
        {graph.permissions.canEdit && <button data-testid="topology-layout-save" className="h-8 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={!draft.dirty || saving || conflict} onClick={() => void save()}>{saving ? t('saving') : t('saveLayout')}</button>}
        {render?.grouped && (hasPins || warning === 'pinned_overlap') && <button data-testid="topology-grouped-layout" className={LAYOUT_BUTTON} onClick={useGroupedLayout}>{t('grouped.useLayout')}</button>}
        {render && (render.hiddenNetworkCount > 0 || showAllNetworks) && <label className="flex items-center gap-1.5 px-1 text-xs"><input data-testid="topology-show-all-networks" type="checkbox" checked={showAllNetworks} onChange={(event) => setShowAllNetworks(event.target.checked)} />{t('grouped.showAllNetworks', { count: render.hiddenNetworkCount })}</label>}
        {render && render.hiddenDeviceCount > 0 && <span data-testid="topology-hidden-devices" className="px-1 text-xs text-muted-foreground">{t('grouped.hiddenDevices', { count: render.hiddenDeviceCount })}</span>}
        {draft.dirty && <span data-testid="topology-unsaved-layout" className="px-1 text-xs text-muted-foreground">{graph.permissions.canEdit ? t('unsaved') : t('localLayout')}</span>}
        </div>
        {list || navigation.search ? <TopologyList graph={navigation.search ? { ...graph, nodes: searchNodes, relationships: [], presentation: { nodes: [], edges: [] } } : graph} onSelect={select}
          hidden={navigation.search ? undefined : { items: hidden, canEdit: graph.permissions.canEdit, onRestore: (item) => void restore(item), ...(hiddenError ? { error: hiddenError } : {}) }} /> : <TopologyCanvas render={render!} positions={positions} boxes={boxes} selection={selection} editable={graph.permissions.canEdit} onSelect={select} onMove={changePositions} fitRef={fitRef} fitInsetTop={fitInsetTop} fitKey={`${view}:${showAllNetworks}:${render?.grouped}`} />}</div>
        {selection && (selected || hiddenSelected) && <TopologyInspector graph={graph} selection={selection} siteId={siteId} view={view} onChanged={changed} canDiagnose={!!selected && !isPresentation(selected) && canDiagnose && settings.capabilities.diagnostics.available} onDiagnose={() => setDiagnostic(selection)} onClose={closeInspector} onExpand={(token) => void expand(token)} operations={operations}
          historyInterfaceId={navigation.interfaceId} onHistory={(interfaceId) => navigate({ ...navigation, interfaceId })} onSelectNode={(id) => select({ kind: 'node', id })} explain={explain} aiNotConfigured={aiNotConfigured} sharedAddressCount={render?.nodes.find((node) => node.id === selection.id)?.sharedWith} pinned={draft.positions.get(selection.id)?.pinned} onPin={graph.permissions.canEdit ? () => { const point = draft.positions.get(selection.id); if (point) changePositions([{ ...point, pinned: !point.pinned }]); } : undefined} />}
      </div>}
      <p className="text-xs text-muted-foreground">{t('legend')}</p>
      {graph.frontier.map((frontier) => <button key={frontier.token} data-testid="topology-frontier" className="mr-2 rounded border px-3 py-2 text-sm" onClick={() => void expand(frontier.token)}>{frontier.label} ({frontier.memberCount})</button>)}
      {diagnostic && <TopologyDiagnosticsPanel siteId={siteId} graphRevision={graph.revisions.graph} subject={{ kind: diagnostic.kind === 'edge' ? 'relationship' : 'node', id: diagnostic.id }} onClose={() => setDiagnostic(undefined)} />}
    </>}
    <div aria-live="polite" className="sr-only">{announcement}</div>
    <div ref={measured} aria-hidden="true" className="pointer-events-none fixed -left-[10000px] top-0 w-52 opacity-0">{nodes.filter((node) => !isCard(node)).map((node) => <div data-node-id={node.id} key={node.id} className="w-52 rounded border py-3 pl-[54px] pr-[14px] text-xs leading-[1.35]"><div className="truncate">{node.label}</div>{node.detail && <div className="truncate">{node.detail}</div>}</div>)}</div>
  </section>;
}

/**
 * The site at a glance above the overview (2026-10-03): the cards below are networks within one
 * site. Names the site, counts networks and devices, and says plainly when a secondary network has
 * no observed link to the primary one, rather than drawing a connection nobody saw (spec C:14).
 */
function SiteHeader({ render, siteName }: { render: NonNullable<ReturnType<typeof compileTopologyRender>>; siteName?: string }) {
  const { t } = useTranslation('topology');
  const label = (id: string | null) => render.nodes.find((node) => node.id === id)?.label ?? '';
  const primary = label(render.site.primary);
  return <div data-testid="topology-site-header" className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
    {siteName && <h3 className="text-base font-semibold tracking-[-0.01em]">{siteName}</h3>}
    <span className="text-sm text-muted-foreground">{[t('grouped.siteNetworks', { count: render.site.networks }), t('grouped.devices', { count: render.site.devices })].join(' · ')}</span>
    {render.site.unlinked.map((id) => <span key={id} data-testid="topology-unlinked-note" className="text-sm text-muted-foreground">
      · {t('grouped.noObservedLink', { network: label(id), primary })}</span>)}
  </div>;
}
