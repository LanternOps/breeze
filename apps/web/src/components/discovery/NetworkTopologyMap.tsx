import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { fetchWithAuth } from '../../stores/auth';

export type TopologyNodeType =
  | 'router'
  | 'switch'
  | 'server'
  | 'workstation'
  | 'printer'
  | 'device'
  | 'unknown';
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

type ApiTopologyNode = {
  id: string;
  label?: string | null;
  type?: string | null;
  status?: string | null;
};

type ApiTopologyLink = {
  source: string;
  target: string;
  type?: string | null;
};

type NetworkTopologyMapProps = {
  height?: number;
  onNodeClick?: () => void;
};

const typeColors: Record<TopologyNodeType, string> = {
  router: '#0f766e',
  switch: '#2563eb',
  server: '#7c3aed',
  workstation: '#0f172a',
  printer: '#f97316',
  device: '#1e293b',
  unknown: '#6b7280'
};

const statusStroke: Record<TopologyNodeStatus, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  warning: '#eab308'
};

const typeMap: Record<string, TopologyNodeType> = {
  router: 'router',
  switch: 'switch',
  server: 'server',
  workstation: 'workstation',
  printer: 'printer',
  device: 'device',
  unknown: 'unknown'
};

function mapNode(node: ApiTopologyNode): TopologyNode {
  const normalizedType = (node.type ?? 'unknown').toLowerCase();
  const normalizedStatus = (node.status ?? 'online').toLowerCase();

  return {
    id: node.id,
    label: node.label ?? node.id,
    type: typeMap[normalizedType] ?? 'unknown',
    status: normalizedStatus === 'offline' || normalizedStatus === 'warning' ? normalizedStatus : 'online'
  };
}

function mapLink(link: ApiTopologyLink): TopologyLink {
  const linkType = (link.type ?? 'wired').toLowerCase();
  return {
    source: link.source,
    target: link.target,
    type: linkType === 'wireless' ? 'wireless' : 'wired'
  };
}

export default function NetworkTopologyMap({ height = 420, onNodeClick }: NetworkTopologyMapProps) {
  const [nodes, setNodes] = useState<TopologyNode[]>([]);
  const [links, setLinks] = useState<TopologyLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const svgRef = useRef<SVGSVGElement | null>(null);

  const fetchTopology = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/discovery/topology');
      if (!response.ok) {
        throw new Error('Failed to fetch topology');
      }
      const data = await response.json();
      const rawNodes = data.nodes ?? data.data?.nodes ?? [];
      const rawLinks = data.edges ?? data.links ?? data.data?.edges ?? [];
      setNodes(rawNodes.map(mapNode));
      setLinks(rawLinks.map(mapLink));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTopology();
  }, [fetchTopology]);

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
      .attr('stroke-width', 3)
      .style('cursor', onNodeClick ? 'pointer' : 'default');

    if (onNodeClick) {
      nodeGroup.on('click', () => onNodeClick());
    }

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
  }, [height, linksMemo, nodesMemo, onNodeClick]);

  if (loading && nodes.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading topology...</p>
        </div>
      </div>
    );
  }

  if (error && nodes.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchTopology}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

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

      {error && nodes.length > 0 && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-md border bg-muted/30">
        <svg ref={svgRef} className="h-full w-full" style={{ height }} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {Object.entries(typeColors).map(([type, color]) => (
          <span key={type} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            {type}
          </span>
        ))}
        {onNodeClick && (
          <span className="ml-auto text-muted-foreground/60">Click a node to view assets</span>
        )}
      </div>
    </div>
  );
}
