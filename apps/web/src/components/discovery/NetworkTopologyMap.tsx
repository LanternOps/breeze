import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '../../lib/permissions';
import { runAction, handleActionError } from '@/lib/runAction';
import { cn } from '@/lib/utils';
import {
  groupNodesBySubnet,
  parseProfileSubnets,
  type SubnetGroup
} from './topologySubnets';

// Register the fcose layout once at module scope (guarded — re-registering on a
// hot-reload throws). Used for Auto-arrange of never-placed nodes only.
let fcoseRegistered = false;
function registerFcose() {
  if (fcoseRegistered) return;
  try {
    cytoscape.use(fcose);
  } catch {
    // Already registered (HMR / duplicate import) — non-fatal.
  }
  fcoseRegistered = true;
}

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
  siteId?: string;
  subnet?: string;
  // 'manual' = hand-mapped placeholder (editable/deletable), 'discovered' = scan
  // asset. Preserved from the GET payload so a manual node reloaded from the
  // server stays connect/delete-able (#1728).
  kind?: 'manual' | 'discovered';
};

export type TopologyEdgeMethod = 'lldp' | 'cdp' | 'fdb' | 'manual';

export type TopologyLink = {
  id: string;
  source: string;
  target: string;
  type: 'wired' | 'wireless';
  method?: TopologyEdgeMethod;
  confidence?: string | null;
  interfaceName?: string | null;
  vlan?: number | null;
};

export type TopologyLayoutRow = {
  nodeType: 'discovered_asset' | 'manual_node';
  nodeId: string;
  x: number;
  y: number;
  pinned: boolean;
};

type ApiTopologyNode = {
  id: string;
  label?: string | null;
  type?: string | null;
  status?: string | null;
  ipAddress?: string | null;
  siteId?: string | null;
  kind?: 'manual' | 'discovered' | null;
};

type ApiTopologyLink = {
  id?: string | null;
  source: string;
  target: string;
  type?: string | null;
  method?: TopologyEdgeMethod | null;
  confidence?: string | null;
  interfaceName?: string | null;
  vlan?: number | null;
};

// The currently-selected canvas element, surfaced in the inspector panel. An
// edge carries `method`/`confidence`/provenance; a node carries `kind`.
export type SelectedElement = {
  id: string;
  group: 'nodes' | 'edges';
  method?: TopologyEdgeMethod | null;
  confidence?: string | null;
  interfaceName?: string | null;
  vlan?: number | null;
  kind?: 'manual' | 'discovered' | null;
};

// Imperative edit-mode API published once the Cytoscape instance is ready. Used
// by the connect gesture (edge-handles / two-tap select) and by tests to drive
// `connectNodes`/`selectElement` directly (the gestures aren't simulable in jsdom).
export type TopologyEditApi = {
  connectNodes: (sourceId: string, targetId: string) => Promise<void>;
  selectElement: (selected: SelectedElement | null) => void;
};

type NetworkTopologyMapProps = {
  height?: number;
  onNodeClick?: (nodeId: string) => void;
  onEditApiReady?: (api: TopologyEditApi) => void;
};

const statusDotClass: Record<TopologyNodeStatus, string> = {
  online: 'bg-green-500',
  offline: 'bg-red-500',
  warning: 'bg-yellow-500'
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

// Infrastructure nodes anchor a subnet and get visual emphasis (larger / hub shape).
const INFRA_TYPES = new Set<TopologyNodeType>(['router', 'switch', 'firewall', 'access_point']);

// Manual placeholder-node roles offered by the edit-mode palette (#1728 phase 4).
// Mirrors the API's `manualNodeRoleSchema` enum.
const MANUAL_ROLES = ['switch', 'router', 'ap', 'firewall', 'patch_panel', 'other'] as const;
type ManualRole = (typeof MANUAL_ROLES)[number];

const MANUAL_ROLE_LABELS: Record<ManualRole, string> = {
  switch: 'Switch',
  router: 'Router',
  ap: 'Access Point',
  firewall: 'Firewall',
  patch_panel: 'Patch Panel',
  other: 'Other'
};

function roleLabel(role: ManualRole): string {
  return MANUAL_ROLE_LABELS[role] ?? role;
}

function mapNode(node: ApiTopologyNode): TopologyNode {
  const normalizedType = (node.type ?? 'unknown').toLowerCase();
  const normalizedStatus = (node.status ?? 'online').toLowerCase();
  return {
    id: node.id,
    label: node.label ?? node.id,
    type: typeMap[normalizedType] ?? 'unknown',
    status:
      normalizedStatus === 'offline' || normalizedStatus === 'warning' ? normalizedStatus : 'online',
    ipAddress: node.ipAddress ?? undefined,
    siteId: node.siteId ?? undefined,
    kind: node.kind ?? undefined
  };
}

function mapLink(link: ApiTopologyLink, idx: number): TopologyLink {
  const linkType = (link.type ?? 'wired').toLowerCase();
  return {
    id: link.id ?? `${link.source}->${link.target}-${idx}`,
    source: link.source,
    target: link.target,
    type: linkType === 'wireless' ? 'wireless' : 'wired',
    method: link.method ?? undefined,
    confidence: link.confidence,
    interfaceName: link.interfaceName,
    vlan: link.vlan
  };
}

/**
 * Cytoscape stylesheet. Node styling keys off `data(infra)`/`data(status)`;
 * edges color by measured provenance (`data(method)`):
 *   lldp/cdp (high)   → solid blue   (#2563eb)
 *   fdb (medium)      → solid green  (#16a34a)
 *   manual (asserted) → dashed orange(#f97316)  (ships now, used in Phase 4)
 */
function buildStylesheet(): cytoscape.StylesheetStyle[] {
  return [
    {
      selector: 'node',
      style: {
        'background-color': (ele: cytoscape.NodeSingular) =>
          typeColors[(ele.data('type') as TopologyNodeType) ?? 'unknown'] ?? typeColors.unknown,
        'border-color': (ele: cytoscape.NodeSingular) =>
          statusStroke[(ele.data('status') as TopologyNodeStatus) ?? 'online'] ?? statusStroke.online,
        'border-width': 3,
        label: 'data(label)',
        color: '#334155',
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        width: 30,
        height: 30
      } as cytoscape.Css.Node
    },
    {
      selector: 'node[?infra]',
      style: {
        width: 48,
        height: 48,
        shape: 'round-rectangle',
        'border-width': 4
      } as cytoscape.Css.Node
    },
    {
      selector: '$node > node',
      style: {
        'background-opacity': 0.06,
        'border-width': 1,
        'border-color': '#cbd5e1',
        label: 'data(label)',
        'text-valign': 'top',
        'font-size': 12,
        color: '#475569'
      } as cytoscape.Css.Node
    },
    {
      selector: 'edge',
      style: {
        width: 2,
        'line-color': '#94a3b8',
        'curve-style': 'bezier'
      } as cytoscape.Css.Edge
    },
    {
      selector: 'edge[method = "lldp"], edge[method = "cdp"]',
      style: { 'line-color': '#2563eb', 'line-style': 'solid' } as cytoscape.Css.Edge
    },
    {
      selector: 'edge[method = "fdb"]',
      style: { 'line-color': '#16a34a', 'line-style': 'solid' } as cytoscape.Css.Edge
    },
    {
      selector: 'edge[method = "manual"]',
      style: { 'line-color': '#f97316', 'line-style': 'dashed' } as cytoscape.Css.Edge
    }
  ];
}

export default function NetworkTopologyMap({
  height = 560,
  onNodeClick,
  onEditApiReady
}: NetworkTopologyMapProps) {
  const [nodes, setNodes] = useState<TopologyNode[]>([]);
  const [links, setLinks] = useState<TopologyLink[]>([]);
  const [layout, setLayout] = useState<TopologyLayoutRow[]>([]);
  const [profileSubnets, setProfileSubnets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // Manual-mapping edit mode (issue #1728 Phase 4) — gated by topology:write.
  const { can } = usePermissions();
  const canEdit = can('topology', 'write');
  const [editMode, setEditMode] = useState(false);
  // The element selected in the canvas, shown in the inspector (manual edge →
  // delete; measured edge → read-only provenance; manual node → delete).
  const [selected, setSelected] = useState<SelectedElement | null>(null);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  // siteId per node, so a drag can persist the dragged node's own site.
  const siteByNodeRef = useRef<Map<string, string | undefined>>(new Map());
  // node ids that already have a saved (placed) position — Auto-arrange must not
  // disturb these.
  const placedRef = useRef<Set<string>>(new Set());
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  // Edit-mode two-tap connect state, read from inside the stable cy tap handler.
  const editModeRef = useRef(false);
  const connectSourceRef = useRef<string | null>(null);
  const connectNodesRef = useRef<((s: string, t: string) => Promise<void>) | null>(null);

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
      const rawLayout: TopologyLayoutRow[] = Array.isArray(data.layout) ? data.layout : [];

      const mappedNodes: TopologyNode[] = rawNodes.map(mapNode);
      const nodeIds = new Set(mappedNodes.map((n: TopologyNode) => n.id));

      // Only ever render edges the backend actually observed (issue #1325). We
      // deliberately do NOT fabricate adjacency from IP prefixes.
      const mappedLinks: TopologyLink[] = rawLinks
        .map(mapLink)
        .filter((l: TopologyLink) => nodeIds.has(l.source) && nodeIds.has(l.target));

      setNodes(mappedNodes);
      setLinks(mappedLinks);
      // Skip malformed layout rows so a bad x/y can't crash the canvas.
      setLayout(
        rawLayout.filter(
          (r) => r && Number.isFinite(r.x) && Number.isFinite(r.y) && typeof r.nodeId === 'string'
        )
      );
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

  const subnetGroups = useMemo(
    () => groupNodesBySubnet(nodes, parseProfileSubnets(profileSubnets)),
    [nodes, profileSubnets]
  );

  // subnet label per node → compound parent grouping.
  const subnetByNodeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of subnetGroups) {
      for (const node of group.nodes) map.set(node.id, group.label);
    }
    return map;
  }, [subnetGroups]);

  // Manual nodes require a site to scope the insert (RLS doesn't defend the site
  // axis). The topology view is org-wide; derive the active site as the single
  // distinct site among loaded nodes. If assets span multiple sites (or none has
  // a site yet) we can't pick one unambiguously, so the palette is disabled.
  const activeSiteId = useMemo(() => {
    const siteIds = new Set<string>();
    for (const n of nodes) if (n.siteId) siteIds.add(n.siteId);
    return siteIds.size === 1 ? [...siteIds][0] : undefined;
  }, [nodes]);

  const addManualNode = useCallback(
    async (role: ManualRole) => {
      if (!activeSiteId) return;
      try {
        const node = await runAction<{ id: string; label: string; role: string }>({
          request: () =>
            fetchWithAuth('/discovery/topology/manual-node', {
              method: 'POST',
              body: JSON.stringify({ siteId: activeSiteId, role, label: roleLabel(role) })
            }),
          errorFallback: 'Failed to add node',
          successMessage: 'Node added',
          onUnauthorized: () => {
            /* let the auth redirect handle it */
          }
        });
        // Drop the new node onto the canvas (Phase 3 cy ref). It re-renders from
        // the server on the next topology fetch; this gives immediate feedback.
        cyRef.current?.add({
          data: { id: node.id, label: node.label, kind: 'manual', role: node.role }
        });
      } catch (err) {
        handleActionError(err, 'Failed to add node.');
      }
    },
    [activeSiteId]
  );

  // Resolve a node id to a manual-edge endpoint descriptor. Manual placeholders
  // (kind 'manual') map to `manual_node`; everything else is a `discovered_asset`.
  const endpointFor = useCallback(
    (nodeId: string): { type: 'manual_node' | 'discovered_asset'; id: string } | null => {
      const n = cyRef.current?.getElementById(nodeId);
      if (!n || n.empty()) return null;
      return { type: n.data('kind') === 'manual' ? 'manual_node' : 'discovered_asset', id: nodeId };
    },
    []
  );

  // Draw a manual edge between two nodes (#1728 phase 4). Self-connect is refused
  // client-side; the created edge renders with the Phase 3 dashed-orange style
  // keyed on `method:'manual'`.
  const connectNodes = useCallback(
    async (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return;
      if (!activeSiteId) return;
      const source = endpointFor(sourceId);
      const target = endpointFor(targetId);
      if (!source || !target) return;
      try {
        const edge = await runAction<{ id: string }>({
          request: () =>
            fetchWithAuth('/discovery/topology/manual-edge', {
              method: 'POST',
              body: JSON.stringify({ siteId: activeSiteId, source, target })
            }),
          errorFallback: 'Failed to connect nodes',
          successMessage: 'Connection added',
          onUnauthorized: () => {
            /* let the auth redirect handle it */
          }
        });
        cyRef.current?.add({
          data: {
            id: edge.id,
            source: sourceId,
            target: targetId,
            method: 'manual',
            confidence: 'asserted'
          }
        });
      } catch (err) {
        handleActionError(err, 'Failed to connect nodes.');
      }
    },
    [activeSiteId, endpointFor]
  );

  // Delete a manual edge (#1728 phase 4). The API only removes `method='manual'`
  // rows; measured edges are scan-owned and have no delete path here.
  const deleteManualEdge = useCallback(async (id: string) => {
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/discovery/topology/manual-edge/${id}`, { method: 'DELETE' }),
        errorFallback: 'Failed to delete connection',
        successMessage: 'Connection removed',
        onUnauthorized: () => {
          /* let the auth redirect handle it */
        }
      });
      cyRef.current?.getElementById(id)?.remove();
      setSelected((cur) => (cur?.id === id ? null : cur));
    } catch (err) {
      handleActionError(err, 'Failed to delete connection.');
    }
  }, []);

  // Delete a manual placeholder node (#1728 phase 4). The API cascade-cleans its
  // manual edges + layout row server-side; locally we drop the node and its now
  // orphaned edges from the canvas.
  const deleteManualNode = useCallback(async (id: string) => {
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/discovery/topology/manual-node/${id}`, { method: 'DELETE' }),
        errorFallback: 'Failed to delete node',
        successMessage: 'Node removed',
        onUnauthorized: () => {
          /* let the auth redirect handle it */
        }
      });
      const el = cyRef.current?.getElementById(id);
      el?.connectedEdges().remove();
      el?.remove();
      setSelected((cur) => (cur?.id === id ? null : cur));
    } catch (err) {
      handleActionError(err, 'Failed to delete node.');
    }
  }, []);

  // Publish the imperative edit API once it (or its dependencies) change, and
  // keep a ref for the stable cy tap handler's two-tap connect gesture.
  const onEditApiReadyRef = useRef(onEditApiReady);
  onEditApiReadyRef.current = onEditApiReady;
  connectNodesRef.current = connectNodes;
  editModeRef.current = editMode;
  useEffect(() => {
    onEditApiReadyRef.current?.({ connectNodes, selectElement: setSelected });
  }, [connectNodes]);

  // Reset the pending connect source + selection whenever edit mode is toggled.
  useEffect(() => {
    connectSourceRef.current = null;
    setSelected(null);
  }, [editMode]);

  const persistDrag = useCallback(
    async (
      nodeId: string,
      x: number,
      y: number,
      nodeType: 'discovered_asset' | 'manual_node'
    ) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const siteId = siteByNodeRef.current.get(nodeId);
    if (!siteId) return; // can't scope the upsert without a site
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/discovery/topology/layout', {
            method: 'PATCH',
            body: JSON.stringify({
              siteId,
              positions: [{ nodeType, nodeId, x, y }]
            })
          }),
        errorFallback: 'Failed to save node position',
        successMessage: 'Layout saved',
        onUnauthorized: () => {
          /* let the auth redirect handle it */
        }
      });
      placedRef.current.add(nodeId);
    } catch {
      // runAction already surfaced the error toast; nothing else to do here.
    }
    },
    []
  );

  // (Re)build the Cytoscape graph whenever the data changes.
  useEffect(() => {
    if (!mountRef.current) return;
    registerFcose();

    // Track which nodes have a saved position (consumed by preset; protected by
    // Auto-arrange).
    const layoutById = new Map<string, TopologyLayoutRow>();
    for (const row of layout) layoutById.set(row.nodeId, row);
    placedRef.current = new Set(layoutById.keys());

    // siteId lookup for drag persistence.
    const siteMap = new Map<string, string | undefined>();
    for (const n of nodes) siteMap.set(n.id, n.siteId);
    siteByNodeRef.current = siteMap;

    // Compound parents for subnet groups; child nodes reference their parent.
    const parentIds = new Set<string>();
    const elements: cytoscape.ElementDefinition[] = [];
    for (const group of subnetGroups) {
      if (group.nodes.length === 0) continue;
      const parentId = `group:${group.label}`;
      parentIds.add(parentId);
      elements.push({ data: { id: parentId, label: group.label } });
    }
    for (const node of nodes) {
      const subnet = subnetByNodeId.get(node.id);
      const parent = subnet ? `group:${subnet}` : undefined;
      const saved = layoutById.get(node.id);
      const data: Record<string, unknown> = {
        id: node.id,
        label: node.label,
        type: node.type,
        status: node.status,
        infra: INFRA_TYPES.has(node.type) ? 1 : 0,
        // Preserve provenance so a server-reloaded manual node is still
        // connect/delete-able (endpointFor + the tap handler key off data.kind).
        kind: node.kind ?? 'discovered'
      };
      if (parent && parentIds.has(parent)) data.parent = parent;
      const def: cytoscape.ElementDefinition = { data };
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        def.position = { x: saved.x, y: saved.y };
      }
      elements.push(def);
    }
    for (const link of links) {
      elements.push({
        data: {
          id: link.id,
          source: link.source,
          target: link.target,
          method: link.method ?? null,
          confidence: link.confidence ?? null,
          interfaceName: link.interfaceName ?? null,
          vlan: link.vlan ?? null
        }
      });
    }

    const cy = cytoscape({
      container: mountRef.current,
      elements,
      style: buildStylesheet(),
      // preset: consume saved positions; never auto-layout on every render.
      layout: { name: 'preset' },
      wheelSensitivity: 0.2
    });
    cyRef.current = cy;

    // The container may have been laid out (or resized from a hidden tab) after
    // cytoscape measured it; re-measure and frame the saved positions so nodes
    // are visible on first paint rather than parked off-screen.
    cy.resize();
    if (cy.elements().nonempty()) cy.fit(undefined, 30);

    cy.on('dragfree', 'node', (evt: cytoscape.EventObject) => {
      const target = evt.target as cytoscape.NodeSingular;
      const id = target.id();
      // Synthetic subnet-group compound parents (id 'group:<subnet>') are not
      // persistable nodes — skip them so the layout PATCH never 400s on a
      // non-asset/manual id with no site (#1728).
      if (id.startsWith('group:')) return;
      const pos = target.position();
      const nodeType: 'discovered_asset' | 'manual_node' =
        target.data('kind') === 'manual' ? 'manual_node' : 'discovered_asset';
      void persistDrag(id, pos.x, pos.y, nodeType);
    });

    cy.on('tap', 'node', (evt: cytoscape.EventObject) => {
      const node = evt.target as cytoscape.NodeSingular;
      const id = node.id();
      // In edit mode, taps drive a two-tap connect gesture: first tap selects the
      // source, second tap on a different node draws the manual edge. The first
      // tap also opens the inspector so a manual node can be deleted.
      if (editModeRef.current) {
        const source = connectSourceRef.current;
        if (!source) {
          connectSourceRef.current = id;
          setSelected({
            id,
            group: 'nodes',
            kind: node.data('kind') === 'manual' ? 'manual' : 'discovered'
          });
          return;
        }
        connectSourceRef.current = null;
        if (source !== id) void connectNodesRef.current?.(source, id);
        return;
      }
      // Only real discovered assets have an /discovery/assets/:id detail record.
      // Synthetic subnet-group parents (id 'group:...') and manual placeholder
      // nodes do not — firing the detail fetch for them 404s (#1728).
      if (id.startsWith('group:') || node.data('kind') === 'manual') return;
      const cb = onNodeClickRef.current;
      if (cb) cb(id);
    });

    // Tapping an edge opens the inspector: a manual edge can be deleted, a
    // measured edge shows read-only provenance.
    cy.on('tap', 'edge', (evt: cytoscape.EventObject) => {
      const edge = evt.target as cytoscape.EdgeSingular;
      setSelected({
        id: edge.id(),
        group: 'edges',
        method: (edge.data('method') as TopologyEdgeMethod | null) ?? null,
        confidence: (edge.data('confidence') as string | null) ?? null,
        interfaceName: (edge.data('interfaceName') as string | null) ?? null,
        vlan: (edge.data('vlan') as number | null) ?? null
      });
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, links, layout, subnetGroups, subnetByNodeId, persistDrag]);

  // Auto-arrange: lay out ONLY never-placed nodes; pinned/positioned nodes are
  // locked first so their saved positions are preserved.
  const autoArrange = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const placed = placedRef.current;
    const locked = cy.nodes().filter((n: cytoscape.NodeSingular) => placed.has(n.id()));
    locked.lock();
    const unplaced = cy.nodes().filter((n: cytoscape.NodeSingular) => !placed.has(n.id()));
    unplaced
      .layout({ name: 'fcose', animate: false, randomize: false } as cytoscape.LayoutOptions)
      .run();
    locked.unlock();
  }, []);

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
            Discovered assets grouped by subnet. Scroll to zoom, drag to pan or reposition nodes.
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
          {links.length > 0 && (
            <span data-testid="topology-provenance-legend" className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ backgroundColor: '#2563eb' }} />
              LLDP/CDP (measured)
            </span>
          )}
          <button
            type="button"
            data-testid="topology-auto-arrange"
            onClick={autoArrange}
            className="rounded-md border bg-muted/40 px-2.5 py-1 font-medium text-foreground hover:bg-muted"
          >
            Auto-arrange
          </button>
          {canEdit && (
            <button
              type="button"
              data-testid="topology-edit-toggle"
              onClick={() => setEditMode((v) => !v)}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              {editMode ? 'Done editing' : 'Edit map'}
            </button>
          )}
        </div>
      </div>

      {editMode && canEdit && (
        <div
          className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
          data-testid="topology-edit-palette"
        >
          <span className="text-xs font-medium text-muted-foreground">Add node:</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Add node">
            {MANUAL_ROLES.map((r) => (
              <button
                key={r}
                type="button"
                data-testid={`topology-add-node-${r}`}
                disabled={!activeSiteId}
                title={
                  activeSiteId
                    ? `Add a ${roleLabel(r)} placeholder`
                    : 'Select a single site to add manual nodes'
                }
                onClick={() => void addManualNode(r)}
                className="rounded border px-2 py-1 text-xs font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {roleLabel(r)}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <div
          className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2"
          data-testid="topology-inspector"
        >
          {selected.group === 'edges' && selected.method === 'manual' && editMode && (
            <button
              type="button"
              data-testid="topology-delete-edge"
              onClick={() => void deleteManualEdge(selected.id)}
              className="rounded border border-destructive/50 px-2 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/10"
            >
              Delete connection
            </button>
          )}
          {selected.group === 'edges' && selected.method !== 'manual' && (
            <p data-testid="topology-edge-provenance" className="text-xs text-muted-foreground">
              {(selected.method ?? 'unknown').toUpperCase()}
              {selected.confidence ? ` · ${selected.confidence}` : ''}
              {selected.interfaceName ? ` · ${selected.interfaceName}` : ''}
              {selected.vlan != null ? ` · VLAN ${selected.vlan}` : ''}
            </p>
          )}
          {selected.group === 'nodes' && selected.kind === 'manual' && editMode && (
            <button
              type="button"
              data-testid="topology-delete-node"
              onClick={() => void deleteManualNode(selected.id)}
              className="rounded border border-destructive/50 px-2 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/10"
            >
              Delete node
            </button>
          )}
        </div>
      )}

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
            Connection lines are shown only when real adjacency is measured (LLDP/CDP/SNMP). None has
            been collected yet, so assets are grouped by subnet without inferred links.
          </>
        ) : (
          <>Connection lines reflect measured adjacency.</>
        )}
      </div>

      <div
        ref={mountRef}
        data-testid="topology-cytoscape"
        className="relative mt-4 w-full overflow-hidden rounded-md border bg-muted/30"
        // Cytoscape requires a real pixel height on its container. An inline style
        // is used deliberately: the `u-h-px-*` utility classes are runtime-built
        // (`u-h-px-${n}`) and get purged from the production CSS, so a class-based
        // height collapses the canvas to 0 in prod (issue #1728).
        style={{ height: `${height}px` }}
      />

      {/* Subnet legend with host counts. */}
      {subnetGroups.length > 0 && (
        <div className="mt-4" data-testid="topology-subnet-legend">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Subnets</p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {subnetGroups.map((group: SubnetGroup<TopologyNode>) => (
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
            <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
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
