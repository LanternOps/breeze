import type { RenderNode } from './renderProjection';
import type { TopologyGlyph } from './topologyGlyphs';

/**
 * Role sections inside a grouped-overview card (topology overview refinement, 2026-10-03).
 * The order is fixed so every card reads the same way: what carries the network first,
 * then the machines people log on to, then what hangs off them.
 */
export const SECTION_ORDER = ['network', 'servers', 'computers', 'phones', 'printers', 'other'] as const;
export type TopologySection = typeof SECTION_ORDER[number];

const GLYPH_SECTION: Partial<Record<TopologyGlyph, TopologySection>> = {
  router: 'network', firewall: 'network', switch: 'network', access_point: 'network',
  server: 'servers', nas: 'servers', workstation: 'computers', laptop: 'computers', phone: 'phones', printer: 'printers',
};
export const sectionOf = (glyph: TopologyGlyph): TopologySection => GLYPH_SECTION[glyph] ?? 'other';
export const sectionIndex = (glyph: TopologyGlyph) => SECTION_ORDER.indexOf(sectionOf(glyph));

/** Within a section: routers and firewalls before switches and APs, cameras/IoT before unknowns; unverified placements last. */
const GLYPH_RANK: Partial<Record<TopologyGlyph, number>> = { router: 0, firewall: 0, switch: 1, access_point: 1, server: 2, nas: 2, workstation: 3, laptop: 3, printer: 4, phone: 5, camera: 6, iot: 6 };
export const memberRank = (node: Pick<RenderNode, 'glyph' | 'unverified'>) => {
  const rank = GLYPH_RANK[node.glyph] ?? 7;
  return rank + (node.unverified && rank > 1 ? 10 : 0);
};

/**
 * Vertical band the card grid reserves above each section's first row for its header
 * (layoutAdapter.packCard). The header sits close to the rows it labels: the band plus the
 * normal row gap separates it from the section above.
 */
export const SECTION_BAND = 28;
export const SECTION_HEADER_HEIGHT = 18;
/** Gap between a header's bottom edge and the top of its section's first row. */
const HEADER_TO_ROW = 5;

export type CardSummary = { total: number; sections: { section: TopologySection; count: number }[]; agentsOnline: number; agentsOffline: number };

/** Per-card role counts and agent presence, from the members already in the render (no server data needed). */
export function cardSummaries(nodes: readonly RenderNode[]): Map<string, CardSummary> {
  const counts = new Map<string, { total: number; bySection: Map<TopologySection, number>; online: number; offline: number }>();
  for (const node of nodes) {
    if (!node.parent) continue;
    const entry = counts.get(node.parent) ?? { total: 0, bySection: new Map(), online: 0, offline: 0 };
    const section = sectionOf(node.glyph);
    entry.total++; entry.bySection.set(section, (entry.bySection.get(section) ?? 0) + 1);
    // Agent presence only: a scan answer is not an agent heartbeat, and neither is health.
    if (node.agentPresence === 'online') entry.online++;
    if (node.agentPresence === 'offline') entry.offline++;
    counts.set(node.parent, entry);
  }
  return new Map([...counts].map(([card, entry]) => [card, {
    total: entry.total, agentsOnline: entry.online, agentsOffline: entry.offline,
    sections: SECTION_ORDER.filter((section) => entry.bySection.has(section)).map((section) => ({ section, count: entry.bySection.get(section)! })),
  }]));
}

export type PlacedMember = Pick<RenderNode, 'id' | 'glyph' | 'parent'> & { x: number; y: number; width: number; height: number };
export type SectionHeader = { id: string; parent: string; section: TopologySection; count: number; x: number; y: number; width: number; height: number };

/**
 * Header positions derived from the packed member positions: one per section, spanning the
 * card's member columns, centred in the band the layout reserved above the section. A card with a
 * single section gets none (the layout reserves no band for it either).
 */
export function sectionHeaders(members: readonly PlacedMember[]): SectionHeader[] {
  const cards = new Map<string, PlacedMember[]>();
  for (const member of members) if (member.parent) cards.set(member.parent, [...(cards.get(member.parent) ?? []), member]);
  const headers: SectionHeader[] = [];
  for (const [parent, tiles] of [...cards].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const bySection = new Map<TopologySection, PlacedMember[]>();
    for (const tile of tiles) { const section = sectionOf(tile.glyph); bySection.set(section, [...(bySection.get(section) ?? []), tile]); }
    if (bySection.size < 2) continue;
    const x1 = Math.min(...tiles.map((t) => t.x - t.width / 2)), x2 = Math.max(...tiles.map((t) => t.x + t.width / 2));
    for (const section of SECTION_ORDER) {
      const rows = bySection.get(section);
      if (!rows) continue;
      const top = Math.min(...rows.map((t) => t.y - t.height / 2));
      headers.push({ id: `section:${parent}:${section}`, parent, section, count: rows.length, x: (x1 + x2) / 2, y: top - HEADER_TO_ROW - SECTION_HEADER_HEIGHT / 2,
        width: x2 - x1, height: SECTION_HEADER_HEIGHT });
    }
  }
  return headers;
}

/** Whether a card's members span more than one section (the layout reserves header bands only then). */
export const hasSections = (sections: Iterable<number | undefined>) => new Set([...sections].filter((s) => s !== undefined)).size > 1;
