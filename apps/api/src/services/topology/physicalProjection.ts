import type { GraphNode, GraphRelationship, RelationshipKind } from '@breeze/shared';

/**
 * Pure read projection of the physical view (M2 Task 9). The read service
 * (graph.ts) owns authorization, the physical-exposure gate, per-view
 * exclusions in SQL, authorized totals and bounded frontiers; this is the final
 * presentation filter over the rows it already selected. It never mutates or
 * re-keys an entity: canonical IDs and evidence metadata pass through as-is.
 * Reconciliation mutation types are deliberately not used here.
 */
export type PhysicalViewInput = {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  excludedRelationshipIds: ReadonlySet<string>;
};
export type PhysicalViewResult = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const PHYSICAL_KINDS: ReadonlySet<RelationshipKind> = new Set(['physical_link', 'attachment']);

export function projectPhysicalView(input: PhysicalViewInput): PhysicalViewResult {
  const nodes = input.nodes.filter((node) => node.lifecycle === 'active');
  const present = new Set(nodes.map((node) => node.id));
  // Only measured/asserted cables and attachment candidates are physical;
  // subnet membership, routes and schematic meaning never render as cables.
  // Parallel cables stay distinct: each is its own canonical relationship.
  const relationships = input.relationships
    .filter((relationship) => PHYSICAL_KINDS.has(relationship.kind) && relationship.lifecycle === 'active'
      && !input.excludedRelationshipIds.has(relationship.id)
      && present.has(relationship.sourceNodeId) && present.has(relationship.targetNodeId))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return { nodes, relationships };
}
