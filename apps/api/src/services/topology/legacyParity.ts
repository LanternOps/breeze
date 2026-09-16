import { and, eq, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { topologyNodes, topologyRelationships, topologyNodePositions, topologyLayouts, topologySiteState } from '../../db/schema';
import { legacyEndpointTable, legacyNodeIdentity, legacyRevisionSchema, opaqueLegacyMismatchId } from './legacyProjection';
import { emptyLegacyCounts, readLegacyImportCheckpoint, readLegacySnapshot, requireTopologyCapture, scopedTopology, withLegacyImportSavepoint, type LegacyImportCounts } from './legacyImportState';

export interface LegacyParityReport extends LegacyImportCounts {
  barrierRevision: string;
  materializedInputRevision: string;
  pendingThroughBarrier: number;
  unexplainedManualDifferences: string[];
  unexplainedManualDifferenceCount: number;
  unexplainedPinDifferences: string[];
  unexplainedPinDifferenceCount: number;
  resurrectedTombstones: string[];
  resurrectedTombstoneCount: number;
  mismatchIds: string[];
  complete: boolean;
  sameBarrier: boolean;
  ok: boolean;
}

/** Manual assertions and positions are compared under the same capture lock
 * as publication. A historical barrier cannot be compared to a newer live
 * legacy graph; report it incomplete instead of claiming false parity. */
export async function compareLegacyTopology(scope: TopologyScope, options: { throughRevision?: string } = {}): Promise<LegacyParityReport> {
  if (options.throughRevision !== undefined) legacyRevisionSchema.parse(options.throughRevision);
  await requireTopologyCapture(scope);
  return withLegacyImportSavepoint(async () => {
    const [state] = await db.select().from(topologySiteState).where(scopedTopology(scope)).for('update');
    const checkpoint = state ? readLegacyImportCheckpoint(state.effectiveSettings) : null;
    const through = BigInt(options.throughRevision ?? state?.dirtyRevision.toString() ?? '0');
    const pending = await db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM topology_change_outbox
      WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND delivered_at IS NULL AND source_revision<=${through}::bigint`);
    const report: LegacyParityReport = { ...(checkpoint?.counts ?? emptyLegacyCounts()), barrierRevision: through.toString(), materializedInputRevision: state?.materializedInputRevision.toString() ?? '0',
      pendingThroughBarrier: Number(pending[0]!.count), unexplainedManualDifferences: [], unexplainedPinDifferences: [], resurrectedTombstones: [],
      unexplainedManualDifferenceCount: 0, unexplainedPinDifferenceCount: 0, resurrectedTombstoneCount: 0, mismatchIds: [],
      complete: !!checkpoint && checkpoint.status === 'complete' && !!state && state.materializedInputRevision >= through,
      sameBarrier: !!state && state.dirtyRevision === through, ok: false };
    if (!report.complete || !report.sameBarrier || report.pendingThroughBarrier !== 0) return report;
    const mismatch = (table: string, id: string, category: 'manual' | 'pin' | 'tombstone') => {
      const opaqueId = opaqueLegacyMismatchId(scope, table, id);
      const ids = category === 'manual' ? report.unexplainedManualDifferences : category === 'pin' ? report.unexplainedPinDifferences : report.resurrectedTombstones;
      if (category === 'manual') report.unexplainedManualDifferenceCount++;
      else if (category === 'pin') report.unexplainedPinDifferenceCount++;
      else report.resurrectedTombstoneCount++;
      if (ids.length < 100) ids.push(opaqueId);
      if (report.mismatchIds.length < 100) report.mismatchIds.push(opaqueId);
    };
    const legacy = await readLegacySnapshot(scope);
    const nodes = await db.select().from(topologyNodes).where(and(eq(topologyNodes.orgId, scope.orgId), eq(topologyNodes.siteId, scope.siteId)));
    const nodeByKey = new Map(nodes.map(row => [row.identityKey, row]));
    const nodeById = new Map(nodes.map(row => [row.id, row]));
    const relations = await db.select().from(topologyRelationships).where(and(eq(topologyRelationships.orgId, scope.orgId), eq(topologyRelationships.siteId, scope.siteId)));
    const relationBySource = new Map(relations.filter(row => row.legacySourceId).map(row => [row.legacySourceId!, row]));
    const [layout] = await db.select().from(topologyLayouts).where(and(eq(topologyLayouts.orgId, scope.orgId), eq(topologyLayouts.siteId, scope.siteId), eq(topologyLayouts.view, 'overview')));
    const positions = layout ? await db.select().from(topologyNodePositions).where(and(eq(topologyNodePositions.orgId, scope.orgId), eq(topologyNodePositions.siteId, scope.siteId), eq(topologyNodePositions.layoutId, layout.id))) : [];
    const resolveNode = (type: unknown, id: unknown) => {
      const table = legacyEndpointTable(type);
      let node = table && typeof id === 'string' ? nodeByKey.get(legacyNodeIdentity(scope, table, id).identityKey) : undefined;
      if (node?.aliasTargetId) node = nodeById.get(node.aliasTargetId);
      return node;
    };
    const manualIds = new Set<string>();
    const manualRelationshipIds = new Set<string>();
    for (const source of legacy) {
      const data = source.data!;
      if (source.sourceTable === 'topology_manual_nodes') {
        manualIds.add(source.sourceId);
        const node = resolveNode('manual_node', source.sourceId);
        if (!node || node.deletedAt || node.labelOverride !== data.label || node.role !== data.role || (node.attributes.notes ?? '') !== (data.notes ?? '')) mismatch(source.sourceTable, source.sourceId, 'manual');
      } else if (source.sourceTable === 'network_topology' && data.method === 'manual') {
        manualRelationshipIds.add(source.sourceId);
        const relation = relationBySource.get(source.sourceId);
        const sourceNode = resolveNode(data.sourceType, data.sourceId);
        const targetNode = resolveNode(data.targetType, data.targetId);
        if (!relation || relation.deletedAt || !sourceNode || !targetNode || relation.sourceNodeId !== sourceNode.id || relation.targetNodeId !== targetNode.id || relation.evidenceClass !== 'manual' || relation.confidence !== 'asserted') mismatch(source.sourceTable, source.sourceId, 'manual');
      } else if (source.sourceTable === 'topology_layout') {
        const node = resolveNode(data.nodeType, data.nodeId);
        const position = positions.find(p => p.nodeId === node?.id);
        const conservativelyPinned = position?.positionSource === 'legacy' && position.legacySourceRevision !== null && position.legacySourceRevision <= BigInt(checkpoint!.capturedThrough);
        if (!position || position.deletedAt || position.x !== data.x || position.y !== data.y || (position.pinned !== data.pinned && !(conservativelyPinned && position.pinned))) mismatch(source.sourceTable, source.sourceId, 'pin');
      }
    }
    for (const node of nodes) if (node.legacySourceType === 'topology_manual_nodes' && node.legacySourceId && !node.deletedAt && !manualIds.has(node.legacySourceId)) mismatch('topology_manual_nodes', node.legacySourceId, 'manual');
    for (const relation of relations) if (relation.legacySourceType === 'network_topology' && relation.legacySourceId && relation.evidenceClass === 'manual' && !relation.deletedAt && !manualRelationshipIds.has(relation.legacySourceId)) mismatch('network_topology', relation.legacySourceId, 'manual');
    const deletes = await db.execute<{ source_table: string; source_id: string; revision: string; node_type: string | null; node_id: string | null }>(sql`
      SELECT payload->>'sourceTable' AS source_table, aggregate_id::text AS source_id, source_revision::text AS revision,
        payload->'data'->>'nodeType' AS node_type,payload->'data'->>'nodeId' AS node_id
      FROM topology_change_outbox WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid
        AND event_kind IN ('node.delete','relationship.delete','layout.delete') AND source_revision<=${through}::bigint
    `);
    for (const deletion of deletes) {
      const revision = BigInt(deletion.revision);
      const row = deletion.source_table === 'network_topology' ? relationBySource.get(deletion.source_id)
        : deletion.source_table === 'topology_layout' ? positions.find(p => p.nodeId === resolveNode(deletion.node_type, deletion.node_id)?.id)
          : resolveNode('manual_node', deletion.source_id);
      if (row && !row.deletedAt && (row.legacySourceRevision ?? 0n) <= revision) mismatch(deletion.source_table, deletion.source_id, 'tombstone');
    }
    report.ok = report.unexplainedManualDifferenceCount === 0 && report.unexplainedPinDifferenceCount === 0 && report.resurrectedTombstoneCount === 0;
    return report;
  });
}
