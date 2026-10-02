import type { GraphNode } from '@breeze/shared';

/** Device glyphs drawn on topology tiles (lucide geometry, 24×24 viewBox). */
export type TopologyGlyph = 'router' | 'switch' | 'firewall' | 'access_point' | 'server' | 'workstation' | 'laptop' | 'printer'
  | 'phone' | 'camera' | 'nas' | 'iot' | 'internet' | 'network' | 'device';

const PATHS: Record<TopologyGlyph, string> = {
  router: '<rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6.01 18H6"/><path d="M10.01 18H10"/><path d="M15 10v4"/><path d="M17.84 7.17a4 4 0 0 0-5.66 0"/><path d="M20.66 4.34a8 8 0 0 0-11.31 0"/>',
  switch: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  firewall: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  access_point: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  workstation: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  nas: '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  iot: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  internet: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  device: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
};

/**
 * Categorical glyph tile colours (one hue per device family, matching the legacy
 * discovery map so the two maps read as one product). Category, not status:
 * red/amber/green on the canvas are reserved for measured health (design §153).
 */
const TILE: Record<TopologyGlyph, string> = {
  router: '#0d9488', switch: '#3b56c4', firewall: '#be123c', access_point: '#0891b2', server: '#7c3aed', workstation: '#475569',
  laptop: '#475569', printer: '#b45309', phone: '#4f46e5', camera: '#9333ea', nas: '#6d28d9', iot: '#0f766e', internet: '#2563eb', network: '#3b56c4', device: '#64748b',
};

const ALIASES: Record<string, TopologyGlyph> = {
  router: 'router', gateway: 'router', switch: 'switch', firewall: 'firewall', access_point: 'access_point', ap: 'access_point', wifi: 'access_point',
  server: 'server', domain_controller: 'server', hypervisor: 'server', workstation: 'workstation', desktop: 'workstation', laptop: 'laptop',
  printer: 'printer', phone: 'phone', voip: 'phone', mobile: 'phone', camera: 'camera', nas: 'nas', storage: 'nas', iot: 'iot',
};

export function topologyGlyph(node: Pick<GraphNode, 'kind' | 'role'> & { inventory?: GraphNode['inventory'] }): TopologyGlyph {
  if (node.kind === 'gateway') return 'router';
  if (node.kind === 'internet') return 'internet';
  if (node.kind === 'network') return 'network';
  const role = node.role?.toLowerCase();
  const type = node.inventory?.type?.toLowerCase();
  return (role && ALIASES[role]) || (type && ALIASES[type]) || 'device';
}

/** Glyph on its category tile, as a data-URI SVG (CSP allows `img-src data:`). */
export function glyphTileUri(glyph: TopologyGlyph): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="9" fill="${TILE[glyph]}"/>`
    + `<g transform="translate(7 7) scale(0.9167)" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[glyph]}</g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Infrastructure that can sensibly carry port measurement (SNMP) in the inspector. */
export const INFRASTRUCTURE_GLYPHS: ReadonlySet<TopologyGlyph> = new Set(['router', 'switch', 'firewall', 'access_point']);
