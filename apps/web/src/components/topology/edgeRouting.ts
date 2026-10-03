import type { RenderEdge, RenderEdgeStyle } from './renderProjection';

/**
 * What the canvas draws for the render's edges (topology overview refinement, 2026-10-03).
 * An edge never runs across a card's tiles: an endpoint inside a card is drawn at the card
 * itself, so the line ends at the card border, and the member it belongs to is named at that end.
 * Several such edges between the same card and node (and of the same style) become one bundle
 * labelled with their count. An edge whose two ends share a card is not drawn: the card already
 * says they are together. Canonical relationships are untouched; `relationshipIds` maps a drawn
 * edge back to what it stands for.
 */
export type DrawnEdge = {
  id: string; source: string; target: string; style: RenderEdgeStyle; label: string | null;
  /** Member named at the source/target end when that end was moved onto its card. */
  sourceEnd: string | null; targetEnd: string | null;
  relationshipIds: string[];
};

export function routeEdgesToCards(edges: readonly RenderEdge[], { parentOf, labelOf, bundleLabel }: {
  parentOf: (id: string) => string | undefined; labelOf: (id: string) => string; bundleLabel: (count: number) => string;
}): DrawnEdge[] {
  const groups = new Map<string, DrawnEdge[]>();
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    const sourceCard = parentOf(edge.source), targetCard = parentOf(edge.target);
    const source = sourceCard ?? edge.source, target = targetCard ?? edge.target;
    if (source === target) continue;
    const drawn: DrawnEdge = { id: edge.id, source, target, style: edge.style, label: edge.label,
      sourceEnd: sourceCard ? labelOf(edge.source) : null, targetEnd: targetCard ? labelOf(edge.target) : null, relationshipIds: [edge.id] };
    // Only edges moved onto a card bundle; distinct canonical pairs keep their own line.
    const key = sourceCard || targetCard ? `${edge.style}|${[source, target].sort().join('|')}` : `edge|${edge.id}`;
    groups.set(key, [...(groups.get(key) ?? []), drawn]);
  }
  const result: DrawnEdge[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) { result.push(group[0]!); continue; }
    const [first] = group;
    result.push({ ...first!, id: `bundle:${first!.id}`, label: bundleLabel(group.length), sourceEnd: null, targetEnd: null, relationshipIds: group.map((edge) => edge.id) });
  }
  return result;
}
