import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { fetchWithAuth } from '../../stores/auth';
import { cn, heightPxClass, leftPxClass, topPxClass } from '@/lib/utils';
import {
  groupNodesBySubnet,
  parseProfileSubnets,
  type SubnetGroup
} from './topologySubnets';

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
  // Layout fields populated per-render.
  subnet?: string;
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

// Above this node count we abandon the live force simulation (which gets
// expensive and visually unstable) in favor of a static grouped grid. Issue
// #1325 Tier 1 perf guard.
const FORCE_SIM_NODE_LIMIT = 150;

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

const statusDotClass: Record<TopologyNodeStatus, string> = {
  online: 'bg-green-500',
  offline: 'bg-red-500',
  warning: 'bg-yellow-500'
};

const statusTextClass: Record<TopologyNodeStatus, string> = {
  online: 'text-green-500',
  offline: 'text-red-500',
  warning: 'text-yellow-500'
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

// Infrastructure nodes anchor a subnet and get visual emphasis (larger radius).
const INFRA_TYPES = new Set<TopologyNodeType>(['router', 'switch', 'firewall', 'access_point']);

const NODE_RADIUS = 18;
const INFRA_NODE_RADIUS = 26;

function nodeRadius(node: TopologyNode): number {
  return INFRA_TYPES.has(node.type) ? INFRA_NODE_RADIUS : NODE_RADIUS;
}

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

type LayoutGroup = {
  group: SubnetGroup<TopologyNode>;
  cx: number;
  cy: number;
};

/**
 * Assign each subnet group a cluster centre on a grid. Used both as the seed
 * for force-clustering (small graphs) and as the final position for the static
 * grid layout (large graphs).
 */
function computeGroupCentres(
  groups: SubnetGroup<TopologyNode>[],
  width: number,
  height: number
): LayoutGroup[] {
  const count = groups.length || 1;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = width / cols;
  const cellH = height / rows;

  return groups.map((group, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      group,
      cx: cellW * (col + 0.5),
      cy: cellH * (row + 0.5)
    };
  });
}

export default function NetworkTopologyMap({ height = 560, onNodeClick }: NetworkTopologyMapProps) {
  const [nodes, setNodes] = useState<TopologyNode[]>([]);
  const [links, setLinks] = useState<TopologyLink[]>([]);
  const [profileSubnets, setProfileSubnets] = useState<string[]>([]);
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
      const rawSubnets: string[] = Array.isArray(data.subnets) ? data.subnets : [];
      const mappedNodes: TopologyNode[] = rawNodes.map(mapNode);
      const nodeIds = new Set(mappedNodes.map((n: TopologyNode) => n.id));

      // Only ever render edges the backend actually observed. We deliberately do
      // NOT fabricate adjacency from IP prefixes anymore (issue #1325): the
      // system collects no real inter-host connectivity, so a guessed star is
      // misleading. Real LLDP/CDP/SNMP-bridge collection is a Tier 2 follow-up.
      const mappedLinks: TopologyLink[] = rawLinks
        .map(mapLink)
        .filter((l: TopologyLink) => {
          const src = typeof l.source === 'string' ? l.source : l.source.id;
          const tgt = typeof l.target === 'string' ? l.target : l.target.id;
          return nodeIds.has(src) && nodeIds.has(tgt);
        });

      setNodes(mappedNodes);
      setLinks(mappedLinks);
      setProfileSubnets(rawSubnets);
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

  const subnetGroups = useMemo(
    () => groupNodesBySubnet(nodes, parseProfileSubnets(profileSubnets)),
    [nodes, profileSubnets]
  );

  // Stamp the resolved subnet label onto each node for tooltips/legend.
  const subnetByNodeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of subnetGroups) {
      for (const node of group.nodes) map.set(node.id, group.label);
    }
    return map;
  }, [subnetGroups]);

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
      .scaleExtent([0.2, 3])
      .on('zoom', (event) => {
        container.attr('transform', event.transform);
      });
    svg.call(zoomBehavior);

    const groupCentres = computeGroupCentres(subnetGroups, chartWidth, chartHeight);
    const centreByNodeId = new Map<string, LayoutGroup>();
    for (const lg of groupCentres) {
      for (const node of lg.group.nodes) centreByNodeId.set(node.id, lg);
    }

    // Seed nodes near their subnet centre so clusters form quickly / read well.
    for (const node of nodesMemo) {
      const lg = centreByNodeId.get(node.id);
      if (lg) {
        node.x = lg.cx + (Math.random() - 0.5) * 40;
        node.y = lg.cy + (Math.random() - 0.5) * 40;
      }
    }

    // ---- Subnet group containers (labelled) ----
    const groupLayer = container.append('g').attr('class', 'subnet-groups');
    const groupCells = groupLayer
      .selectAll<SVGGElement, LayoutGroup>('g')
      .data(groupCentres)
      .enter()
      .append('g')
      .attr('class', 'subnet-group');

    groupCells
      .append('text')
      .attr('x', (d) => d.cx)
      .attr('y', (d) => d.cy)
      .attr('text-anchor', 'middle')
      .attr('class', 'subnet-group-label')
      .attr('font-size', 12)
      .attr('font-weight', '600')
      .attr('fill', '#475569')
      .attr('pointer-events', 'none')
      .each(function (d) {
        const text = d3.select(this);
        text.append('tspan').attr('x', d.cx).text(d.group.label);
        text
          .append('tspan')
          .attr('x', d.cx)
          .attr('dy', '1.2em')
          .attr('font-size', 10)
          .attr('font-weight', '400')
          .attr('fill', '#94a3b8')
          .text(`${d.group.nodes.length} host${d.group.nodes.length === 1 ? '' : 's'}`);
      });

    const useForceSim = nodesMemo.length <= FORCE_SIM_NODE_LIMIT;

    // ---- Edges (only when the backend observed real ones) ----
    const linkLayer = container.append('g').attr('class', 'links');
    const link = linkLayer
      .selectAll<SVGLineElement, TopologyLink>('line')
      .data(linksMemo)
      .enter()
      .append('line')
      .attr('stroke', '#94a3b8')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', (d) => (d.type === 'wireless' ? 1.5 : 2))
      .attr('stroke-dasharray', (d) => (d.type === 'wireless' ? '6 4' : '0'));

    // ---- Nodes ----
    const nodeGroup = container
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, TopologyNode>('g')
      .data(nodesMemo)
      .enter()
      .append('g')
      .style('cursor', 'pointer');

    nodeGroup
      .append('circle')
      .attr('r', (d) => nodeRadius(d))
      .attr('fill', (d) => typeColors[d.type])
      .attr('stroke', (d) => statusStroke[d.status])
      .attr('stroke-width', (d) => (INFRA_TYPES.has(d.type) ? 4 : 3))
      .attr('class', (d) => (d.status === 'online' ? 'node-online' : ''));

    nodeGroup
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('font-size', (d) => (INFRA_TYPES.has(d.type) ? 15 : 13))
      .attr('font-weight', '700')
      .attr('fill', '#fff')
      .attr('pointer-events', 'none')
      .text((d) => typeIcon[d.type] ?? '?');

    nodeGroup
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => nodeRadius(d) + 14)
      .attr('font-size', 11)
      .attr('fill', '#334155')
      .attr('pointer-events', 'none')
      .text((d) => d.label);

    // Hover + tooltip
    nodeGroup
      .on('mouseenter', (event: MouseEvent, d: TopologyNode) => {
        const subnet = subnetByNodeId.get(d.id);
        nodeGroup.attr('opacity', (n) =>
          n.id === d.id || subnetByNodeId.get(n.id) === subnet ? 1 : 0.25
        );
        setTooltip({ x: event.pageX + 12, y: event.pageY - 10, node: { ...d, subnet } });
      })
      .on('mousemove', (event: MouseEvent) => {
        setTooltip((prev) =>
          prev ? { ...prev, x: event.pageX + 12, y: event.pageY - 10 } : null
        );
      })
      .on('mouseleave', () => {
        nodeGroup.attr('opacity', 1);
        setTooltip(null);
      });

    if (onNodeClick) {
      nodeGroup.on('click', (_event: MouseEvent, d: TopologyNode) => {
        onNodeClick(d.id);
      });
    }

    const positionNodes = () => {
      nodeGroup.attr('transform', (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
      link
        .attr('x1', (d) => (d.source as unknown as TopologyNode).x ?? 0)
        .attr('y1', (d) => (d.source as unknown as TopologyNode).y ?? 0)
        .attr('x2', (d) => (d.target as unknown as TopologyNode).x ?? 0)
        .attr('y2', (d) => (d.target as unknown as TopologyNode).y ?? 0);
    };

    if (!useForceSim) {
      // Static grouped grid: lay nodes out in a tidy block under each subnet
      // centre. No simulation — cheap and stable for large result sets.
      for (const lg of groupCentres) {
        const members = lg.group.nodes;
        const perRow = Math.ceil(Math.sqrt(members.length)) || 1;
        const spacing = 52;
        members.forEach((member, idx) => {
          const liveNode = nodesMemo.find((n) => n.id === member.id);
          if (!liveNode) return;
          const col = idx % perRow;
          const row = Math.floor(idx / perRow);
          const rowCount = Math.ceil(members.length / perRow);
          liveNode.x = lg.cx + (col - (perRow - 1) / 2) * spacing;
          liveNode.y = lg.cy + 28 + (row - (rowCount - 1) / 2) * spacing;
        });
      }
      positionNodes();
      return () => {};
    }

    // Force layout with per-subnet clustering: forceX/forceY pull each node to
    // its subnet centre, so groups stay visually separated instead of forming
    // one hairball.
    const simulation = d3
      .forceSimulation<TopologyNode>(nodesMemo)
      .force(
        'link',
        d3
          .forceLink<TopologyNode, TopologyLink>(linksMemo)
          .id((d) => d.id)
          .distance(90)
      )
      .force('charge', d3.forceManyBody().strength(-220))
      .force(
        'x',
        d3
          .forceX<TopologyNode>((d) => centreByNodeId.get(d.id)?.cx ?? chartWidth / 2)
          .strength(0.35)
      )
      .force(
        'y',
        d3
          .forceY<TopologyNode>((d) => centreByNodeId.get(d.id)?.cy ?? chartHeight / 2)
          .strength(0.35)
      )
      .force('collision', d3.forceCollide<TopologyNode>().radius((d) => nodeRadius(d) + 14));

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

    // Keep subnet labels anchored to the live cluster centroid.
    simulation.on('tick', () => {
      positionNodes();
      groupCells.select<SVGTextElement>('text').each(function (d) {
        const members = d.group.nodes
          .map((m) => nodesMemo.find((n) => n.id === m.id))
          .filter((n): n is TopologyNode => !!n);
        if (members.length === 0) return;
        const cx = members.reduce((sum, n) => sum + (n.x ?? 0), 0) / members.length;
        const minY = Math.min(...members.map((n) => (n.y ?? 0) - nodeRadius(n)));
        const text = d3.select(this);
        text.selectAll('tspan').attr('x', cx);
        text.attr('y', minY - 24);
      });
    });

    return () => {
      simulation.stop();
    };
  }, [height, linksMemo, nodesMemo, onNodeClick, subnetGroups, subnetByNodeId]);

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

  const isLargeSet = nodes.length > FORCE_SIM_NODE_LIMIT;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Network Topology</h2>
          <p className="text-sm text-muted-foreground">
            Discovered assets grouped by subnet. Scroll to zoom, drag to pan.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', statusDotClass.online)} />
            Online
          </span>
          <span className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', statusDotClass.warning)} />
            Warning
          </span>
          <span className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', statusDotClass.offline)} />
            Offline
          </span>
        </div>
      </div>

      {error && nodes.length > 0 && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Honesty note: we only draw connections we actually observed. */}
      <div
        data-testid="topology-adjacency-note"
        className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      >
        {links.length === 0 ? (
          <>
            Connection lines are shown only when real adjacency is measured (LLDP/CDP/SNMP).
            None has been collected yet, so assets are grouped by subnet without inferred links.
          </>
        ) : (
          <>Connection lines reflect measured adjacency.</>
        )}
        {isLargeSet && (
          <> Showing a static grouped layout for {nodes.length} assets (force layout disabled above {FORCE_SIM_NODE_LIMIT}).</>
        )}
      </div>

      <div ref={containerRef} className="relative mt-4 overflow-hidden rounded-md border bg-muted/30">
        <svg ref={svgRef} data-testid="topology-svg" className={cn('h-full w-full', heightPxClass(height))} />
        {tooltip && (
          <div
            className={cn(
              'pointer-events-none fixed z-50 rounded-md border bg-card px-3 py-2 text-xs shadow-lg',
              leftPxClass(tooltip.x),
              topPxClass(tooltip.y)
            )}
          >
            <p className="font-semibold">{tooltip.node.label}</p>
            {tooltip.node.ipAddress && (
              <p className="text-muted-foreground">{tooltip.node.ipAddress}</p>
            )}
            {tooltip.node.subnet && (
              <p className="text-muted-foreground">Subnet: {tooltip.node.subnet}</p>
            )}
            <p className="text-muted-foreground">
              {typeLabels[tooltip.node.type]} &middot;{' '}
              <span className={cn('font-medium', statusTextClass[tooltip.node.status])}>
                {tooltip.node.status}
              </span>
            </p>
          </div>
        )}
      </div>

      {/* Subnet legend with host counts. */}
      {subnetGroups.length > 0 && (
        <div className="mt-4" data-testid="topology-subnet-legend">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Subnets</p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {subnetGroups.map((group) => (
              <span
                key={group.label}
                className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-0.5 text-muted-foreground"
              >
                <span className="font-medium text-foreground">{group.label}</span>
                <span className="text-muted-foreground/70">{group.nodes.length}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Device-type legend. */}
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
