import { useEffect, useRef } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import type { LayoutBox, LayoutPosition } from './layoutTypes';
import type { TopologySelection } from './topologyPresentation';
import type { RenderNode, TopologyRender } from './renderProjection';
import { glyphTileUri } from './topologyGlyphs';

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
/** Cytoscape's own ellipsis truncates far too early on scaled canvases; clip in JS and let labels wrap. */
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const display = (node: RenderNode) => node.kind === 'group' || node.kind === 'unidentified'
  ? [node.label, node.detail].filter(Boolean).join('   ·   ')
  : [clip(node.label, node.kind === 'gateway' ? 26 : 22), node.detail ? clip(node.detail, 28) : null].filter(Boolean).join('\n');

function stylesheet(c: ReturnType<typeof palette>): cytoscape.StylesheetJson {
  return [
    { selector: 'node', style: { shape: 'round-rectangle', width: 'data(width)', height: 'data(height)', 'background-color': c.card, 'border-width': 1, 'border-color': c.border,
      label: 'data(display)', color: c.foreground, 'font-size': 12, 'font-weight': 500, 'text-wrap': 'wrap', 'text-max-width': 'data(textWidth)', 'text-valign': 'center',
      'text-halign': 'center', 'text-justification': 'left', 'text-margin-x': 18, 'line-height': 1.35, 'min-zoomed-font-size': 7,
      'background-image': 'data(icon)', 'background-width': 30, 'background-height': 30, 'background-position-x': 12, 'background-position-y': '50%', 'background-clip': 'none',
      'background-image-containment': 'over' } },
    { selector: 'node[kind="gateway"], node[kind="internet"]', style: { 'border-width': 1.5, 'border-color': c.primary, 'font-weight': 600, 'font-size': 13, 'background-width': 34, 'background-height': 34 } },
    { selector: 'node[kind="outside"]', style: { shape: 'round-diamond', 'border-style': 'dotted', 'background-image': 'none', 'text-margin-x': 0, color: c.muted } },
    { selector: 'node[kind="network"]', style: { 'border-style': 'dashed' } },
    { selector: 'node[presence="offline"]', style: { opacity: 0.6 } },
    { selector: 'node[?stale]', style: { 'border-style': 'dashed' } },
    { selector: 'node[?unverified]', style: { 'border-style': 'dashed', 'background-color': c.mutedBg } },
    // Red/amber/green describe measured health only (design §153); unknown stays neutral.
    { selector: 'node[health="healthy"]', style: { 'border-color': c.success, 'border-width': 2 } },
    { selector: 'node[health="degraded"]', style: { 'border-color': c.warning, 'border-width': 2 } },
    { selector: 'node[health="failed_check"]', style: { 'border-color': c.destructive, 'border-width': 2.5 } },
    { selector: ':parent', style: { shape: 'round-rectangle', 'background-color': c.primary, 'background-opacity': 0.045, 'border-color': c.primary, 'border-opacity': 0.4,
      'border-width': 1.5, padding: '24px', 'background-image': 'none', 'text-valign': 'top', 'text-halign': 'center', 'text-margin-x': 0, 'text-margin-y': -6,
      'font-size': 'data(headerSize)', 'font-weight': 600, 'text-max-width': '4000px', 'min-zoomed-font-size': 4, color: c.foreground } },
    { selector: ':parent[kind="unidentified"], :parent[networkClass!="lan"][kind="group"]', style: { 'border-style': 'dashed', 'background-color': c.mutedBg, 'background-opacity': 0.5, 'border-color': c.muted, 'border-opacity': 0.6 } },
    { selector: 'edge', style: { width: 1.5, 'line-color': c.muted, 'line-opacity': 0.75, 'curve-style': 'bezier', 'line-style': 'dashed', 'line-dash-pattern': [6, 4] } },
    { selector: 'edge[style="physical"]', style: { 'line-style': 'solid', width: 2 } },
    { selector: 'edge[style="inferred"], edge[style="shared"]', style: { 'line-style': 'dotted' } },
    { selector: 'edge[style="route"]', style: { width: 2.5, 'curve-style': 'taxi', 'taxi-direction': 'vertical', 'taxi-turn': '50%', 'line-color': c.primary, 'line-opacity': 0.55 } },
    { selector: 'edge[label]', style: { label: 'data(label)', 'font-size': 11, color: c.muted, 'text-background-color': c.card, 'text-background-opacity': 1, 'text-background-padding': '3px' } },
    { selector: 'node:selected', style: { 'border-color': c.primary, 'border-width': 3 } },
    { selector: ':parent:selected', style: { 'border-opacity': 1, 'background-opacity': 0.09 } },
    { selector: 'edge:selected', style: { 'line-color': c.primary, 'line-opacity': 1, width: 3 } },
  ];
}

export default function TopologyCanvas({ render, positions, boxes, selection, editable, onSelect, onMove, fitRef, fitKey }: {
  render: TopologyRender; positions: LayoutPosition[]; boxes: LayoutBox[]; selection?: TopologySelection; editable: boolean;
  onSelect: (selection: TopologySelection) => void; onMove: (position: LayoutPosition) => void; fitRef: React.MutableRefObject<(() => void) | null>;
  /** Changes when the set of drawn things changes (view, network toggle); the map re-fits once per key. */
  fitKey: string;
}) {
  const container = useRef<HTMLDivElement>(null), cy = useRef<Core | null>(null);
  const callbacks = useRef({ onSelect, onMove }); callbacks.current = { onSelect, onMove };
  const fitted = useRef<string | undefined>(undefined);
  useEffect(() => {
    const renderer = cytoscape({ container: container.current, elements: [], minZoom: 0.1, maxZoom: 2.5, wheelSensitivity: 0.2, style: stylesheet(palette()) });
    cy.current = renderer;
    const themeObserver = new MutationObserver(() => renderer.style(stylesheet(palette())));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    renderer.on('tap', 'node, edge', (event) => callbacks.current.onSelect({ kind: event.target.isNode() ? 'node' : 'edge', id: event.target.id() }));
    renderer.on('dragfree', 'node', (event) => {
      // Moving a card moves its members; positions persist for canonical nodes only.
      const moved = event.target.isParent() ? event.target.children() : event.target;
      moved.forEach((node: cytoscape.NodeSingular) => { if (!node.data('presentation')) callbacks.current.onMove({ nodeId: node.id(), ...node.position(), pinned: true }); });
    });
    fitRef.current = () => renderer.fit(undefined, 48);
    const observer = new ResizeObserver(() => {
      const extent = renderer.extent(), center = { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
      renderer.resize();
      renderer.pan({ x: renderer.width() / 2 - center.x * renderer.zoom(), y: renderer.height() / 2 - center.y * renderer.zoom() });
    }); if (container.current) observer.observe(container.current);
    return () => { themeObserver.disconnect(); observer.disconnect(); fitRef.current = null; renderer.destroy(); cy.current = null; };
  }, []);
  useEffect(() => {
    const renderer = cy.current; if (!renderer) return;
    const sizes = new Map(boxes.map((box) => [box.id, box])), points = new Map(positions.map((point) => [point.nodeId, point]));
    renderer.batch(() => {
      // Parents first so children can reference them.
      const ordered = [...render.nodes].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
      const nodes: cytoscape.ElementDefinition[] = ordered.map((node) => {
        const width = sizes.get(node.id)?.width ?? 208, height = sizes.get(node.id)?.height ?? 60;
        const card = node.kind === 'group' || node.kind === 'unidentified';
        return { group: 'nodes', data: { id: node.id, display: display(node), kind: node.kind, width, height, textWidth: card ? '4000px' : `${Math.max(80, width - 60)}px`,
          icon: card || node.kind === 'outside' ? 'none' : glyphTileUri(node.glyph), presence: node.presence ?? undefined,
          health: node.health ?? undefined, stale: node.stale, unverified: node.unverified, networkClass: node.networkClass ?? undefined,
          presentation: node.id.startsWith('presentation:'), headerSize: 15, ...(node.parent ? { parent: node.parent } : {}) },
          ...(card ? {} : { position: points.get(node.id) ?? { x: 0, y: 0 } }) };
      });
      const edges: cytoscape.ElementDefinition[] = render.edges.map((edge) => ({ group: 'edges', data: { id: edge.id, source: edge.source, target: edge.target, style: edge.style, ...(edge.label ? { label: edge.label } : {}) } }));
      const elements = [...nodes, ...edges];
      const ids = new Set(elements.map((element) => element.data.id));
      renderer.elements().filter((element) => !ids.has(element.id())).remove();
      for (const element of elements) {
        const existing = renderer.getElementById(element.data.id!);
        if (!existing.length) { renderer.add(element); continue; }
        const { parent, ...data } = element.data;
        if (existing.isNode() && (existing.data('parent') ?? undefined) !== parent) existing.move({ parent: parent ?? null });
        existing.data(data);
        if (element.position) existing.position(element.position);
      }
      renderer.nodes().ungrabify(); if (editable) renderer.nodes().grabify();
      renderer.elements().unselect(); if (selection) renderer.getElementById(selection.id).select();
    });
    // Card headers scale with the card (compound bounds are final only after the batch),
    // so a site-wide fit still reads "10.1.2.0/24 · 70 devices".
    renderer.nodes(':parent').forEach((card) => {
      const chars = Math.max(10, String(card.data('display') ?? '').length);
      card.data('headerSize', Math.round(Math.min(26, Math.max(14, (card.width() - 24) / (chars * 0.56)))));
    });
    if (fitted.current !== fitKey && positions.length) { renderer.fit(undefined, 48); fitted.current = fitKey; }
  }, [render, positions, boxes, selection, editable, fitKey]);
  return <div ref={container} data-testid="topology-canvas" aria-hidden="true" className="min-w-0 flex-1 bg-card text-card-foreground"
    style={{ height: 'max(560px, calc(100vh - 300px))', backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)', backgroundSize: '22px 22px' }} />;
}
