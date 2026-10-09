import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import cytoscape, { type Core } from 'cytoscape';
import type { LayoutBox, LayoutPosition } from './layoutTypes';
import type { TopologySelection } from './topologyPresentation';
import type { RenderNode, TopologyRender } from './renderProjection';
import { glyphTileUri } from './topologyGlyphs';
import { cardSummaries, sectionHeaders } from './cardSections';
import { routeEdgesToCards } from './edgeRouting';
import { canvasFillHeight, chipModes, edgeEnd, fitFocus, nextFit, nextZoomTier, screenRectToModel, summaryAnchorId, summaryDensity, summaryScale, summarySlot, type Bounds, type FitState, type ZoomTier } from './semanticZoom';
import CardSummaryOverlay, { type SummaryCard } from './CardSummaryOverlay';
import NodeChipOverlay, { overviewChips, type NodeChip } from './NodeChipOverlay';

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
const textWidth = (text: string, font: string) => {
  if (measureContext === undefined) clipToWidth('', 0, font);
  if (!measureContext) return text.length * 7;
  measureContext.font = font;
  return Math.ceil(measureContext.measureText(text).width);
};
/** Tile text starts after the glyph (12px inset + 30px glyph + 12px gap), left-aligned in every tile. */
const TEXT_INSET = 54;
/** Right padding of tile text; with TEXT_INSET it matches the measurement tile (pl-[54px] pr-[14px]). */
const TEXT_END = 14;
/** `reserve`: width kept free at the end of the address line (the "Shared IP" marker). */
function display(node: RenderNode, width: number, family: string, reserve = 0) {
  if (node.kind === 'group' || node.kind === 'unidentified') return [node.label, node.detail].filter(Boolean).join('   ·   ');
  const text = width - TEXT_INSET - TEXT_END, strong = node.kind === 'gateway' || node.kind === 'internet';
  return [clipToWidth(node.label, text, `${strong ? 600 : 500} ${strong ? 13 : 12}px ${family}`), detailLine(node, width, family, reserve) || null].filter(Boolean).join('\n');
}
/** The address line. With a marker to fit, trailing parts ("· Agent offline") give way before the address is cut. */
function detailLine(node: RenderNode, width: number, family: string, reserve: number) {
  if (!node.detail) return '';
  const room = width - TEXT_INSET - TEXT_END - reserve, font = `500 12px ${family}`;
  const full = clipToWidth(node.detail, room, font);
  if (!reserve || full === node.detail) return full;
  return clipToWidth(node.detail.split(' · ')[0]!, room, font);
}
/** The compact shared-IP marker: a small pill closing the tile's address line (#7880 note, shortened). */
const BADGE_FONT = (family: string) => `600 10px ${family}`, BADGE_HEIGHT = 16, BADGE_PAD = 6;
const badgeWidth = (label: string, family: string) => {
  if (measureContext === undefined) clipToWidth('', 0, BADGE_FONT(family));
  if (!measureContext) return label.length * 6 + 2 * BADGE_PAD;
  measureContext.font = BADGE_FONT(family);
  return Math.ceil(measureContext.measureText(label).width) + 2 * BADGE_PAD;
};
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
    { selector: 'node[kind="badge"]', style: { shape: 'round-rectangle', 'background-color': c.mutedBg, 'background-opacity': 1, 'border-width': 1, 'border-color': c.border,
      'background-image': 'none', label: 'data(display)', 'font-size': 10, 'font-weight': 600, color: c.muted, 'text-halign': 'center', 'text-valign': 'center', 'text-justification': 'center', 'text-margin-x': 0, 'text-wrap': 'none',
      'min-zoomed-font-size': 6, events: 'no' } },
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
    { selector: 'node.overview[?member], node.overview[kind="section"], node.overview[kind="badge"]', style: { visibility: 'hidden' } },
    // The box recedes to a hairline: it keeps the card's place for zoom-in continuity, the summary panel is the object.
    { selector: ':parent.overview', style: { 'text-opacity': 0, 'background-opacity': 0.012, 'border-width': 1, 'border-opacity': 0.16, 'border-style': 'solid' } },
    // Invisible stand-in for a summary panel (semanticZoom.summaryAnchorId): edges end at the panel's border.
    { selector: 'node[kind="anchor"]', style: { shape: 'round-rectangle', opacity: 0, 'background-image': 'none', label: '', events: 'no' } },
    // Loose tiles (gateways, ungrouped devices) hand over to their HTML chips (NodeChipOverlay); the node stays for its edges.
    { selector: 'node.overview[?chip]', style: { opacity: 0 } },
    { selector: 'edge.overview[label]', style: { 'font-size': 22 } },
    // Zoomed out, the edges and summaries carry the picture: lines a touch stronger than at tile zoom.
    { selector: 'edge.overview', style: { 'line-opacity': 0.9 } },
    { selector: 'edge.overview[sourceEnd], edge.overview[targetEnd]', style: { 'source-label': '', 'target-label': '' } },
  ];
}

export default function TopologyCanvas({ render, positions, boxes, selection, editable, onSelect, onMove, fitRef, fitKey, fitInsetTop = 0 }: {
  render: TopologyRender; positions: LayoutPosition[]; boxes: LayoutBox[]; selection?: TopologySelection; editable: boolean;
  onSelect: (selection: TopologySelection) => void;
  /** One call per drop: a dragged card reports all its members at once, so the explorer re-arranges once. */
  onMove: (positions: LayoutPosition[]) => void; fitRef: React.MutableRefObject<(() => void) | null>;
  /** Changes when the set of drawn things changes (view, network toggle); the map re-fits once per key. */
  fitKey: string;
  /** Pixels at the top that floating controls cover; Fit map frames the content below them. */
  fitInsetTop?: number;
}) {
  const { t } = useTranslation('topology');
  const container = useRef<HTMLDivElement>(null), overlay = useRef<HTMLDivElement>(null), chipLayer = useRef<HTMLDivElement>(null), cy = useRef<Core | null>(null);
  const callbacks = useRef({ onSelect, onMove }); callbacks.current = { onSelect, onMove };
  const insetRef = useRef(fitInsetTop); insetRef.current = fitInsetTop;
  const fitState = useRef<FitState>({});
  const tierRef = useRef<ZoomTier>('detail'), [tier, setTier] = useState<ZoomTier>('detail');
  /** The summary tier and chips belong to the grouped overview only (nextZoomTier, overviewChips). */
  const groupedRef = useRef(render.grouped); groupedRef.current = render.grouped;
  /** Items Fit map left out (fitFocus); the badge counts those currently off screen. */
  const outsideRef = useRef<string[]>([]), [offscreen, setOffscreen] = useState(0);
  const frame = useRef(0), schedule = useRef<() => void>(() => {});
  /** Canvas height (canvasFillHeight): fills the window below the canvas, recomputed on resize and when content above it changes. */
  const [fillHeight, setFillHeight] = useState<number>();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // The app scrolls inside <main>; measure as if it were scrolled to the top.
    let scroller: HTMLElement | null = element.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    let pending = 0;
    const measure = () => {
      pending = 0;
      const rect = element.getBoundingClientRect();
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        setFillHeight(canvasFillHeight({ viewportHeight: scroller.clientHeight, canvasTop: rect.top - box.top + scroller.scrollTop,
          bottomGap: parseFloat(getComputedStyle(scroller).paddingBottom) || 0 }));
      } else setFillHeight(canvasFillHeight({ viewportHeight: window.innerHeight, canvasTop: rect.top + window.scrollY, bottomGap: 16 }));
    };
    const queue = () => { if (!pending) pending = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('resize', queue);
    // Content above the canvas (operations panel, warnings, the inspector stacking on mobile) moves its top.
    const section = element.closest('section') ?? element.parentElement!;
    const observer = new ResizeObserver(queue); observer.observe(section);
    return () => { cancelAnimationFrame(pending); window.removeEventListener('resize', queue); observer.disconnect(); };
  }, []);
  const chips = useMemo<NodeChip[]>(() => overviewChips(render), [render]);
  const summaries = useMemo<SummaryCard[]>(() => {
    const counts = cardSummaries(render.nodes);
    return render.nodes.filter((node) => counts.has(node.id)).map((node) => ({ id: node.id, title: node.label, detail: node.detail, summary: counts.get(node.id)! }));
  }, [render]);

  useEffect(() => {
    // `layout: null`: Cytoscape otherwise runs a grid layout at construction. It places nothing here (no elements
    // yet; the render effect sets every position) and it throws from GridLayout.run when the container cannot be
    // measured (NaN size, e.g. a container no longer in the document), which an org switch on a site link hit (#8113).
    const renderer = cytoscape({ container: container.current, elements: [], layout: { name: 'null' }, minZoom: 0.1, maxZoom: 2.5, wheelSensitivity: 0.2, style: stylesheet(palette()) });
    cy.current = renderer;
    const themeObserver = new MutationObserver(() => renderer.style(stylesheet(palette())));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    renderer.on('tap', 'node, edge', (event) => {
      // Sections and derived network links (renderProjection.linkNetworks) stand for no single graph entity.
      if (event.target.data('kind') === 'section' || event.target.id().startsWith('link:')) return;
      const ids: string[] | undefined = event.target.data('relationshipIds');
      callbacks.current.onSelect({ kind: event.target.isNode() ? 'node' : 'edge', id: ids?.[0] ?? event.target.id() });
    });
    // Native tooltip for tiles that carry one (the full shared-IP sentence behind the compact marker).
    renderer.on('mouseover', 'node', (event) => { if (container.current) container.current.title = event.target.data('tooltip') ?? ''; });
    renderer.on('mouseout', 'node', () => { if (container.current) container.current.title = ''; });
    renderer.on('dragfree', 'node', (event) => {
      // Moving a card moves its members; positions persist for canonical nodes only.
      const moved = event.target.isParent() ? event.target.children() : event.target;
      const positions: LayoutPosition[] = [];
      moved.forEach((node: cytoscape.NodeSingular) => { if (!node.data('presentation')) positions.push({ nodeId: node.id(), ...node.position(), pinned: true }); });
      if (positions.length) callbacks.current.onMove(positions);
    });
    /** Edge ends on a card follow the zoom tier: the card box in detail, its summary panel when zoomed out. */
    const retarget = () => {
      const cards = new Set(renderer.nodes(':parent').map((card) => card.id()));
      renderer.edges().forEach((edge) => {
        const source = edgeEnd(edge.data('cardSource') ?? edge.source().id(), cards, tierRef.current);
        const target = edgeEnd(edge.data('cardTarget') ?? edge.target().id(), cards, tierRef.current);
        if (source === edge.source().id() && target === edge.target().id()) return;
        if (!renderer.getElementById(source).length || !renderer.getElementById(target).length) return;
        const selected = edge.selected();
        const moved = edge.move({ source, target });
        if (selected) moved.select();
      });
    };
    /** Sizes and places each card's anchor over its summary panel (model space), so edges meet the panel. */
    const placeAnchors = () => {
      const host = container.current?.getBoundingClientRect();
      if (!host) return;
      const pan = renderer.pan(), zoom = renderer.zoom();
      overlay.current?.querySelectorAll<HTMLElement>('[data-card-id]').forEach((box) => {
        const anchor = renderer.getElementById(summaryAnchorId(box.dataset.cardId!));
        const panel = box.querySelector('button')?.getBoundingClientRect();
        if (!anchor.length || !panel || !panel.width || box.style.display === 'none') return;
        const model = screenRectToModel({ left: panel.left - host.left, top: panel.top - host.top, width: panel.width, height: panel.height }, pan, zoom);
        const current = anchor.position();
        if (Math.abs(current.x - model.x) > 0.5 || Math.abs(current.y - model.y) > 0.5) anchor.position({ x: model.x, y: model.y });
        if (Math.abs(anchor.data('width') - model.width) > 0.5 || Math.abs(anchor.data('height') - model.height) > 0.5) anchor.data({ width: model.width, height: model.height });
      });
    };
    /** Once per animation frame at most: zoom tier, summary boxes and anchors, the off-screen badge. */
    const sync = () => {
      frame.current = 0;
      const next = nextZoomTier(tierRef.current, renderer.zoom(), groupedRef.current);
      if (next !== tierRef.current) {
        tierRef.current = next;
        renderer.batch(() => { if (next === 'summary') renderer.elements().addClass('overview'); else renderer.elements().removeClass('overview'); retarget(); });
        setTier(next);
        // The overlay is shown on the next React commit; place the anchors once its panels have a size.
        requestAnimationFrame(() => schedule.current());
      }
      const width = renderer.width(), height = renderer.height();
      if (next === 'summary') {
        overlay.current?.querySelectorAll<HTMLElement>('[data-card-id]').forEach((box) => {
          const card = renderer.getElementById(box.dataset.cardId!);
          if (!card.length) { box.style.display = 'none'; return; }
          // Pinned to the top of the on-screen part of the card (summarySlot), so it sits where the title was
          // and panning a big card never loses it.
          const slot = summarySlot(card.renderedBoundingBox({ includeLabels: false }), width, height);
          if (!slot) { box.style.display = 'none'; return; }
          box.style.display = '';
          box.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
          box.style.width = `${slot.width}px`; box.style.height = `${slot.height}px`;
          box.dataset.density = summaryDensity(slot.width, slot.height);
          // A small card's summary shrinks to fit (to a legible floor), then overhangs its receded box.
          const panel = box.querySelector<HTMLElement>('button');
          if (panel) panel.style.transform = `scale(${summaryScale(panel.offsetWidth, panel.offsetHeight, slot.width, slot.height)})`;
        });
        // Each chip sits centred on its node and at least as large as it, so the node's edges meet the chip.
        // Chips step down (full → compact → icon) when the node draws small or two chips would overlap (chipModes).
        const family = fontFamily(), boxes = [...(chipLayer.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])];
        const placed = boxes.flatMap((box) => {
          const node = renderer.getElementById(box.dataset.nodeId!);
          if (!node.length) { box.style.display = 'none'; return []; }
          const bb = node.renderedBoundingBox({ includeLabels: false });
          const title = textWidth(box.dataset.title ?? '', `600 13px ${family}`), detail = textWidth(box.dataset.detail ?? '', `400 11px ${family}`);
          return [{ box, chip: { id: box.dataset.nodeId!, x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2, nodeW: bb.w, nodeH: bb.h,
            fullW: 52 + Math.max(title, detail), compactW: 52 + title } }];
        });
        const modes = chipModes(placed.map(({ chip }) => chip));
        for (const { box, chip } of placed) {
          box.style.display = '';
          box.style.transform = `translate(${chip.x}px, ${chip.y}px) translate(-50%, -50%)`;
          box.style.minWidth = `${chip.nodeW}px`; box.style.minHeight = `${chip.nodeH}px`;
          box.dataset.mode = modes.get(chip.id);
        }
        placeAnchors();
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
    renderer.on('position', 'node[kind!="anchor"]', () => schedule.current());
    const viewportTo = (bounds: Bounds, maxZoom: number) => {
      const width = renderer.width(), inset = insetRef.current, height = renderer.height() - inset;
      const zoom = Math.max(renderer.minZoom(), Math.min(maxZoom, (width - 2 * FIT_PADDING) / Math.max(1, bounds.x2 - bounds.x1), (height - 2 * FIT_PADDING) / Math.max(1, bounds.y2 - bounds.y1)));
      renderer.viewport({ zoom, pan: { x: width / 2 - (bounds.x1 + bounds.x2) / 2 * zoom, y: inset + height / 2 - (bounds.y1 + bounds.y2) / 2 * zoom } });
    };
    // Fit map frames the main structure (semanticZoom.fitFocus); far-away items get the badge instead.
    fitRef.current = () => {
      const top = renderer.nodes().orphans().difference('[kind="anchor"]').nodes();
      if (!top.length) return;
      const focus = fitFocus(top.map((node) => {
        const bb = node.boundingBox({});
        // Only cards anchor the frame: a far-away node does not join it just because an edge reaches a card.
        return { id: node.id(), x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2, anchor: node.isParent() };
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
    // Leaving the grouped overview while zoomed out: back to tiles before this render's edges and classes are built.
    if (!render.grouped && tierRef.current === 'summary') { tierRef.current = 'detail'; setTier('detail'); }
    const sizes = new Map(boxes.map((box) => [box.id, box])), points = new Map(positions.map((point) => [point.nodeId, point]));
    const parentOf = new Map(render.nodes.filter((node) => node.parent).map((node) => [node.id, node.parent!]));
    const labelOf = new Map(render.nodes.map((node) => [node.id, node.label]));
    const family = fontFamily();
    const badgeLabel = t('grouped.sharedIpBadge'), badgeW = badgeWidth(badgeLabel, family);
    renderer.batch(() => {
      // Parents first so children can reference them.
      const ordered = [...render.nodes].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
      const nodes: cytoscape.ElementDefinition[] = ordered.map((node) => {
        const width = sizes.get(node.id)?.width ?? 208, height = sizes.get(node.id)?.height ?? 60;
        const card = node.kind === 'group' || node.kind === 'unidentified';
        return { group: 'nodes', data: { id: node.id, display: display(node, width, family, node.sharedWith > 0 ? badgeW + 6 : 0), tooltip: node.note ?? undefined, chip: !node.parent && !card && node.kind !== 'outside', kind: node.kind, width, height,
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
      // Card ends follow the zoom tier (box in detail, summary anchor when zoomed out); cardSource/cardTarget remember the card.
      const edges: cytoscape.ElementDefinition[] = drawn.map((edge) => ({ group: 'edges', data: { id: edge.id, source: edgeEnd(edge.source, cards, tierRef.current),
        target: edgeEnd(edge.target, cards, tierRef.current), style: edge.style,
        ...(cards.has(edge.source) ? { cardSource: edge.source } : {}), ...(cards.has(edge.target) ? { cardTarget: edge.target } : {}),
        relationshipIds: edge.relationshipIds, toCard: edge.style !== 'route' && (cards.has(edge.source) || cards.has(edge.target)),
        ...(edge.label ? { label: edge.label } : {}), ...(edge.sourceEnd ? { sourceEnd: edge.sourceEnd } : {}), ...(edge.targetEnd ? { targetEnd: edge.targetEnd } : {}) } }));
      // Shared-IP markers close the address line; the full sentence is the tile's tooltip and in the inspector.
      const badges: cytoscape.ElementDefinition[] = render.nodes.filter((node) => node.sharedWith > 0 && points.has(node.id)).map((node) => {
        const point = points.get(node.id)!, width = sizes.get(node.id)?.width ?? 208;
        // Right after the address text (clipped to leave the marker room), not floating at the tile's edge.
        const detail = detailLine(node, width, family, badgeW + 6);
        const textEnd = measureContext ? (measureContext.font = `500 12px ${family}`, measureContext.measureText(detail).width) : detail.length * 6.5;
        return { group: 'nodes', selectable: false, data: { id: `badge:${node.id}`, kind: 'badge', presentation: true, member: false, display: badgeLabel, width: badgeW, height: BADGE_HEIGHT,
          textShift: 0, textWidth: `${badgeW + 40}px`, icon: 'none', ...(node.parent ? { parent: node.parent } : {}) },
          // Address line centre: two 12px lines at 1.35 line height, centred in the tile.
          position: { x: point.x - width / 2 + TEXT_INSET + textEnd + 6 + badgeW / 2, y: point.y + 8 } };
      });
      // One invisible anchor per card, placed over its summary panel by the sync loop (never persisted or laid out).
      const anchors: cytoscape.ElementDefinition[] = [...cards].map((card) => {
        const members = render.nodes.filter((node) => node.parent === card && points.has(node.id)).map((node) => points.get(node.id)!);
        const centre = members.length ? { x: members.reduce((sum, p) => sum + p.x, 0) / members.length, y: members.reduce((sum, p) => sum + p.y, 0) / members.length } : { x: 0, y: 0 };
        return { group: 'nodes', selectable: false, data: { id: summaryAnchorId(card), kind: 'anchor', presentation: true, member: false, width: 1, height: 1, icon: 'none', display: '', textShift: 0, textWidth: '1px' },
          position: centre };
      });
      const elements = [...nodes, ...headers, ...badges, ...anchors, ...edges];
      const ids = new Set(elements.map((element) => element.data.id));
      renderer.elements().filter((element) => !ids.has(element.id())).remove();
      for (const element of elements) {
        const existing = renderer.getElementById(element.data.id!);
        if (!existing.length) { renderer.add(element); continue; }
        // An anchor's size and place belong to the sync loop once it exists.
        if (existing.data('kind') === 'anchor') continue;
        const { parent, source, target, ...data } = element.data;
        if (existing.isNode() && (existing.data('parent') ?? undefined) !== parent) existing.move({ parent: parent ?? null });
        if (existing.isEdge()) {
          // Cytoscape merges data: clear optional edge fields a re-routed edge no longer has.
          for (const key of ['label', 'sourceEnd', 'targetEnd', 'cardSource', 'cardTarget']) if (!(key in data)) existing.removeData(key);
          if (existing.source().id() !== source || existing.target().id() !== target) { existing.move({ source, target }).data(data); continue; }
        }
        existing.data(data);
        if (element.position) existing.position(element.position);
      }
      renderer.nodes().ungrabify(); if (editable) renderer.nodes('[kind!="section"][kind!="badge"]').grabify();
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
    const fit = nextFit(fitState.current, fitKey, positions); fitState.current = fit.state;
    if (fit.fit) fitRef.current?.();
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
      style={{ height: fillHeight ? `${fillHeight}px` : 'max(480px, calc(100vh - 300px))', backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)', backgroundSize: '22px 22px' }} />
    <CardSummaryOverlay ref={overlay} cards={summaries} visible={tier === 'summary'} onZoom={zoomToCard} />
    <NodeChipOverlay ref={chipLayer} chips={chips} visible={tier === 'summary'} selectedId={selection?.kind === 'node' ? selection.id : undefined} onSelect={(id) => onSelect({ kind: 'node', id })} />
    {offscreen > 0 && <button type="button" data-testid="topology-show-all" onClick={showAll}
      className="absolute right-3 top-3 rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      {t('grouped.outside', { count: offscreen })} · <span className="font-medium text-foreground">{t('grouped.showAll')}</span>
    </button>}
  </div>;
}
