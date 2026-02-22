import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { fetchWithAuth } from '../../stores/auth';

export type TopologyNodeType =
  | 'router'
  | 'switch'
  | 'server'
  | 'workstation'
  | 'printer'
  | 'firewall'
  | 'access_point'
  | 'device'
  | 'unknown';
export type TopologyNodeStatus = 'online' | 'offline' | 'warning';

export type TopologyNode = {
  id: string;
  label: string;
  type: TopologyNodeType;
  status: TopologyNodeStatus;
  ipAddress?: string;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
};

export type TopologyLink = {
  source: string | TopologyNode;
  target: string | TopologyNode;
  type: 'wired' | 'wireless';
  subnet?: string;
};

type ApiTopologyNode = {
  id: string;
  label?: string | null;
  type?: string | null;
  status?: string | null;
  ipAddress?: string | null;
};

type ApiTopologyLink = {
  source: string;
  target: string;
  type?: string | null;
};

type NetworkTopologyMapProps = {
  height?: number;
  onNodeClick?: (nodeId: string) => void;
};

const typeColors: Record<TopologyNodeType, string> = {
  router: '#0f766e',
  switch: '#2563eb',
  server: '#7c3aed',
  workstation: '#0f172a',
  printer: '#f97316',
  firewall: '#dc2626',
  access_point: '#0891b2',
  device: '#1e293b',
  unknown: '#6b7280'
};

const statusStroke: Record<TopologyNodeStatus, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  warning: '#eab308'
};

const typeIcon: Record<TopologyNodeType, string> = {
  router: 'R',
  switch: 'S',
  server: 'V',
  workstation: 'W',
  printer: 'P',
  firewall: 'F',
  access_point: 'A',
  device: 'D',
  unknown: '?'
};

const typeLabels: Record<TopologyNodeType, string> = {
  router: 'Router',
  switch: 'Switch',
  server: 'Server',
  workstation: 'Workstation',
  printer: 'Printer',
  firewall: 'Firewall',
  access_point: 'Access Point',
  device: 'Device',
  unknown: 'Unknown'
};

const typeMap: Record<string, TopologyNodeType> = {
  router: 'router',
  switch: 'switch',
  server: 'server',
  workstation: 'workstation',
  printer: 'printer',
  firewall: 'firewall',
  access_point: 'access_point',
  device: 'device',
  unknown: 'unknown'
};

const INFRA_TYPES = new Set<TopologyNodeType>(['router', 'switch', 'firewall', 'access_point']);

function mapNode(node: ApiTopologyNode): TopologyNode {
  const normalizedType = (node.type ?? 'unknown').toLowerCase();
  const normalizedStatus = (node.status ?? 'online').toLowerCase();

  return {
    id: node.id,
    label: node.label ?? node.id,
    type: typeMap[normalizedType] ?? 'unknown',
    status: normalizedStatus === 'offline' || normalizedStatus === 'warning' ? normalizedStatus : 'online',
    ipAddress: node.ipAddress ?? undefined
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

function getSubnetPrefix(ip: string): string | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.slice(0, 3).join('.');
}

function generateSubnetEdges(nodes: TopologyNode[]): TopologyLink[] {
  const subnets = new Map<string, TopologyNode[]>();
  for (const node of nodes) {
    if (!node.ipAddress) continue;
    const prefix = getSubnetPrefix(node.ipAddress);
    if (!prefix) continue;
    let group = subnets.get(prefix);
    if (!group) {
      group = [];
      subnets.set(prefix, group);
    }
    group.push(node);
  }

  const edges: TopologyLink[] = [];
  for (const [prefix, group] of subnets) {
    if (group.length < 2) continue;
    const hub = group.find(n => INFRA_TYPES.has(n.type)) ?? group[0];
    for (const node of group) {
      if (node.id === hub.id) continue;
      edges.push({
        source: hub.id,
        target: node.id,
        type: 'wired',
        subnet: `${prefix}.0/24`
      });
    }
  }
  return edges;
}

function curvedPath(
  sx: number,
  sy: number,
  tx: number,
  ty: number
): string {
  const dx = tx - sx;
  const dy = ty - sy;
  const dr = Math.sqrt(dx * dx + dy * dy) * 1.5;
  return `M${sx},${sy}A${dr},${dr} 0 0,1 ${tx},${ty}`;
}

export default function NetworkTopologyMap({ height = 560, onNodeClick }: NetworkTopologyMapProps) {
  const [nodes, setNodes] = useState<TopologyNode[]>([]);
  const [links, setLinks] = useState<TopologyLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    node: TopologyNode;
  } | null>(null);

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
      const mappedNodes: TopologyNode[] = rawNodes.map(mapNode);
      const nodeIds = new Set(mappedNodes.map((n: TopologyNode) => n.id));
      let mappedLinks: TopologyLink[] = rawLinks
        .map(mapLink)
        .filter((l: TopologyLink) => {
          const src = typeof l.source === 'string' ? l.source : l.source.id;
          const tgt = typeof l.target === 'string' ? l.target : l.target.id;
          return nodeIds.has(src) && nodeIds.has(tgt);
        });

      // If no real edges, infer from subnet grouping
      if (mappedLinks.length === 0 && mappedNodes.length > 1) {
        mappedLinks = generateSubnetEdges(mappedNodes);
      }

      setNodes(mappedNodes);
      setLinks(mappedLinks);
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

    // Defs for pulsing animation
    const defs = svg.append('defs');
    const style = defs.append('style');
    style.text(`
      @keyframes pulse-stroke {
        0%, 100% { stroke-opacity: 1; }
        50% { stroke-opacity: 0.4; }
      }
      .node-online { animation: pulse-stroke 2.5s ease-in-out infinite; }
    `);

    // Zoom container
    const container = svg.append('g').attr('class', 'zoom-container');

    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
      });
    svg.call(zoomBehavior);

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

    // Edge group
    const linkGroup = container
      .append('g')
      .attr('class', 'links');

    const link = linkGroup
      .selectAll<SVGPathElement, TopologyLink>('path')
      .data(linksMemo)
      .enter()
      .append('path')
      .attr('fill', 'none')
      .attr('stroke', '#94a3b8')
      .attr('stroke-opacity', 0.5)
      .attr('stroke-width', d => (d.type === 'wireless' ? 1.5 : 2))
      .attr('stroke-dasharray', d => (d.type === 'wireless' ? '6 4' : '0'));

    // Edge hover labels (hidden by default)
    const linkLabel = linkGroup
      .selectAll<SVGTextElement, TopologyLink>('text')
      .data(linksMemo.filter(l => l.subnet))
      .enter()
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('font-size', 9)
      .attr('fill', '#64748b')
      .attr('opacity', 0)
      .text(d => d.subnet ?? '');

    // Node group
    const nodeGroup = container
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, TopologyNode>('g')
      .data(nodesMemo)
      .enter()
      .append('g')
      .style('cursor', 'pointer');

    // Drag behavior
    const drag = d3.drag<SVGGElement, TopologyNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeGroup.call(drag);

    // Circle
    nodeGroup
      .append('circle')
      .attr('r', 20)
      .attr('fill', d => typeColors[d.type])
      .attr('stroke', d => statusStroke[d.status])
      .attr('stroke-width', 3)
      .attr('class', d => d.status === 'online' ? 'node-online' : '');

    // Type icon inside circle
    nodeGroup
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('font-size', 13)
      .attr('font-weight', '700')
      .attr('fill', '#fff')
      .attr('pointer-events', 'none')
      .text(d => typeIcon[d.type] ?? '?');

    // Label below node
    nodeGroup
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', 36)
      .attr('font-size', 11)
      .attr('fill', '#334155')
      .attr('pointer-events', 'none')
      .text(d => d.label);

    // Build adjacency for hover highlighting
    const adjacency = new Set<string>();
    const connectedNodes = new Map<string, Set<string>>();
    for (const l of linksMemo) {
      const src = typeof l.source === 'string' ? l.source : l.source.id;
      const tgt = typeof l.target === 'string' ? l.target : l.target.id;
      adjacency.add(`${src}-${tgt}`);
      adjacency.add(`${tgt}-${src}`);
      if (!connectedNodes.has(src)) connectedNodes.set(src, new Set());
      if (!connectedNodes.has(tgt)) connectedNodes.set(tgt, new Set());
      connectedNodes.get(src)!.add(tgt);
      connectedNodes.get(tgt)!.add(src);
    }

    // Hover handlers
    nodeGroup
      .on('mouseenter', (event: MouseEvent, d: TopologyNode) => {
        const connected = connectedNodes.get(d.id) ?? new Set();

        // Dim unconnected nodes
        nodeGroup.attr('opacity', n =>
          n.id === d.id || connected.has(n.id) ? 1 : 0.2
        );

        // Highlight connected edges
        link
          .attr('stroke', l => {
            const src = typeof l.source === 'string' ? l.source : (l.source as TopologyNode).id;
            const tgt = typeof l.target === 'string' ? l.target : (l.target as TopologyNode).id;
            return src === d.id || tgt === d.id ? '#3b82f6' : '#94a3b8';
          })
          .attr('stroke-opacity', l => {
            const src = typeof l.source === 'string' ? l.source : (l.source as TopologyNode).id;
            const tgt = typeof l.target === 'string' ? l.target : (l.target as TopologyNode).id;
            return src === d.id || tgt === d.id ? 0.9 : 0.15;
          })
          .attr('stroke-width', l => {
            const src = typeof l.source === 'string' ? l.source : (l.source as TopologyNode).id;
            const tgt = typeof l.target === 'string' ? l.target : (l.target as TopologyNode).id;
            const base = l.type === 'wireless' ? 1.5 : 2;
            return src === d.id || tgt === d.id ? base + 1.5 : base;
          });

        // Show subnet labels on connected edges
        linkLabel.attr('opacity', l => {
          const src = typeof l.source === 'string' ? l.source : (l.source as TopologyNode).id;
          const tgt = typeof l.target === 'string' ? l.target : (l.target as TopologyNode).id;
          return src === d.id || tgt === d.id ? 1 : 0;
        });

        // Show tooltip
        setTooltip({
          x: event.pageX + 12,
          y: event.pageY - 10,
          node: d
        });
      })
      .on('mousemove', (event: MouseEvent) => {
        setTooltip(prev =>
          prev ? { ...prev, x: event.pageX + 12, y: event.pageY - 10 } : null
        );
      })
      .on('mouseleave', () => {
        nodeGroup.attr('opacity', 1);
        link
          .attr('stroke', '#94a3b8')
          .attr('stroke-opacity', 0.5)
          .attr('stroke-width', d => (d.type === 'wireless' ? 1.5 : 2));
        linkLabel.attr('opacity', 0);
        setTooltip(null);
      });

    // Click handler
    if (onNodeClick) {
      nodeGroup.on('click', (_event: MouseEvent, d: TopologyNode) => {
        onNodeClick(d.id);
      });
    }

    simulation.on('tick', () => {
      link.attr('d', d => {
        const src = d.source as unknown as TopologyNode;
        const tgt = d.target as unknown as TopologyNode;
        return curvedPath(src.x ?? 0, src.y ?? 0, tgt.x ?? 0, tgt.y ?? 0);
      });

      linkLabel
        .attr('x', d => {
          const src = d.source as unknown as TopologyNode;
          const tgt = d.target as unknown as TopologyNode;
          return ((src.x ?? 0) + (tgt.x ?? 0)) / 2;
        })
        .attr('y', d => {
          const src = d.source as unknown as TopologyNode;
          const tgt = d.target as unknown as TopologyNode;
          return ((src.y ?? 0) + (tgt.y ?? 0)) / 2 - 8;
        });

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
          <p className="text-sm text-muted-foreground">
            Force-directed map of discovered connections. Scroll to zoom, drag to pan.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: statusStroke.online }} />
            Online
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: statusStroke.warning }} />
            Warning
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: statusStroke.offline }} />
            Offline
          </span>
        </div>
      </div>

      {error && nodes.length > 0 && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div ref={containerRef} className="relative mt-6 overflow-hidden rounded-md border bg-muted/30">
        <svg ref={svgRef} className="h-full w-full" style={{ height }} />
        {tooltip && (
          <div
            className="pointer-events-none fixed z-50 rounded-md border bg-card px-3 py-2 text-xs shadow-lg"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <p className="font-semibold">{tooltip.node.label}</p>
            {tooltip.node.ipAddress && (
              <p className="text-muted-foreground">{tooltip.node.ipAddress}</p>
            )}
            <p className="text-muted-foreground">
              {typeLabels[tooltip.node.type]} &middot;{' '}
              <span
                style={{ color: statusStroke[tooltip.node.status] }}
                className="font-medium"
              >
                {tooltip.node.status}
              </span>
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {Object.entries(typeColors).map(([type, color]) => (
          <span key={type} className="flex items-center gap-1.5">
            <svg width="16" height="16" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="7" fill={color} />
              <text
                x="8"
                y="8"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="8"
                fontWeight="700"
                fill="#fff"
              >
                {typeIcon[type as TopologyNodeType] ?? '?'}
              </text>
            </svg>
            {typeLabels[type as TopologyNodeType] ?? type}
          </span>
        ))}
        {onNodeClick && (
          <span className="ml-auto text-muted-foreground/60">Click a node to view details</span>
        )}
      </div>
    </div>
  );
}
