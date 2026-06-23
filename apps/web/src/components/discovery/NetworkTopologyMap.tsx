import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { LayoutGrid, Pencil, Check, ArrowRight, X, Network } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '../../lib/permissions';
import { runAction, handleActionError } from '@/lib/runAction';
import { cn } from '@/lib/utils';
import {
  groupNodesBySubnet,
  parseProfileSubnets,
  UNGROUPED_LABEL,
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
  // Node-only descriptors, surfaced in the inspector so a tap always reveals
  // something about the device even when the full asset record can't be loaded.
  label?: string | null;
  nodeType?: TopologyNodeType | null;
  status?: TopologyNodeStatus | null;
  ipAddress?: string | null;
  subnet?: string | null;
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

const statusLabel: Record<TopologyNodeStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  warning: 'Warning'
};

// Edge provenance presentation: matches the canvas line colors so the inspector
// and the legend speak the same visual language.
const EDGE_METHOD_META: Record<TopologyEdgeMethod, { label: string; color: string }> = {
  lldp: { label: 'LLDP', color: '#2563eb' },
  cdp: { label: 'CDP', color: '#2563eb' },
  fdb: { label: 'Bridge FDB', color: '#16a34a' },
  manual: { label: 'Manual', color: '#f97316' }
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

// Node fill palette. Harmonised around the app's slate-blue primary: each type
// gets a distinct, evenly-saturated hue so the canvas reads as one family rather
// than a bag of random colors. Workstation is a readable slate (a near-black
// blob reads as a hole on the map); printer warms to amber; switch carries the
// brand blue since switches are the most common infra node.
const typeColors: Record<TopologyNodeType, string> = {
  router: '#0d9488', // teal — gateway/edge
  switch: '#3b56c4', // brand slate-blue
  server: '#7c3aed', // violet
  workstation: '#475569', // slate
  printer: '#d97706', // amber
  firewall: '#dc2626', // red
  access_point: '#0891b2', // cyan
  device: '#64748b', // muted slate
  unknown: '#94a3b8' // light slate
};

const statusStroke: Record<TopologyNodeStatus, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  warning: '#f59e0b'
};

// Stroke-based device glyphs (lucide geometry, 24×24 viewBox) rendered as the
// white icon centred inside each node tile. Keyed by node type.
const ICON_PATHS: Record<TopologyNodeType, string> = {
  router:
    '<rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6.01 18H6"/><path d="M10.01 18H10"/><path d="M15 10v4"/><path d="M17.84 7.17a4 4 0 0 0-5.66 0"/><path d="M20.66 4.34a8 8 0 0 0-11.31 0"/>',
  switch:
    '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  server:
    '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  workstation:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  printer:
    '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  firewall:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  access_point:
    '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>',
  device:
    '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  unknown:
    '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'
};

// A device glyph as a data-URI SVG, stroked in `color` (white on the tile fill).
function nodeIconUri(type: TopologyNodeType, color = '#ffffff'): string {
  const body = ICON_PATHS[type] ?? ICON_PATHS.unknown;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// A small status pip (filled disc + white ring) badged on the node's lower-right.
function statusDotUri(status: TopologyNodeStatus): string {
  const fill = statusStroke[status] ?? statusStroke.online;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12">` +
    `<circle cx="6" cy="6" r="5" fill="${fill}" stroke="#ffffff" stroke-width="2"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// The device tile reused outside the canvas (inspector / legend): the glyph on a
// type-coloured square, mirroring how the node renders on the map.
function NodeBadge({ type, size = 30 }: { type: TopologyNodeType; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md shadow-sm"
      style={{ width: size, height: size, backgroundColor: typeColors[type] ?? typeColors.unknown }}
    >
      <img src={nodeIconUri(type)} alt="" width={Math.round(size * 0.6)} height={Math.round(size * 0.6)} />
    </span>
  );
}

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

// Canvas colours that must track the app theme. The Cytoscape stylesheet renders
// to <canvas>, so it can't consume CSS custom properties the way the DOM chrome
// does — we resolve the relevant design tokens at build time and rebuild the
// stylesheet when the theme flips (#1728 critique: dark-mode parity).
type TopologyTheme = {
  surface: string; // --card: node border halo + label chip + subnet label chip
  ink: string; // --foreground: node + subnet labels
  border: string; // --border: subnet box outline + hover ring
  muted: string; // --muted-foreground: subnet box fill + label
  primary: string; // --primary: selection ring + halo
};

// Light-mode fallbacks (also used for SSR / jsdom where getComputedStyle is empty).
const DEFAULT_TOPOLOGY_THEME: TopologyTheme = {
  surface: '#ffffff',
  ink: '#1e293b',
  border: '#cbd5e1',
  muted: '#64748b',
  primary: '#3b56c4'
};

function readTopologyTheme(): TopologyTheme {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return DEFAULT_TOPOLOGY_THEME;
  }
  const cs = getComputedStyle(document.documentElement);
  // Tokens are stored as space-separated HSL channels ("220 20% 99%"); Cytoscape's
  // colour parser wants the comma form, so normalise it.
  const token = (name: string, fallback: string): string => {
    const raw = cs.getPropertyValue(name).trim();
    const parts = raw.split(/\s+/);
    return parts.length === 3 ? `hsl(${parts[0]}, ${parts[1]}, ${parts[2]})` : fallback;
  };
  return {
    surface: token('--card', DEFAULT_TOPOLOGY_THEME.surface),
    ink: token('--foreground', DEFAULT_TOPOLOGY_THEME.ink),
    border: token('--border', DEFAULT_TOPOLOGY_THEME.border),
    muted: token('--muted-foreground', DEFAULT_TOPOLOGY_THEME.muted),
    primary: token('--primary', DEFAULT_TOPOLOGY_THEME.primary)
  };
}

/**
 * Cytoscape stylesheet. Node styling keys off `data(infra)`/`data(status)`;
 * edges color by measured provenance (`data(method)`):
 *   lldp/cdp (high)   → solid blue   (#2563eb)
 *   fdb (medium)      → solid green  (#16a34a)
 *   manual (asserted) → dashed orange(#f97316)  (ships now, used in Phase 4)
 * Theme-dependent neutrals (node border, labels, subnet box) come from `theme`
 * so the canvas tracks light/dark; semantic hues (type fills, provenance edge
 * colours, status pips, amber connect-source) are fixed and read on both.
 */
function buildStylesheet(theme: TopologyTheme): cytoscape.StylesheetStyle[] {
  const nodeType = (ele: cytoscape.NodeSingular) =>
    (ele.data('type') as TopologyNodeType) ?? 'unknown';
  const nodeStatus = (ele: cytoscape.NodeSingular) =>
    (ele.data('status') as TopologyNodeStatus) ?? 'online';

  return [
    {
      // Device tile: type-colour fill, white glyph centred, status pip badged on
      // the lower-right, hairline white border so it reads as a sticker on the
      // canvas. Width/height/border animate for hover & selection feedback.
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        'background-color': (ele: cytoscape.NodeSingular) =>
          typeColors[nodeType(ele)] ?? typeColors.unknown,
        'background-image': (ele: cytoscape.NodeSingular) => [
          nodeIconUri(nodeType(ele)),
          statusDotUri(nodeStatus(ele))
        ],
        'background-width': ['62%', '38%'],
        'background-height': ['62%', '38%'],
        'background-position-x': ['50%', '92%'],
        'background-position-y': ['50%', '92%'],
        'background-clip': ['none', 'none'],
        'background-image-containment': 'over',
        'bounds-expansion': 6,
        'border-color': theme.surface,
        'border-width': 2,
        'border-opacity': 0.95,
        label: 'data(label)',
        color: theme.ink,
        'font-size': 11,
        'font-weight': 600,
        'text-valign': 'bottom',
        'text-margin-y': 6,
        'text-background-color': theme.surface,
        'text-background-opacity': 0.82,
        'text-background-padding': 3,
        'text-background-shape': 'round-rectangle',
        'min-zoomed-font-size': 7,
        width: 34,
        height: 34,
        'transition-property': 'width height border-width border-color opacity',
        'transition-duration': '140ms',
        'transition-timing-function': 'ease-out'
      } as unknown as cytoscape.Css.Node
    },
    {
      // Infrastructure (router/switch/firewall/AP): larger, anchors the subnet.
      selector: 'node[?infra]',
      style: {
        width: 50,
        height: 50,
        'border-width': 2.5
      } as cytoscape.Css.Node
    },
    {
      // Subnet compound group: soft tinted card with a top-left label chip.
      selector: '$node > node',
      style: {
        shape: 'round-rectangle',
        'background-color': theme.muted,
        'background-opacity': 0.05,
        'background-image': 'none',
        'border-width': 1,
        'border-color': theme.border,
        'border-opacity': 0.9,
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -6,
        'font-size': 11,
        'font-weight': 600,
        color: theme.muted,
        'text-background-color': theme.surface,
        'text-background-opacity': 0.9,
        'text-background-padding': 4,
        'text-background-shape': 'round-rectangle',
        padding: 22
      } as unknown as cytoscape.Css.Node
    },
    {
      selector: 'edge',
      style: {
        width: 2.5,
        'line-color': '#94a3b8',
        'curve-style': 'bezier',
        'line-cap': 'round',
        'transition-property': 'width line-color opacity',
        'transition-duration': '140ms',
        'transition-timing-function': 'ease-out'
      } as unknown as cytoscape.Css.Edge
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
    },
    // ── Interaction states ────────────────────────────────────────────────
    {
      // Hover: lift the tile and thicken its ring; cursor handled in JS.
      selector: 'node.tp-hover',
      style: {
        'border-color': theme.border,
        'border-width': 4,
        'border-opacity': 1,
        'z-index': 20
      } as cytoscape.Css.Node
    },
    {
      // Selection: brand-blue ring + halo, raised above neighbours.
      selector: 'node.tp-selected',
      style: {
        'border-color': theme.primary,
        'border-width': 4,
        'border-opacity': 1,
        'overlay-color': theme.primary,
        'overlay-opacity': 0.14,
        'overlay-padding': 7,
        'z-index': 30
      } as cytoscape.Css.Node
    },
    {
      // Connect-gesture source (edit mode): dashed amber ring while awaiting the
      // second tap.
      selector: 'node.tp-connect-source',
      style: {
        'border-color': '#f59e0b',
        'border-width': 4,
        'border-opacity': 1,
        'overlay-color': '#f59e0b',
        'overlay-opacity': 0.16,
        'overlay-padding': 7,
        'z-index': 30
      } as cytoscape.Css.Node
    },
    {
      // Dimmed: everything not adjacent to the selection recedes.
      selector: '.tp-dim',
      style: { opacity: 0.25 } as cytoscape.Css.Node
    },
    {
      selector: 'edge.tp-hover, edge.tp-selected',
      style: { width: 4.5, 'z-index': 25 } as cytoscape.Css.Edge
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
  // Canvas pixel height, recomputed to fit the viewport so the map's header and
  // the legends below it stay visible without scrolling the card (#1728).
  const [canvasHeight, setCanvasHeight] = useState(height);
  // Inline two-step delete confirm (#1728 critique): the first click on a delete
  // button arms it ("Confirm delete?"), the second performs the irreversible
  // action. Auto-disarms after 3s so a stray first click can't linger.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  // siteId per node, so a drag can persist the dragged node's own site.
  const siteByNodeRef = useRef<Map<string, string | undefined>>(new Map());
  // node ids that already have a saved (placed) position — Auto-arrange must not
  // disturb these.
  const placedRef = useRef<Set<string>>(new Set());
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
      // The "Ungrouped" bucket is not a real subnet — don't box those nodes in a
      // compound parent (it produced a large overlapping container) and don't
      // claim a subnet for them in the inspector.
      if (group.label === UNGROUPED_LABEL) continue;
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

  // Device-type legend only lists the types actually present on the map.
  const presentTypes = useMemo(
    () => (Object.keys(typeColors) as TopologyNodeType[]).filter((t) => nodes.some((n) => n.type === t)),
    [nodes]
  );

  // Select a node from outside the canvas (the accessible device list / keyboard
  // path). Mirrors a canvas tap: opens the inspector and drives the same
  // selection-highlight effect, so keyboard + screen-reader users can reach every
  // device without a pointer — the <canvas> itself isn't focusable (#1728 P0).
  const selectNodeById = useCallback(
    (node: TopologyNode) => {
      setSelected({
        id: node.id,
        group: 'nodes',
        kind: node.kind === 'manual' ? 'manual' : 'discovered',
        label: node.label,
        nodeType: node.type,
        status: node.status,
        ipAddress: node.ipAddress ?? null,
        subnet: subnetByNodeId.get(node.id) ?? null
      });
    },
    [subnetByNodeId]
  );

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

  // Arm the inline delete confirm; auto-disarm after 3s.
  const armDelete = useCallback(() => {
    setConfirmDelete(true);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmDelete(false), 3000);
  }, []);

  // A new selection (or a cleared one) always starts disarmed.
  useEffect(() => {
    setConfirmDelete(false);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, [selected]);

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
      if (group.label === UNGROUPED_LABEL) continue; // no compound box for the catch-all bucket
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
        ipAddress: node.ipAddress ?? null,
        subnet: subnet ?? null,
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
      style: buildStylesheet(readTopologyTheme()),
      // preset: consume saved positions; never auto-layout on every render.
      layout: { name: 'preset' },
      wheelSensitivity: 0.2,
      // Static in view mode; pan/zoom/drag unlock only in edit mode (#1728). The
      // editMode effect keeps these in sync on toggle.
      userPanningEnabled: editModeRef.current,
      userZoomingEnabled: editModeRef.current,
      autoungrabify: !editModeRef.current,
      boxSelectionEnabled: false
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

    // Build the inspector descriptor for a node tap (label/type/status/ip), so a
    // tap always surfaces the device's basics even before/without the full asset
    // record.
    const nodeSelection = (node: cytoscape.NodeSingular): SelectedElement => ({
      id: node.id(),
      group: 'nodes',
      kind: node.data('kind') === 'manual' ? 'manual' : 'discovered',
      label: (node.data('label') as string | null) ?? null,
      nodeType: (node.data('type') as TopologyNodeType | null) ?? null,
      status: (node.data('status') as TopologyNodeStatus | null) ?? null,
      ipAddress: (node.data('ipAddress') as string | null) ?? null,
      subnet: (node.data('subnet') as string | null) ?? null
    });

    cy.on('tap', 'node', (evt: cytoscape.EventObject) => {
      const node = evt.target as cytoscape.NodeSingular;
      const id = node.id();
      // Subnet-group compound parents are not selectable devices.
      if (id.startsWith('group:')) {
        setSelected(null);
        return;
      }
      // In edit mode, taps drive a two-tap connect gesture: first tap selects the
      // source, second tap on a different node draws the manual edge. The first
      // tap also opens the inspector so a manual node can be deleted.
      if (editModeRef.current) {
        const source = connectSourceRef.current;
        if (!source) {
          connectSourceRef.current = id;
          setSelected(nodeSelection(node));
          return;
        }
        connectSourceRef.current = null;
        if (source !== id) void connectNodesRef.current?.(source, id);
        return;
      }
      // A tap only *selects* the node (opens the inspector). Opening the full
      // asset detail is a deliberate second step via the inspector's "View
      // details" button (#1728) — a single tap must never navigate away.
      setSelected(nodeSelection(node));
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

    // Tapping empty canvas clears the selection.
    cy.on('tap', (evt: cytoscape.EventObject) => {
      if (evt.target === cy) setSelected(null);
    });

    // Hover affordance: lift the element and switch the cursor to a pointer.
    const container = cy.container();
    cy.on('mouseover', 'node, edge', (evt: cytoscape.EventObject) => {
      const ele = evt.target as cytoscape.SingularElementArgument;
      if (ele.isNode() && ele.id().startsWith('group:')) return;
      ele.addClass('tp-hover');
      if (container) container.style.cursor = 'pointer';
    });
    cy.on('mouseout', 'node, edge', (evt: cytoscape.EventObject) => {
      (evt.target as cytoscape.SingularElementArgument).removeClass('tp-hover');
      if (container) container.style.cursor = 'default';
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, links, layout, subnetGroups, subnetByNodeId, persistDrag]);

  // Selection highlight: ring the selected element and fade everything outside
  // its neighbourhood so the focus reads instantly. In edit mode a selected node
  // is the pending connect source (amber) rather than a plain selection.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('tp-selected tp-dim tp-connect-source');
      if (!selected) return;
      const el = cy.getElementById(selected.id);
      if (el.empty()) return;
      if (selected.group === 'nodes') {
        cy.elements().not(el.closedNeighborhood()).addClass('tp-dim');
        el.addClass(editMode ? 'tp-connect-source' : 'tp-selected');
      } else {
        const focus = el.union(el.connectedNodes());
        cy.elements().not(focus).addClass('tp-dim');
        el.addClass('tp-selected');
      }
    });
  }, [selected, editMode, nodes, links]);

  // Edit-only interactivity (#1728): in view mode the map is a static diagram —
  // no pan, no scroll-zoom, no node dragging. Edit mode unlocks all three. The
  // same flags are set at cy-creation from editModeRef so a data-driven rebuild
  // preserves the current mode.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.userPanningEnabled(editMode);
    cy.userZoomingEnabled(editMode);
    cy.autoungrabify(!editMode);
  }, [editMode]);

  // Rebuild the canvas stylesheet from the resolved design tokens whenever the
  // theme flips (the `dark` class toggles on <html>), so the graph tracks
  // light/dark instead of staying a light island in a dark shell (#1728).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const apply = () => cyRef.current?.style(buildStylesheet(readTopologyTheme()));
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Fit the canvas height to the viewport so the legends below the map stay
  // visible without scrolling the card off-screen. The chrome above the canvas
  // (mountTop) and the intrinsic height of the content below it are both
  // independent of the canvas height, so this converges in a single pass.
  // Re-runs when surrounding chrome changes (inspector/palette) or on resize.
  useLayoutEffect(() => {
    const recompute = () => {
      const mount = mountRef.current;
      const card = cardRef.current;
      if (!mount || !card) return;
      const mountRect = mount.getBoundingClientRect();
      const below = card.getBoundingClientRect().bottom - mountRect.bottom;
      const available = window.innerHeight - mountRect.top - below - 24;
      setCanvasHeight(Math.max(320, Math.min(height, Math.round(available))));
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [height, editMode, selected, subnetGroups, presentTypes, links.length, nodes.length, loading]);

  // Cytoscape must be told when its container resizes; re-fit in view mode (in
  // edit mode the user may have panned/zoomed, so preserve their viewport).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.resize();
    if (!editModeRef.current && cy.elements().nonempty()) cy.fit(undefined, 30);
  }, [canvasHeight]);

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
    <div ref={cardRef} className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Network Topology</h2>
          <p className="text-sm text-muted-foreground">
            {editMode
              ? 'Drag nodes to arrange, scroll to zoom. Tap two nodes to link them.'
              : 'Discovered assets grouped by subnet. Tap a node or link to inspect it.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editMode && (
            <button
              type="button"
              data-testid="topology-auto-arrange"
              onClick={autoArrange}
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted active:scale-[0.98]"
            >
              <LayoutGrid className="h-4 w-4 text-muted-foreground" aria-hidden />
              Auto-arrange
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              data-testid="topology-edit-toggle"
              aria-pressed={editMode}
              onClick={() => setEditMode((v) => !v)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm transition active:scale-[0.98]',
                editMode
                  ? 'bg-foreground text-background hover:opacity-90'
                  : 'bg-primary text-primary-foreground hover:opacity-90'
              )}
            >
              {editMode ? <Check className="h-4 w-4" aria-hidden /> : <Pencil className="h-4 w-4" aria-hidden />}
              {editMode ? 'Done editing' : 'Edit map'}
            </button>
          )}
        </div>
      </div>

      {/* Compact legend bar: device status + measured-vs-manual link provenance. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {(['online', 'warning', 'offline'] as TopologyNodeStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-full ring-2 ring-background', statusDotClass[s])} />
            {statusLabel[s]}
          </span>
        ))}
        {links.length > 0 && (
          <span data-testid="topology-provenance-legend" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="hidden text-muted-foreground/50 sm:inline">·</span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[3px] w-5 rounded-full" style={{ backgroundColor: '#2563eb' }} />
              LLDP/CDP
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[3px] w-5 rounded-full" style={{ backgroundColor: '#16a34a' }} />
              Bridge FDB
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-[3px] w-5 rounded-full"
                style={{ backgroundImage: 'repeating-linear-gradient(to right, #f97316 0 4px, transparent 4px 7px)' }}
              />
              Manual
            </span>
          </span>
        )}
      </div>

      {editMode && canEdit && (
        <div
          className="animate-in mt-4 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/[0.04] px-3 py-2"
          data-testid="topology-edit-palette"
        >
          <span className="text-xs font-semibold text-muted-foreground">Add node:</span>
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
          className="animate-in mt-4 flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2.5 shadow-sm"
          data-testid="topology-inspector"
        >
          {selected.group === 'nodes' && (
            <>
              <NodeBadge type={selected.nodeType ?? 'unknown'} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {selected.label || 'Device'}
                  </span>
                  {selected.status && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <span className={cn('h-1.5 w-1.5 rounded-full', statusDotClass[selected.status])} />
                      {statusLabel[selected.status]}
                    </span>
                  )}
                  {selected.kind === 'manual' && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Manual
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{typeLabels[selected.nodeType ?? 'unknown']}</span>
                  {selected.ipAddress && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="font-mono">{selected.ipAddress}</span>
                    </>
                  )}
                  {selected.subnet && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span>{selected.subnet}</span>
                    </>
                  )}
                </div>
              </div>
              {selected.kind !== 'manual' && onNodeClick && (
                <button
                  type="button"
                  data-testid="topology-inspector-view-details"
                  onClick={() => onNodeClick(selected.id)}
                  className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted active:scale-[0.98]"
                >
                  View details
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
              {selected.kind === 'manual' && editMode && (
                <button
                  type="button"
                  data-testid="topology-delete-node"
                  aria-label={confirmDelete ? 'Confirm delete node' : 'Delete node'}
                  onClick={() => (confirmDelete ? void deleteManualNode(selected.id) : armDelete())}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                    confirmDelete
                      ? 'bg-destructive text-destructive-foreground hover:opacity-90'
                      : 'border border-destructive/50 text-destructive hover:bg-destructive/10'
                  )}
                >
                  {confirmDelete ? 'Confirm delete?' : 'Delete node'}
                </button>
              )}
            </>
          )}

          {selected.group === 'edges' && (
            <>
              <span
                className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md text-white shadow-sm"
                style={{ backgroundColor: EDGE_METHOD_META[selected.method ?? 'manual']?.color ?? '#64748b' }}
              >
                <Network className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">Connection</span>
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
                    style={{ backgroundColor: EDGE_METHOD_META[selected.method ?? 'manual']?.color ?? '#64748b' }}
                  >
                    {EDGE_METHOD_META[selected.method ?? 'manual']?.label ?? 'Unknown'}
                  </span>
                  {selected.method === 'manual' ? (
                    <span className="text-xs text-muted-foreground">Hand-mapped</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Measured adjacency</span>
                  )}
                </div>
                <div
                  data-testid="topology-edge-provenance"
                  className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
                >
                  {selected.confidence && <span className="capitalize">{selected.confidence} confidence</span>}
                  {selected.interfaceName && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="font-mono">{selected.interfaceName}</span>
                    </>
                  )}
                  {selected.vlan != null && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span>VLAN {selected.vlan}</span>
                    </>
                  )}
                </div>
              </div>
              {selected.method === 'manual' && editMode && (
                <button
                  type="button"
                  data-testid="topology-delete-edge"
                  aria-label={confirmDelete ? 'Confirm delete connection' : 'Delete connection'}
                  onClick={() => (confirmDelete ? void deleteManualEdge(selected.id) : armDelete())}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                    confirmDelete
                      ? 'bg-destructive text-destructive-foreground hover:opacity-90'
                      : 'border border-destructive/50 text-destructive hover:bg-destructive/10'
                  )}
                >
                  {confirmDelete ? 'Confirm delete?' : 'Delete connection'}
                </button>
              )}
              {selected.method !== 'manual' && editMode && (
                <span
                  data-testid="topology-edge-locked-note"
                  className="text-xs italic text-muted-foreground"
                >
                  Measured by scan — not editable
                </span>
              )}
            </>
          )}

          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => setSelected(null)}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground sm:ml-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      {error && nodes.length > 0 && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Honesty note: we only draw connections we actually observed. Shown only
          when nothing has been measured yet — once links exist the legend carries
          the provenance and the note is just noise. */}
      {links.length === 0 && nodes.length > 0 && (
        <div
          data-testid="topology-adjacency-note"
          className="mt-4 rounded-md border border-info/30 bg-info/[0.06] px-3 py-2 text-xs text-info"
        >
          Connection lines appear only where real adjacency is measured (LLDP/CDP/SNMP). None has
          been collected yet, so assets are grouped by subnet without inferred links.
        </div>
      )}

      <div
        ref={mountRef}
        data-testid="topology-cytoscape"
        role="img"
        aria-label={
          nodes.length > 0
            ? `Network topology map: ${nodes.length} device${nodes.length === 1 ? '' : 's'}. Use the device list below to inspect each device with the keyboard.`
            : 'Network topology map: no devices discovered yet.'
        }
        className="relative mt-4 w-full overflow-hidden rounded-md border bg-muted/30 [background-image:radial-gradient(hsl(var(--border))_1px,transparent_0)] [background-size:22px_22px]"
        // Cytoscape requires a real pixel height on its container. An inline style
        // is used deliberately: the `u-h-px-*` utility classes are runtime-built
        // (`u-h-px-${n}`) and get purged from the production CSS, so a class-based
        // height collapses the canvas to 0 in prod (issue #1728). The value is
        // viewport-fitted (see the recompute effect) so the legends stay visible.
        style={{ height: `${canvasHeight}px` }}
      >
        {nodes.length === 0 && !loading && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl border bg-card text-muted-foreground/70 shadow-sm">
              <Network className="h-6 w-6" aria-hidden />
            </span>
            <p className="text-sm font-medium text-foreground">No assets discovered yet</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Run a network discovery scan to populate the topology map.
            </p>
          </div>
        )}
      </div>

      {/* Accessible device list (#1728 P0): a keyboard-focusable, screen-reader
          enumerable route to every node, since the Cytoscape <canvas> exposes no
          DOM. Selecting a row drives the same inspector + canvas highlight as a
          tap. Collapsed by default to stay out of the sighted/mouse user's way. */}
      {nodes.length > 0 && (
        <details className="mt-4 rounded-md border bg-card" data-testid="topology-device-list">
          <summary className="cursor-pointer select-none rounded-md px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:text-foreground">
            All devices ({nodes.length})
          </summary>
          <ul className="max-h-64 overflow-auto border-t p-1.5" role="list">
            {nodes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  data-testid={`topology-device-row-${n.id}`}
                  aria-pressed={selected?.id === n.id}
                  onClick={() => selectNodeById(n)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-xs transition hover:bg-muted',
                    selected?.id === n.id && 'bg-muted'
                  )}
                >
                  <NodeBadge type={n.type} size={20} />
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{n.label}</span>
                  <span className="hidden items-center gap-1 text-muted-foreground sm:inline-flex">
                    <span className={cn('h-1.5 w-1.5 rounded-full', statusDotClass[n.status])} aria-hidden />
                    {statusLabel[n.status]}
                  </span>
                  <span className="text-muted-foreground">{typeLabels[n.type]}</span>
                  {n.ipAddress && (
                    <span className="hidden font-mono text-muted-foreground md:inline">{n.ipAddress}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Subnet legend with host counts. */}
      {subnetGroups.length > 0 && (
        <div className="mt-4" data-testid="topology-subnet-legend">
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">Subnets</p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {subnetGroups.map((group: SubnetGroup<TopologyNode>) => (
              <span
                key={group.label}
                className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 shadow-sm"
              >
                <span className="font-medium text-foreground">{group.label}</span>
                <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold text-foreground">
                  {group.nodes.length}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Device-type legend — only the types actually on the map, with their glyphs. */}
      {presentTypes.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4 text-xs text-muted-foreground">
          {presentTypes.map((type) => (
            <span key={type} className="flex items-center gap-1.5">
              <NodeBadge type={type} size={18} />
              {typeLabels[type] ?? type}
            </span>
          ))}
          {onNodeClick && (
            <span className="ml-auto text-muted-foreground">Click a node to inspect</span>
          )}
        </div>
      )}
    </div>
  );
}
