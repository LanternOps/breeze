import { useEffect, useRef } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import type { GraphResponse } from '@breeze/shared';
import type { LayoutBox, LayoutPosition } from './layoutTypes';
import type { TopologySelection } from './topologyPresentation';
export default function TopologyCanvas({ graph, positions, boxes, selection, editable, onSelect, onMove, fitRef }: {
  graph: GraphResponse; positions: LayoutPosition[]; boxes: LayoutBox[]; selection?: TopologySelection; editable: boolean;
  onSelect: (selection: TopologySelection) => void; onMove: (position: LayoutPosition) => void; fitRef: React.MutableRefObject<(() => void) | null>;
}) {
  const container = useRef<HTMLDivElement>(null), cy = useRef<Core | null>(null);
  const callbacks = useRef({ onSelect, onMove }); callbacks.current = { onSelect, onMove };
  const fitted = useRef(false);
  useEffect(() => {
    const colors = getComputedStyle(container.current!);
    const renderer = cytoscape({ container: container.current, elements: [], minZoom: 0.15, maxZoom: 2, wheelSensitivity: 0.2,
      style: [
        { selector: 'node', style: { label: 'data(label)', width: 'data(width)', height: 'data(height)', shape: 'round-rectangle', 'background-color': colors.backgroundColor, 'border-color': colors.borderTopColor, 'border-width': 1, color: colors.color, 'text-valign': 'center', 'text-wrap': 'ellipsis', 'text-max-width': '230px', 'font-size': 14 } },
        { selector: 'node[?presentation]', style: { shape: 'round-diamond', 'border-style': 'dotted', 'background-color': colors.backgroundColor } },
        { selector: 'edge', style: { width: 1.5, 'line-color': '#64748b', 'curve-style': 'bezier', 'line-style': 'dashed' } },
        { selector: 'edge[?physical]', style: { 'line-style': 'solid' } },
        { selector: 'edge[?inferred]', style: { 'line-style': 'dotted' } },
        { selector: ':selected', style: { 'border-color': '#2563eb', 'border-width': 3, 'line-color': '#2563eb' } },
      ] });
    cy.current = renderer;
    const applyTheme = () => {
      if (!container.current) return;
      const colors = getComputedStyle(container.current);
      renderer.style().selector('node').style({ 'background-color': colors.backgroundColor, color: colors.color, 'border-color': colors.borderTopColor }).update();
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    renderer.on('tap', 'node, edge', (event) => callbacks.current.onSelect({ kind: event.target.isNode() ? 'node' : 'edge', id: event.target.id() }));
    renderer.on('dragfree', 'node', (event) => { if (!event.target.data('presentation')) callbacks.current.onMove({ nodeId: event.target.id(), ...event.target.position(), pinned: true }); });
    fitRef.current = () => renderer.fit(undefined, 40);
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
      const elements: cytoscape.ElementDefinition[] = [...graph.nodes, ...graph.presentation.nodes].map((node) => ({ group: 'nodes', data: { id: node.id, label: node.label, presentation: 'authority' in node, width: sizes.get(node.id)?.width ?? 220, height: sizes.get(node.id)?.height ?? 88 }, position: points.get(node.id) ?? { x: 0, y: 0 } }));
      elements.push(...[...graph.relationships, ...graph.presentation.edges].map((edge) => ({ group: 'edges' as const, data: { id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, physical: 'kind' in edge && edge.kind === 'physical_link', inferred: 'presentationOnly' in edge || 'evidence' in edge && edge.evidence.classes.includes('inferred') } })));
      const ids = new Set(elements.map((element) => element.data.id));
      renderer.elements().filter((element) => !ids.has(element.id())).remove();
      for (const element of elements) { const existing = renderer.getElementById(element.data.id!); if (existing.length) { existing.data(element.data); if (element.position) existing.position(element.position); } else renderer.add(element); }
      renderer.nodes().ungrabify(); if (editable) renderer.nodes('[!presentation]').grabify();
      renderer.elements().unselect(); if (selection) renderer.getElementById(selection.id).select();
    });
    if (!fitted.current && positions.length) { renderer.fit(undefined, 40); fitted.current = true; }
  }, [graph, positions, boxes, selection, editable]);
  return <div ref={container} data-testid="topology-canvas" aria-hidden="true" className="h-[34rem] min-w-0 flex-1 border-border bg-card text-card-foreground" />;
}
