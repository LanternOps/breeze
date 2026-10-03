import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import cytoscape, { type Core } from 'cytoscape';
import type { LayoutBox, LayoutPosition } from './layoutTypes';
import type { TopologySelection } from './topologyPresentation';
import type { RenderNode, TopologyRender } from './renderProjection';
import { glyphTileUri } from './topologyGlyphs';
import { cardSummaries, sectionHeaders } from './cardSections';
import { routeEdgesToCards } from './edgeRouting';
import { fitFocus, nextZoomTier, summaryDensity, type Bounds, type ZoomTier } from './semanticZoom';
import CardSummaryOverlay, { type SummaryCard } from './CardSummaryOverlay';

/** Reads a design-system HSL token (`--primary: 225 62% 48%`) as a colour Cytoscape understands. */
function token(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = value.split(/\s+/);
  return parts.length === 3 ? `hsl(${parts.join(', ')})` : fallback;
}
function palette() {
  return { card: token('--card', '#ffffff'), border: token('--border', '#e2e8f0'), foreground: token('--foreground', '#0f172a'),
    muted: token('--muted-foreground', '#64748b'), mutedBg: token('--muted', '#f1f5f9'), primary: token('--primary', '#3b56c4'),
    success: token('--success', '#16a34a'), warning: token('--warning-strong', '#b45309'), destructive: token('--destructive', '#dc2626') };
}
/** The app's own typeface, so canvas labels match the HTML around them (and the measurement tiles). */
const fontFamily = () => getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
let measureContext: CanvasRenderingContext2D | null | undefined;
/**
 * Cytoscape's own ellipsis cannot coexist with manual line breaks, so title and detail lines are
 * clipped here, by rendered width in the canvas font, to one line each; the shared-IP note may wrap
 * (the measurement tile in TopologyExplorer wraps it at the same width).
 */
function clipToWidth(text: string, width: number, font: string): string {
  if (measureContext === undefined) {
    try { measureContext = document.createElement('canvas').getContext('2d'); } catch { measureContext = null; }
  }
  const context = measureContext;
  if (!context) return clip(text, Math.floor(width / 6.5));
  context.font = font;
  if (context.measureText(text).width <= width) return text;
  let low = 0, high = text.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (context.measureText(`${text.slice(0, mid)}…`).width <= width) low = mid; else high = mid - 1; }
  return `${text.slice(0, low).trimEnd()}…`;
}
/** Tile text starts after the glyph (12px inset + 30px glyph + 12px gap), left-aligned in every tile. */
const TEXT_INSET = 54;
/** Right padding of tile text; with TEXT_INSET it matches the measurement tile (pl-[54px] pr-[14px]). */
const TEXT_END = 14;
function display(node: RenderNode, width: number, family: string) {
  if (node.kind === 'group' || node.kind === 'unidentified') return [node.label, node.detail].filter(Boolean).join('   ·   ');
  const text = width - TEXT_INSET - TEXT_END, strong = node.kind === 'gateway' || node.kind === 'internet';
  return [clipToWidth(node.label, text, `${strong ? 600 : 500} ${strong ? 13 : 12}px ${family}`), node.detail ? clipToWidth(node.detail, text, `500 12px ${family}`) : null,
    node.note].filter(Boolean).join('\n');
}
/** Fit never zooms past this: a three-tile site should not fill the screen with 2.5× tiles. */
const FIT_MAX_ZOOM = 1.25;
/** Zoom a summary click lands on: tiles are legible, and the card's first sections are in view. */
const CARD_ZOOM = 0.85;
const FIT_PADDING = 40;

/** A numeric style mapped from element data; Cytoscape accepts `data(…)` here, its typings only a number. */
const dataNumber = (field: string) => `data(${field})` as unknown as number;

function stylesheet(c: ReturnType<typeof palette>): cytoscape.StylesheetJson {
  return [
    { selector: 'node, edge', style: { 'font-family': fontFamily() } },
    // `text-halign: right` + a negative margin anchors the label's left edge inside the tile, so text
    // left-aligns after the glyph instead of centring a ragged block (data(textShift) = TEXT_INSET − width).
    { selector: 'node', style: { shape: 'round-rectangle', width: 'data(width)', height: 'data(height)', 'background-color': c.card, 'border-width': 1, 'border-color': c.border,
      label: 'data(display)', color: c.foreground, 'font-size': 12, 'font-weight': 500, 'text-wrap': 'wrap', 'text-max-width': 'data(textWidth)', 'text-valign': 'center',
      'text-halign': 'right', 'text-justification': 'left', 'text-margin-x': dataNumber('textShift'), 'line-height': 1.35, 'min-zoomed-font-size': 6,
      'background-image': 'data(icon)', 'background-width': 30, 'background-height': 30, 'background-position-x': 12, 'background-position-y': '50%', 'background-clip': 'none',
      'background-image-containment': 'over' } },
    { selector: 'node[kind="gateway"], node[kind="internet"]', style: { 'border-width': 1.5, 'border-color': c.primary, 'font-weight': 600, 'font-size': 13, 'background-width': 34, 'background-height': 34 } },
    { selector: 'node[kind="outside"]', style: { shape: 'round-diamond', 'border-style': 'dotted', 'background-image': 'none', 'text-halign': 'center', 'text-margin-x': 0, color: c.muted } },
    { selector: 'node[kind="network"]', style: { 'border-style': 'dashed' } },
    // Section headers inside a card: a hairline rule across the card with its label sitting on it.
    // Drawing only: never selectable, draggable or a tap target.
    { selector: 'node[kind="section"]', style: { shape: 'rectangle', 'background-color': c.border, 'background-opacity': 1, 'border-width': 0, 'background-image': 'none',
      'font-size': 11.5, 'font-weight': 600, color: c.muted, 'text-valign': 'top', 'text-margin-y': -4, 'text-wrap': 'none', events: 'no' } },
    { selector: 'node[presence="offline"]', style: { opacity: 0.6 } },
    { selector: 'node[?stale]', style: { 'border-style': 'dashed' } },
    { selector: 'node[?unverified]', style: { 'border-style': 'dashed', 'background-color': c.mutedBg } },
    // Neighbour-cache placement (#7816): distinct from an address match, still neutral — never a health colour.
    { selector: 'node[?corroborated]', style: { 'border-style': 'dotted', 'border-width': 1.5 } },
    // Red/amber/green describe measured health only (design §153); unknown stays neutral.
    { selector: 'node[health="healthy"]', style: { 'border-color': c.success, 'border-width': 2 } },
    { selector: 'node[health="degraded"]', style: { 'border-color': c.warning, 'border-width': 2 } },
    { selector: 'node[health="failed_check"]', style: { 'border-color': c.destructive, 'border-width': 2.5 } },
    // Card title: left-aligned above the card's top-left corner, like a panel heading.
    { selector: ':parent', style: { shape: 'round-rectangle', 'background-color': c.primary, 'background-opacity': 0.035, 'border-color': c.primary, 'border-opacity': 0.35,
      'border-width': 1.5, padding: '24px', 'background-image': 'none', 'text-valign': 'top', 'text-halign': 'right', 'text-margin-x': dataNumber('titleShift'), 'text-margin-y': -8,
      'font-size': 17, 'font-weight': 600, 'text-max-width': '4000px', 'text-wrap': 'none', 'min-zoomed-font-size': 4, color: c.foreground } },
    { selector: ':parent[kind="unidentified"], :parent[networkClass!="lan"][kind="group"]', style: { 'border-style': 'dashed', 'background-color': c.mutedBg, 'background-opacity': 0.5, 'border-color': c.muted, 'border-opacity': 0.6 } },
    { selector: 'edge', style: { width: 1.5, 'line-color': c.muted, 'line-opacity': 0.75, 'curve-style': 'bezier', 'line-style': 'dashed', 'line-dash-pattern': [6, 4] } },
    { selector: 'edge[style="physical"]', style: { 'line-style': 'solid', width: 2 } },
    { selector: 'edge[style="inferred"], edge[style="shared"]', style: { 'line-style': 'dotted' } },
    // An edge that ends on a card leaves it square to the border instead of cutting across the canvas.
    { selector: 'edge[?toCard]', style: { 'curve-style': 'taxi', 'taxi-direction': 'auto', 'taxi-turn': '50%', 'taxi-radius': 12 } },
    { selector: 'edge[style="route"]', style: { width: 2.5, 'curve-style': 'taxi', 'taxi-direction': 'vertical', 'taxi-turn': '50%', 'line-color': c.primary, 'line-opacity': 0.55 } },
    { selector: 'edge[label]', style: { label: 'data(label)', 'font-size': 11, 'font-weight': 500, color: c.muted, 'text-background-color': c.card, 'text-background-opacity': 1,
      'text-background-padding': '3px', 'text-background-shape': 'roundrectangle', 'text-border-width': 1, 'text-border-color': c.border, 'text-border-opacity': 1 } },
    // The member an edge belongs to, named where the edge meets its card.
    { selector: 'edge[sourceEnd]', style: { 'source-label': 'data(sourceEnd)', 'source-text-offset': 64 } },
    { selector: 'edge[targetEnd]', style: { 'target-label': 'data(targetEnd)', 'target-text-offset': 64 } },
    { selector: 'edge[sourceEnd], edge[targetEnd]', style: { 'font-size': 10.5, color: c.muted, 'text-background-color': c.card, 'text-background-opacity': 1, 'text-background-padding': '2px' } },
    { selector: 'node:selected', style: { 'border-color': c.primary, 'border-width': 3 } },
    { selector: ':parent:selected', style: { 'border-opacity': 1, 'background-opacity': 0.08 } },
    { selector: 'edge:selected', style: { 'line-color': c.primary, 'line-opacity': 1, width: 3 } },
    // ── Zoomed out (semantic zoom): cards hand over to their HTML summaries; nothing moves. ──
    // `visibility` (not `display`) keeps every member in the card's bounds, so the card keeps its size.
    { selector: 'node.overview[?member], node.overview[kind="section"]', style: { visibility: 'hidden' } },
    { selector: ':parent.overview', style: { 'text-opacity': 0, 'background-opacity': 0.06, 'border-opacity': 0.5 } },
    // Loose tiles (gateways, ungrouped devices) keep one short line, sized to read at overview zoom.
    { selector: 'node.overview[!member][kind!="section"][kind!="outside"]:childless', style: { label: 'data(short)', 'font-size': 26, 'font-weight': 600, 'text-wrap': 'ellipsis',
      'background-width': 36, 'background-height': 36 } },
    { selector: 'edge.overview[label]', style: { 'font-size': 22 } },
    { selector: 'edge.overview[sourceEnd], edge.overview[targetEnd]', style: { 'source-label': '', 'target-label': '' } },
  ];
}

export default function TopologyCanvas({ render, positions, boxes, selection, editable, onSelect, onMove, fitRef, fitKey }: {
  render: TopologyRender; positions: LayoutPosition[]; boxes: LayoutBox[]; selection?: TopologySelection; editable: boolean;
  onSelect: (selection: TopologySelection) => void;
  /** One call per drop: a dragged card reports all its members at once, so the explorer re-arranges once. */
  onMove: (positions: LayoutPosition[]) => void; fitRef: React.MutableRefObject<(() => void) | null>;
  /** Changes when the set of drawn things changes (view, network toggle); the map re-fits once per key. */
  fitKey: string;
}) {
  const { t } = useTranslation('topology');
  const container = useRef<HTMLDivElement>(null), overlay = useRef<HTMLDivElement>(null), cy = useRef<Core | null>(null);
  const callbacks = useRef({ onSelect, onMove }); callbacks.current = { onSelect, onMove };
  const fitted = useRef<string | undefined>(undefined);
  const tierRef = useRef<ZoomTier>('detail'), [tier, setTier] = useState<ZoomTier>('detail');
  /** Items Fit map left out (fitFocus); the badge counts those currently off screen. */
  const outsideRef = useRef<string[]>([]), [offscreen, setOffscreen] = useState(0);
  const frame = useRef(0), schedule = useRef<() => void>(() => {});
  const summaries = useMemo<SummaryCard[]>(() => {
    const counts = cardSummaries(render.nodes);
    return render.nodes.filter((node) => counts.has(node.id)).map((node) => ({ id: node.id, title: node.label, detail: node.detail, summary: counts.get(node.id)! }));
  }, [render]);

  useEffect(() => {
    const renderer = cytoscape({ container: container.current, elements: [], minZoom: 0.1, maxZoom: 2.5, wheelSensitivity: 0.2, style: stylesheet(palette()) });
    cy.current = renderer;
    const themeObserver = new MutationObserver(() => renderer.style(stylesheet(palette())));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    renderer.on('tap', 'node, edge', (event) => {
      if (event.target.data('kind') === 'section') return;
      const ids: string[] | undefined = event.target.data('relationshipIds');
      callbacks.current.onSelect({ kind: event.target.isNode() ? 'node' : 'edge', id: ids?.[0] ?? event.target.id() });
    });
    renderer.on('dragfree', 'node', (event) => {
      // Moving a card moves its members; positions persist for canonical nodes only.
      const moved = event.target.isParent() ? event.target.children() : event.target;
      const positions: LayoutPosition[] = [];
      moved.forEach((node: cytoscape.NodeSingular) => { if (!node.data('presentation')) positions.push({ nodeId: node.id(), ...node.position(), pinned: true }); });
      if (positions.length) callbacks.current.onMove(positions);
    });
    /** Once per animation frame at most: zoom tier, summary boxes, the off-screen badge. */
    const sync = () => {
      frame.current = 0;
      const next = nextZoomTier(tierRef.current, renderer.zoom());
      if (next !== tierRef.current) {
        tierRef.current = next;
        renderer.batch(() => { if (next === 'summary') renderer.elements().addClass('overview'); else renderer.elements().removeClass('overview'); });
        setTier(next);
      }
      const width = renderer.width(), height = renderer.height();
      if (next === 'summary') {
        overlay.current?.querySelectorAll<HTMLElement>('[data-card-id]').forEach((box) => {
          const card = renderer.getElementById(box.dataset.cardId!);
          if (!card.length) { box.style.display = 'none'; return; }
          const bb = card.renderedBoundingBox({ includeLabels: false });
          box.style.display = '';
          box.style.transform = `translate(${bb.x1}px, ${bb.y1}px)`;
          box.style.width = `${bb.w}px`; box.style.height = `${bb.h}px`;
          box.dataset.density = summaryDensity(bb.w, bb.h);
        });
      }
      const off = outsideRef.current.filter((id) => {
        const element = renderer.getElementById(id);
        if (!element.length) return false;
        const bb = element.renderedBoundingBox({});
        return bb.x2 < 0 || bb.x1 > width || bb.y2 < 0 || bb.y1 > height;
      }).length;
      setOffscreen(off);
    };
    schedule.current = () => { if (!frame.current) frame.current = requestAnimationFrame(sync); };
    renderer.on('viewport resize', () => schedule.current());
    renderer.on('position', 'node', () => schedule.current());
    const viewportTo = (bounds: Bounds, maxZoom: number) => {
      const width = renderer.width(), height = renderer.height();
      const zoom = Math.max(renderer.minZoom(), Math.min(maxZoom, (width - 2 * FIT_PADDING) / Math.max(1, bounds.x2 - bounds.x1), (height - 2 * FIT_PADDING) / Math.max(1, bounds.y2 - bounds.y1)));
      renderer.viewport({ zoom, pan: { x: width / 2 - (bounds.x1 + bounds.x2) / 2 * zoom, y: height / 2 - (bounds.y1 + bounds.y2) / 2 * zoom } });
    };
    // Fit map frames the main structure (semanticZoom.fitFocus); far-away items get the badge instead.
    fitRef.current = () => {
      const top = renderer.nodes().orphans();
      if (!top.length) return;
      const focus = fitFocus(top.map((node) => {
        const bb = node.boundingBox({});
        const anchor = node.isParent() || node.connectedEdges().connectedNodes(':parent').length > 0;
        return { id: node.id(), x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2, anchor };
      }));
      outsideRef.current = focus.outside;
      if (focus.bounds) viewportTo(focus.bounds, FIT_MAX_ZOOM);
      schedule.current();
    };
    const observer = new ResizeObserver(() => {
      const extent = renderer.extent(), center = { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
      renderer.resize();
      renderer.pan({ x: renderer.width() / 2 - center.x * renderer.zoom(), y: renderer.height() / 2 - center.y * renderer.zoom() });
      schedule.current();
    }); if (container.current) observer.observe(container.current);
    return () => { cancelAnimationFrame(frame.current); themeObserver.disconnect(); observer.disconnect(); fitRef.current = null; renderer.destroy(); cy.current = null; };
  }, []);

  useEffect(() => {
    const renderer = cy.current; if (!renderer) return;
    const sizes = new Map(boxes.map((box) => [box.id, box])), points = new Map(positions.map((point) => [point.nodeId, point]));
    const parentOf = new Map(render.nodes.filter((node) => node.parent).map((node) => [node.id, node.parent!]));
    const labelOf = new Map(render.nodes.map((node) => [node.id, node.label]));
    const family = fontFamily();
    renderer.batch(() => {
      // Parents first so children can reference them.
      const ordered = [...render.nodes].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
      const nodes: cytoscape.ElementDefinition[] = ordered.map((node) => {
        const width = sizes.get(node.id)?.width ?? 208, height = sizes.get(node.id)?.height ?? 60;
        const card = node.kind === 'group' || node.kind === 'unidentified';
        return { group: 'nodes', data: { id: node.id, display: display(node, width, family), short: clipToWidth(node.label, width - TEXT_INSET - 6, `600 26px ${family}`), kind: node.kind, width, height,
          textWidth: card ? '4000px' : `${Math.max(80, width - TEXT_INSET - TEXT_END)}px`, textShift: card || node.kind === 'outside' ? 0 : TEXT_INSET - width,
          icon: card || node.kind === 'outside' ? 'none' : glyphTileUri(node.glyph), presence: node.presence ?? undefined, member: !!node.parent,
          health: node.health ?? undefined, stale: node.stale, unverified: node.unverified, corroborated: node.corroborated, networkClass: node.networkClass ?? undefined,
          presentation: node.id.startsWith('presentation:'), titleShift: 0, ...(node.parent ? { parent: node.parent } : {}) },
          ...(card ? {} : { position: points.get(node.id) ?? { x: 0, y: 0 } }) };
      });
      // Section headers follow the packed members; they are drawing only (never persisted or selected).
      const placed = render.nodes.filter((node) => node.parent && points.has(node.id)).map((node) => ({ id: node.id, glyph: node.glyph, parent: node.parent,
        x: points.get(node.id)!.x, y: points.get(node.id)!.y, width: sizes.get(node.id)?.width ?? 208, height: sizes.get(node.id)?.height ?? 60 }));
      const headers: cytoscape.ElementDefinition[] = sectionHeaders(placed).map((header) => ({ group: 'nodes', selectable: false,
        data: { id: header.id, kind: 'section', parent: header.parent, presentation: true, member: false, width: header.width, height: 1, textWidth: `${header.width}px`,
          textShift: -header.width, icon: 'none', display: `${t(/* i18n-dynamic */ `grouped.section.${header.section}`)}   ${header.count}` },
        // The rule sits on the bottom edge of the header band; the label rides on top of it.
        position: { x: header.x, y: header.y + header.height / 2 } }));
      const drawn = routeEdgesToCards(render.edges, { parentOf: (id) => parentOf.get(id), labelOf: (id) => clip(labelOf.get(id) ?? id, 22), bundleLabel: (count) => t('grouped.bundle', { count }) });
      const cards = new Set(render.nodes.filter((node) => node.kind === 'group' || node.kind === 'unidentified').map((node) => node.id));
      const edges: cytoscape.ElementDefinition[] = drawn.map((edge) => ({ group: 'edges', data: { id: edge.id, source: edge.source, target: edge.target, style: edge.style,
        relationshipIds: edge.relationshipIds, toCard: edge.style !== 'route' && (cards.has(edge.source) || cards.has(edge.target)),
        ...(edge.label ? { label: edge.label } : {}), ...(edge.sourceEnd ? { sourceEnd: edge.sourceEnd } : {}), ...(edge.targetEnd ? { targetEnd: edge.targetEnd } : {}) } }));
      const elements = [...nodes, ...headers, ...edges];
      const ids = new Set(elements.map((element) => element.data.id));
      renderer.elements().filter((element) => !ids.has(element.id())).remove();
      for (const element of elements) {
        const existing = renderer.getElementById(element.data.id!);
        if (!existing.length) { renderer.add(element); continue; }
        const { parent, ...data } = element.data;
        if (existing.isNode() && (existing.data('parent') ?? undefined) !== parent) existing.move({ parent: parent ?? null });
        // Cytoscape merges data: clear optional edge fields a re-routed edge no longer has.
        if (existing.isEdge()) for (const key of ['label', 'sourceEnd', 'targetEnd']) if (!(key in data)) existing.removeData(key);
        existing.data(data);
        if (element.position) existing.position(element.position);
      }
      renderer.nodes().ungrabify(); if (editable) renderer.nodes('[kind!="section"]').grabify();
      renderer.elements().unselect();
      if (selection) {
        const target = selection.kind === 'edge' ? renderer.edges().filter((edge) => (edge.data('relationshipIds') as string[] | undefined)?.includes(selection.id) ?? edge.id() === selection.id)
          : renderer.getElementById(selection.id);
        target.select();
      }
      if (tierRef.current === 'summary') renderer.elements().addClass('overview'); else renderer.elements().removeClass('overview');
    });
    // Card titles left-align on the card's border (compound bounds are final only after the batch).
    renderer.nodes(':parent').forEach((card) => { card.data('titleShift', 4 - card.outerWidth()); });
    if (fitted.current !== fitKey && positions.length) { fitRef.current?.(); fitted.current = fitKey; }
    schedule.current();
  }, [render, positions, boxes, selection, editable, fitKey, t]);

  /** A summary opens its card: zoom to where tiles read, showing the card's top (its first sections). */
  const zoomToCard = (cardId: string) => {
    const renderer = cy.current, card = renderer?.getElementById(cardId);
    if (!renderer || !card?.length) return;
    const bb = card.boundingBox({}), width = renderer.width(), height = renderer.height();
    const zoom = Math.max(CARD_ZOOM, Math.min(FIT_MAX_ZOOM, (width - 2 * FIT_PADDING) / bb.w, (height - 2 * FIT_PADDING) / bb.h));
    const fitsX = bb.w * zoom <= width - 2 * FIT_PADDING, fitsY = bb.h * zoom <= height - 2 * FIT_PADDING;
    const pan = { x: fitsX ? width / 2 - (bb.x1 + bb.x2) / 2 * zoom : FIT_PADDING - bb.x1 * zoom, y: fitsY ? height / 2 - (bb.y1 + bb.y2) / 2 * zoom : FIT_PADDING - bb.y1 * zoom };
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) renderer.viewport({ zoom, pan }); else renderer.animate({ zoom, pan }, { duration: 280, easing: 'ease-out-cubic' });
  };
  const showAll = () => { const renderer = cy.current; if (renderer) { renderer.fit(undefined, FIT_PADDING); outsideRef.current = []; setOffscreen(0); } };

  return <div className="relative min-w-0 flex-1">
    <div ref={container} data-testid="topology-canvas" aria-hidden="true" className="min-w-0 bg-card text-card-foreground"
      style={{ height: 'max(560px, calc(100vh - 300px))', backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)', backgroundSize: '22px 22px' }} />
    <CardSummaryOverlay ref={overlay} cards={summaries} visible={tier === 'summary'} onZoom={zoomToCard} />
    {offscreen > 0 && <button type="button" data-testid="topology-show-all" onClick={showAll}
      className="absolute right-3 top-3 rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      {t('grouped.outside', { count: offscreen })} · <span className="font-medium text-foreground">{t('grouped.showAll')}</span>
    </button>}
  </div>;
}
