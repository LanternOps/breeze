import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { devices, discoveredAssets, topologyManualNodes, topologyNodes, topologyRelationships, topologyNodeBindings, topologyLayouts, topologyNodePositions, topologyChangeOutbox, topologySiteState } from '../../db/schema';
import { parseLegacyTopologyEvent } from './legacyCapture';
import { legacyEndpointTable, legacyNodeIdentity, opaqueLegacyMismatchId, parseSnapshotEnvelope, projectLegacyNode, projectLegacyRelationship, type LegacySource, type LegacyNodeTable } from './legacyProjection';
import { publishTopologyBuild, type NodePublication, type RelationshipPublication, type BindingPublication } from './publish';
import { emptyLegacyCounts, type LegacyImportCheckpoint } from './legacyImportState';
import { splitRevokedLegacyInventoryLinks } from './legacyIdentitySplit';

type OutboxRow = typeof topologyChangeOutbox.$inferSelect;
const scopeWhere = (scope: TopologyScope, table: { orgId: AnyPgColumn; siteId: AnyPgColumn }) => and(eq(table.orgId, scope.orgId), eq(table.siteId, scope.siteId));
type SourceEvent = { source: LegacySource; snapshot: boolean; deletion: boolean; row: OutboxRow };
const key = (table: string, id: string) => `${table}:${id}`;
function nodeProjection(row: typeof topologyNodes.$inferSelect): NodePublication {
  const { createdAt: _created, updatedAt: _updated, revision: _revision, ...rest } = row;
  return rest;
}
function relationProjection(row: typeof topologyRelationships.$inferSelect): RelationshipPublication {
  const { createdAt: _created, updatedAt: _updated, revision: _revision, graphRevision: _graph, ...rest } = row;
  return rest;
}

function decode(scope: TopologyScope, row: OutboxRow): SourceEvent | null {
  if (row.eventKind === 'configuration.change') {
    z.object({ version:z.literal(1), settingsRevision:z.string().regex(/^(0|[1-9]\d*)$/), configurationDigest:z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(row.payload);
    return null;
  }
  if (row.eventKind === 'legacy.checkpoint') {
    if (row.payload.version !== 1 || row.payload.kind !== 'legacy.checkpoint') throw new Error('Invalid legacy checkpoint envelope');
    return null;
  }
  if (row.eventKind === 'legacy.snapshot') {
    const snapshot = parseSnapshotEnvelope(row.payload);
    return { source: { ...snapshot.item, sourceRevision: snapshot.sourceRevision }, snapshot: true, deletion: false, row };
  }
  const event = parseLegacyTopologyEvent(row.payload);
  if (event.sourceRevision !== row.sourceRevision.toString() || event.sourceId !== row.aggregateId || event.type !== row.eventKind) throw new Error('Outbox envelope identity mismatch');
  const deletion = event.type.endsWith('.delete') || (event.type === 'binding.changed' && event.data === null);
  const target = deletion ? event.oldIdentity : event.newIdentity;
  if (target?.orgId !== scope.orgId || target.siteId !== scope.siteId) throw new Error('Outbox source scope mismatch');
  // V2-only mutations already commit canonical changes with their intent; the
  // consumer acknowledges their checkpoint and must not mirror them again.
  if (event.sourceTable === 'v2_intents') return null;
  return { source: { sourceTable: event.sourceTable, sourceId: event.sourceId, sourceRevision: event.sourceRevision, data: event.data }, snapshot: false, deletion, row };
}

/** Called with the site capture lock held. Publication, layout CAS, source
 * fences, durable counters and delivery ACK all belong to the caller's tx. */
export async function replayLegacyBatch(scope: TopologyScope, rows: OutboxRow[], buildFence: bigint, checkpoint: LegacyImportCheckpoint) {
  const counts = emptyLegacyCounts();
  const mismatches: LegacyImportCheckpoint['mismatches'] = [];
  if (!rows.length) return { counts, mismatches };
  const quarantine = (event: SourceEvent, reason: string, category: 'manual' | 'pin' | 'other') => {
    counts.conflicted++;
    if (mismatches.length < 100) mismatches.push({ id: opaqueLegacyMismatchId(scope, event.source.sourceTable, event.source.sourceId), reason, category });
  };
  const events = rows.map(row => decode(scope, row));
  let nodes = await db.select().from(topologyNodes).where(scopeWhere(scope, topologyNodes));
  const relationships = await db.select().from(topologyRelationships).where(scopeWhere(scope, topologyRelationships));
  let currentBindings = await db.select().from(topologyNodeBindings).where(scopeWhere(scope, topologyNodeBindings));
  const liveDevices = new Set((await db.select({ id: devices.id }).from(devices).where(and(eq(devices.orgId, scope.orgId), eq(devices.siteId, scope.siteId)))).map(r => r.id));
  const liveAssets = new Map((await db.select({ id: discoveredAssets.id, linkedDeviceId: discoveredAssets.linkedDeviceId, suppressedAt: discoveredAssets.autoLinkSuppressedAt }).from(discoveredAssets).where(and(eq(discoveredAssets.orgId, scope.orgId), eq(discoveredAssets.siteId, scope.siteId)))).map(r => [r.id, r]));
  const liveManual = new Set((await db.select({ id: topologyManualNodes.id }).from(topologyManualNodes).where(and(eq(topologyManualNodes.orgId, scope.orgId), eq(topologyManualNodes.siteId, scope.siteId)))).map(r => r.id));
  const split = await splitRevokedLegacyInventoryLinks(scope, { nodes, bindings: currentBindings, liveDeviceIds: liveDevices, liveAssets: [...liveAssets.values()] }, buildFence);
  if (split.changed) {
    nodes = await db.select().from(topologyNodes).where(scopeWhere(scope, topologyNodes));
    currentBindings = await db.select().from(topologyNodeBindings).where(scopeWhere(scope, topologyNodeBindings));
  }
  const nodeMap = new Map(nodes.map(row => [row.identityKey, nodeProjection(row)]));
  const nodeById = new Map(nodes.map(row => [row.id, nodeProjection(row)]));
  const relationMap = new Map(relationships.filter(row => row.legacySourceId).map(row => [row.legacySourceId!, relationProjection(row)]));
  const stagedNodes = new Map<string, NodePublication>();
  const stagedRelationships = new Map<string, RelationshipPublication>();
  const stagedBindings = new Map<string, BindingPublication>();
  const positions: SourceEvent[] = [];
  // Unknown relationship/position deletes cannot satisfy canonical endpoint
  // FKs. Keep their delivered envelope as the source fence, beyond retention.
  const retainedDeletes = await db.select({ aggregateId: topologyChangeOutbox.aggregateId, payload: topologyChangeOutbox.payload, revision: topologyChangeOutbox.sourceRevision }).from(topologyChangeOutbox)
    .where(and(scopeWhere(scope, topologyChangeOutbox), sql`${topologyChangeOutbox.eventKind} IN ('relationship.delete','layout.delete')`, sql`${topologyChangeOutbox.deliveredAt} IS NOT NULL`));
  const deleteFences = new Map<string, bigint>();
  for (const row of retainedDeletes) {
    const sourceTable = String(row.payload.sourceTable);
    const k = key(sourceTable, row.aggregateId);
    if ((deleteFences.get(k) ?? -1n) < row.revision) deleteFences.set(k, row.revision);
  }
  const resolveNode = (table: LegacyNodeTable, sourceId: string): NodePublication | undefined => {
    let node = nodeMap.get(legacyNodeIdentity(scope, table, sourceId).identityKey);
    const seen = new Set<string>();
    while (node?.aliasTargetId) {
      if (seen.has(node.id)) throw new Error('Legacy node alias cycle');
      seen.add(node.id); node = nodeById.get(node.aliasTargetId);
    }
    return node;
  };
  for (const event of events) {
    if (!event) { counts.skipped++; continue; }
    const { source, deletion } = event;
    const sourceRevision = BigInt(source.sourceRevision);
    const retainedFence = deleteFences.get(key(source.sourceTable, source.sourceId));
    if (!deletion && retainedFence !== undefined && retainedFence >= sourceRevision) { counts.skipped++; continue; }
    if (source.sourceTable === 'topology_layout') { positions.push(event); continue; }
    if (source.sourceTable !== 'network_topology') {
      const table = source.sourceTable;
      const candidate = projectLegacyNode(scope, source);
      const old = nodeMap.get(candidate.identityKey);
      if (old?.legacySourceRevision != null && old.legacySourceRevision >= sourceRevision) { counts.skipped++; continue; }
      const next = deletion && old
        ? { ...old, lifecycle: 'withdrawn' as const, deletedAt: new Date(0), legacySourceRevision: sourceRevision }
        : { ...candidate, id: old?.id ?? candidate.id, aliasTargetId: old?.aliasTargetId ?? null,
          attributes: { ...candidate.attributes,
            ...(old?.attributes?.prefix !== undefined ? { prefix: old.attributes.prefix } : {}),
            ...(old?.attributes?.addressFamily !== undefined ? { addressFamily: old.attributes.addressFamily } : {}),
          } };
      stagedNodes.set(next.identityKey, next); nodeMap.set(next.identityKey, next); nodeById.set(next.id, next);
      const sourceKey = key(table, source.sourceId);
      const live = table === 'devices' ? liveDevices.has(source.sourceId) : table === 'discovered_assets' ? liveAssets.has(source.sourceId) : liveManual.has(source.sourceId);
      const existing = currentBindings.find(b => table === 'devices' ? b.deviceId === source.sourceId : table === 'discovered_assets' ? b.discoveredAssetId === source.sourceId : b.manualNodeId === source.sourceId);
      if (deletion) {
        stagedBindings.delete(sourceKey);
        if (existing) await db.delete(topologyNodeBindings).where(and(scopeWhere(scope, topologyNodeBindings), eq(topologyNodeBindings.id, existing.id)));
        counts.tombstone++;
      } else if (live) {
        stagedBindings.set(sourceKey, { ...scope, id: existing?.id ?? randomUUID(), nodeId: next.aliasTargetId ?? next.id,
          deviceId: table === 'devices' ? source.sourceId : null, discoveredAssetId: table === 'discovered_assets' ? source.sourceId : null,
          manualNodeId: table === 'topology_manual_nodes' ? source.sourceId : null, provenance: { method: table === 'topology_manual_nodes' ? 'manual' : 'inventory', sourceId: source.sourceId } });
      }
      if (table === 'topology_manual_nodes') counts.manual++;
      counts.imported++;
      continue;
    }
    const old = relationMap.get(source.sourceId);
    if (old?.legacySourceRevision != null && old.legacySourceRevision >= sourceRevision) { counts.skipped++; continue; }
    if (deletion) {
      deleteFences.set(key(source.sourceTable, source.sourceId), sourceRevision);
      if (old) {
        const next = { ...old, lifecycle: 'withdrawn' as const, deletedAt: new Date(0), legacySourceRevision: sourceRevision };
        relationMap.set(source.sourceId, next); stagedRelationships.set(source.sourceId, next);
      }
      counts.tombstone++; counts.imported++; continue;
    }
    if (!['manual', 'lldp', 'cdp', 'fdb', 'unifi'].includes(String(source.data?.method))) {
      quarantine(event, 'unverified_legacy_method', 'other'); continue;
    }
    const sourceTable = legacyEndpointTable(source.data?.sourceType);
    const targetTable = legacyEndpointTable(source.data?.targetType);
    const sourceNode = sourceTable && typeof source.data?.sourceId === 'string' ? resolveNode(sourceTable, source.data.sourceId) : undefined;
    const targetNode = targetTable && typeof source.data?.targetId === 'string' ? resolveNode(targetTable, source.data.targetId) : undefined;
    if (!sourceNode || !targetNode || sourceNode.deletedAt || targetNode.deletedAt || sourceNode.id === targetNode.id) {
      quarantine(event, 'ambiguous_or_missing_endpoints', source.data?.method === 'manual' ? 'manual' : 'other'); continue;
    }
    const projected = projectLegacyRelationship(scope, source, sourceNode.id, targetNode.id);
    const next = { ...projected, ...(old ? { id: old.id, attributes: { ...projected.attributes,
      ...(old.attributes?.label !== undefined ? { label: old.attributes.label } : {}),
      ...(old.attributes?.notes !== undefined ? { notes: old.attributes.notes } : {}),
      ...(old.attributes?.createdBy !== undefined ? { createdBy: old.attributes.createdBy } : {}),
    } } : {}) };
    relationMap.set(source.sourceId, next); stagedRelationships.set(source.sourceId, next);
    if (source.data?.method === 'manual') counts.manual++;
    counts.imported++;
  }
  // Only a CURRENT accepted link permits aliasing. A historical event whose
  // link was revoked must never restore identity authority or an invalid FK.
  for (const [assetId, asset] of liveAssets) {
    if (!asset.linkedDeviceId || asset.suppressedAt || !liveDevices.has(asset.linkedDeviceId)) continue;
    const assetNode = resolveNode('discovered_assets', assetId);
    const deviceNode = resolveNode('devices', asset.linkedDeviceId);
    if (!assetNode || !deviceNode || assetNode.deletedAt || deviceNode.deletedAt || assetNode.id === deviceNode.id) continue;
    // An unchanged source row cannot request a new alias through the source
    // fence. Only touch an advancing staged row; the other link will be seen
    // when its inventory/snapshot event is delivered.
    const candidate = stagedNodes.get(assetNode.identityKey) ?? stagedNodes.get(deviceNode.identityKey);
    if (candidate) stagedNodes.set(candidate.identityKey, { ...candidate, aliasTargetId: candidate.id === assetNode.id ? deviceNode.id : assetNode.id });
  }
  const last = rows.at(-1);
  if (!last) return { counts, mismatches };
  const published = await publishTopologyBuild(scope, { buildFence: split.buildFence.toString(), inputRevision: last.sourceRevision.toString(),
    nodes: [...stagedNodes.values()], relationships: [...stagedRelationships.values()], bindings: [...stagedBindings.values()] });
  if (!published.published) throw new Error('Legacy publication checkpoint was fenced');
  if (split.changed && BigInt(published.graphRevision) === split.graphRevision) {
    await db.update(topologySiteState).set({ graphRevision: sql`${topologySiteState.graphRevision}+1`, updatedAt: new Date() }).where(scopeWhere(scope, topologySiteState));
  }
  const canonical = await db.select().from(topologyNodes).where(scopeWhere(scope, topologyNodes));
  const canonicalByKey = new Map(canonical.map(n => [n.identityKey, n]));
  const canonicalById = new Map(canonical.map(n => [n.id, n]));
  for (const event of positions) {
    const table = legacyEndpointTable(event.source.data?.nodeType);
    const sourceId = event.source.data?.nodeId;
    let node = table && typeof sourceId === 'string' ? canonicalByKey.get(legacyNodeIdentity(scope, table, sourceId).identityKey) : undefined;
    if (node?.aliasTargetId) node = canonicalById.get(node.aliasTargetId);
    if (!node || (node.deletedAt && !event.deletion)) {
      if (event.deletion) { counts.tombstone++; continue; }
      quarantine(event, 'missing_position_node', 'pin'); continue;
    }
    const [layout] = await db.insert(topologyLayouts).values({ ...scope, view: 'overview' }).onConflictDoNothing().returning();
    const activeLayout = layout ?? (await db.select().from(topologyLayouts).where(and(scopeWhere(scope, topologyLayouts), eq(topologyLayouts.view, 'overview'))))[0]!;
    const [old] = await db.select().from(topologyNodePositions).where(and(scopeWhere(scope, topologyNodePositions), eq(topologyNodePositions.layoutId, activeLayout.id), eq(topologyNodePositions.nodeId, node.id)));
    const revision = BigInt(event.source.sourceRevision);
    if (old?.legacySourceRevision != null && old.legacySourceRevision >= revision) { counts.skipped++; continue; }
    // Existing v2 pin edits win over a baseline with no source fence. Later
    // captured legacy writes are explicit edits, including explicit unpin.
    if (event.snapshot && old && old.legacySourceRevision === null) { counts.skipped++; continue; }
    const data = event.source.data!;
    const pinned = event.snapshot ? true : data.pinned === true;
    const next = { ...scope, layoutId: activeLayout.id, nodeId: node.id,
      x: event.deletion ? old?.x ?? 0 : Number(data.x), y: event.deletion ? old?.y ?? 0 : Number(data.y),
      pinned: event.deletion ? old?.pinned ?? false : pinned, positionSource: 'legacy' as const,
      updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : null, legacySourceRevision: revision,
      deletedAt: event.deletion ? new Date(0) : null, revision: (old?.revision ?? 0n) + 1n, updatedAt: new Date() };
    const changed = !old || old.x !== next.x || old.y !== next.y || old.pinned !== next.pinned || !!old.deletedAt !== !!next.deletedAt;
    await db.insert(topologyNodePositions).values(next).onConflictDoUpdate({ target: [topologyNodePositions.layoutId, topologyNodePositions.nodeId], set: { ...next,
      revision: changed ? next.revision : old!.revision, positionSource: changed ? next.positionSource : old!.positionSource, updatedBy: changed ? next.updatedBy : old!.updatedBy } });
    if (changed) await db.update(topologyLayouts).set({ revision: sql`${topologyLayouts.revision}+1`, updatedAt: new Date() }).where(and(scopeWhere(scope, topologyLayouts), eq(topologyLayouts.id, activeLayout.id)));
    counts.imported++; if (event.deletion) counts.tombstone++; else if (pinned) counts.pin++;
  }
  // A commit failure rolls the ACK back along with publisher/layout writes.
  await db.update(topologyChangeOutbox).set({ deliveredAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(scopeWhere(scope, topologyChangeOutbox), isNull(topologyChangeOutbox.deliveredAt), sql`${topologyChangeOutbox.id} IN (${sql.join(rows.map(row => sql`${row.id}::uuid`), sql`,`)})`));
  void checkpoint;
  return { counts, mismatches };
}
