import { useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';

export type TopologyNodeType = 'router' | 'switch' | 'server' | 'workstation' | 'printer' | 'unknown';
export type TopologyNodeStatus = 'online' | 'offline' | 'warning';

export type TopologyNode = {
  id: string;
  label: string;
  type: TopologyNodeType;
  status: TopologyNodeStatus;
  x?: number;
  y?: number;
};

export type TopologyLink = {
  source: string;
  target: string;
  type: 'wired' | 'wireless';
};

type NetworkTopologyMapProps = {
  nodes: TopologyNode[];
  links: TopologyLink[];
  height?: number;
};

const typeColors: Record<TopologyNodeType, string> = {
  router: '#0f766e',
  switch: '#2563eb',
  server: '#7c3aed',
  workstation: '#0f172a',
  printer: '#f97316',
  unknown: '#6b7280'
};

const statusStroke: Record<TopologyNodeStatus, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  warning: '#eab308'
};

export default function NetworkTopologyMap({ nodes, links, height = 420 }: NetworkTopologyMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const nodesMemo = useMemo(() => nodes.map(node => ({ ...node })), [nodes]);
  const linksMemo = useMemo(() => links.map(link => ({ ...link })), [links]);

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const { width } = svgRef.current.getBoundingClientRect();
    const chartWidth = width || 800;
    const chartHeight = height;

    svg.attr('viewBox', `0 0 ${chartWidth} ${chartHeight}`);

    const simulation = d3
      .forceSimulation<TopologyNode>(nodesMemo)
      .force(
        'link',
        d3
          .forceLink<TopologyNode, TopologyLink>(linksMemo)
          .id(d => d.id)
          .distance(120)
      )
      .force('charge', d3.forceManyBody().strength(-320))
      .force('center', d3.forceCenter(chartWidth / 2, chartHeight / 2))
      .force('collision', d3.forceCollide().radius(36));

    const link = svg
      .append('g')
      .attr('stroke', '#94a3b8')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(linksMemo)
      .enter()
      .append('line')
      .attr('stroke-width', d => (d.type === 'wireless' ? 1.5 : 2.5))
      .attr('stroke-dasharray', d => (d.type === 'wireless' ? '4 4' : '0'));

    const nodeGroup = svg.append('g').selectAll('g').data(nodesMemo).enter().append('g');

    nodeGroup
      .append('circle')
      .attr('r', 18)
      .attr('fill', d => typeColors[d.type])
      .attr('stroke', d => statusStroke[d.status])
      .attr('stroke-width', 3);

    nodeGroup
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', 34)
      .attr('font-size', 11)
      .attr('fill', '#334155')
      .text(d => d.label);

    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as unknown as TopologyNode).x ?? 0)
        .attr('y1', d => (d.source as unknown as TopologyNode).y ?? 0)
        .attr('x2', d => (d.target as unknown as TopologyNode).x ?? 0)
        .attr('y2', d => (d.target as unknown as TopologyNode).y ?? 0);

      nodeGroup.attr('transform', d => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
    });

    return () => {
      simulation.stop();
    };
  }, [height, linksMemo, nodesMemo]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Network Topology</h2>
          <p className="text-sm text-muted-foreground">Force-directed map of discovered connections.</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: statusStroke.online }} />
            Online
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: statusStroke.warning }} />
            Warning
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: statusStroke.offline }} />
            Offline
          </span>
        </div>
      </div>
      <div className="mt-6 overflow-hidden rounded-md border bg-muted/30">
        <svg ref={svgRef} className="h-full w-full" style={{ height }} />
      </div>
      <div className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
        {Object.entries(typeColors).map(([type, color]) => (
          <span key={type} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            {type}
          </span>
        ))}
      </div>
    </div>
  );
}
