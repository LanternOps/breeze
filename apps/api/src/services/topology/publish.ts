import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { nodeKindSchema, relationshipKindSchema, lifecycleSchema, confidenceSchema, evidenceClassSchema, directnessSchema, type TopologyScope } from '@breeze/shared';
import { db, assertInTransaction } from '../../db';
import { topologyNodes, topologyRelationships, topologyNodeBindings, topologyNodePositions, topologyLayouts, topologySiteState, auditLogs, discoveredAssets } from '../../db/schema';
import { canonicalIdentityKey, normalizedTopologyScope, planAliasClusterPosition } from './identity';
import { planAcceptedAliasClusters } from './aliasClusters';
import { lockTopologyInventoryReferences } from './inventoryLocks';

type Owned = 'createdAt' | 'updatedAt' | 'revision';
export type NodePublication = Omit<typeof topologyNodes.$inferInsert, Owned> & { id: string };
export type RelationshipPublication = Omit<typeof topologyRelationships.$inferInsert, Owned | 'graphRevision'> & { id: string };
export type BindingPublication = Omit<typeof topologyNodeBindings.$inferInsert, Owned> & { id: string };
export type PublicationInput = { buildFence: string; inputRevision: string; nodes: NodePublication[]; relationships: RelationshipPublication[]; bindings: BindingPublication[] };

const uuid = z.string().uuid().transform(s => s.toLowerCase());
const counter = z.bigint().min(0n).max(9223372036854775807n);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/).refine(v => v.length <= 19 && /^(0|[1-9]\d*)$/.test(v) && BigInt(v) <= 9223372036854775807n);
const scoped = { id: uuid, orgId: uuid, siteId: uuid };
const identityMaterial = z.object({ version: z.literal(1), kind: z.union([nodeKindSchema, relationshipKindSchema]), sourceKey: z.string().min(1).max(8192) }).strict();
const legacy = { legacySourceType: z.string().min(1).max(40).nullable().optional(), legacySourceId: uuid.nullable().optional(), legacySourceRevision: counter.nullable().optional(), deletedAt: z.date().nullable().optional() };
const nodeSchema = z.object({ ...scoped, identityKey: z.string().max(256), identityMaterial, kind: nodeKindSchema,
  role: z.string().max(64).nullable().optional(), labelOverride: z.string().max(255).nullable().optional(),
  attributes: z.object({ label: z.string().max(255).optional(), notes: z.string().max(8192).optional(), prefix: z.string().max(128).optional(), addressFamily: z.union([z.literal(4), z.literal(6)]).optional() }).strict().default({}),
  firstObservedAt: z.date().nullable().optional(), lastObservedAt: z.date().nullable().optional(), lifecycle: lifecycleSchema.default('active'), aliasTargetId: uuid.nullable().optional(), ...legacy,
}).strict();
const relationshipSchema = z.object({ ...scoped, canonicalKey: z.string().max(256), identityMaterial, kind: relationshipKindSchema,
  sourceNodeId: uuid, targetNodeId: uuid,
  logicalContext: z.object({ routingDomainId: uuid.optional(), interfaceId: uuid.optional(), addressFamily: z.union([z.literal(4), z.literal(6)]).optional(), destinationPrefix: z.string().max(128).optional(), contextKey: z.string().max(8192).optional() }).strict().default({}),
  directness: directnessSchema.default('unknown'), confidence: confidenceSchema.default('asserted'), evidenceClass: evidenceClassSchema.default('manual'), lifecycle: lifecycleSchema.default('active'),
  firstSupportedAt: z.date().nullable().optional(), lastSupportedAt: z.date().nullable().optional(), supportCount: counter.default(0n),
  attributes: z.object({ label: z.string().max(255).optional(), notes: z.string().max(8192).optional(), method: z.enum(['manual', 'legacy']).optional(), createdBy: uuid.optional() }).strict().default({}), ...legacy,
}).strict().refine(row => (row.evidenceClass === 'manual') === (row.confidence === 'asserted'), 'Manual evidence requires asserted confidence');
const bindingSchema = z.object({ ...scoped, nodeId: uuid, deviceId: uuid.nullable().optional(), discoveredAssetId: uuid.nullable().optional(), manualNodeId: uuid.nullable().optional(),
  provenance: z.object({ method: z.enum(['inventory', 'accepted_link', 'manual', 'legacy']).optional(), sourceId: uuid.optional(), createdBy: uuid.optional() }).strict().default({}),
}).strict().refine(row => [row.deviceId, row.discoveredAssetId, row.manualNodeId].filter(Boolean).length === 1, 'Inventory binding requires exactly one reference');
const publicationSchema = z.object({ buildFence: decimal, inputRevision: decimal, nodes: z.array(nodeSchema).max(100000), relationships: z.array(relationshipSchema).max(200000), bindings: z.array(bindingSchema).max(200000) }).strict();

export function validatePublicationInput(scope: TopologyScope, input: PublicationInput) {
  const normalized = normalizedTopologyScope(scope);
  const parsed = publicationSchema.parse(input);
  for (const rows of [parsed.nodes, parsed.relationships, parsed.bindings]) {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const row of rows) {
      if (row.orgId !== normalized.orgId || row.siteId !== normalized.siteId) throw new Error('Publication scope mismatch');
      if (ids.has(row.id)) throw new Error('Duplicate publication ID');
      ids.add(row.id);
      if ('identityMaterial' in row) {
        const key = 'identityKey' in row ? row.identityKey : row.canonicalKey;
        if (row.identityMaterial.kind !== row.kind || canonicalIdentityKey(normalized, row.kind, row.identityMaterial.sourceKey) !== key) throw new Error('Invalid canonical identity material');
        if (keys.has(key)) throw new Error('Duplicate publication identity');
        keys.add(key);
      } else {
        const key = bindingKey(row);
        if (keys.has(key)) throw new Error('Duplicate inventory binding');
        keys.add(key);
      }
      if ('kind' in row && row.kind === 'physical_link' && (row.attributes.method === 'legacy' || row.legacySourceType)) throw new Error('Legacy provenance cannot promote a physical link');
      if ('canonicalKey' in row && row.attributes.method === 'legacy'
        && (row.evidenceClass !== 'inferred' || row.confidence !== 'low' || row.directness !== 'unknown')) throw new Error('Unknown legacy provenance must remain unverified');
    }
  }
  return parsed;
}

const structuralFields = {
  node: ['id', 'identityKey', 'identityMaterial', 'kind', 'role', 'labelOverride', 'attributes', 'lifecycle', 'aliasTargetId', 'deletedAt'],
  relationship: ['id', 'canonicalKey', 'identityMaterial', 'kind', 'sourceNodeId', 'targetNodeId', 'logicalContext', 'directness', 'confidence', 'evidenceClass', 'lifecycle', 'attributes', 'deletedAt'],
  binding: ['id', 'nodeId', 'deviceId', 'discoveredAssetId', 'manualNodeId', 'provenance'],
};
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value ?? null;
}
/** Deliberate allowlist: new health, layout, support timestamps or checkpoint
 * columns cannot silently start advancing the structural graph revision. */
export function structuralFingerprint(kind: keyof typeof structuralFields, row: object): string {
  const record = row as Record<string, unknown>;
  return JSON.stringify(stable(Object.fromEntries(structuralFields[kind].map(key => [key, key === 'deletedAt' ? !!record[key] : record[key]]))));
}
const scopedWhere = (table: { orgId: AnyPgColumn; siteId: AnyPgColumn }, scope: TopologyScope) => and(eq(table.orgId, scope.orgId), eq(table.siteId, scope.siteId));
const bindingKey = (b: { deviceId?: string | null; discoveredAssetId?: string | null; manualNodeId?: string | null }) => b.deviceId ? `device:${b.deviceId}` : b.discoveredAssetId ? `asset:${b.discoveredAssetId}` : `manual:${b.manualNodeId}`;

/** Accepted staged upserts, not a completeness signal. Absent facts survive;
 * explicit revisioned tombstones withdraw sources. Call inside an authorized
 * request/system DB context; this function owns the atomic publication savepoint. */
export async function publishTopologyBuild(scope: TopologyScope, input: PublicationInput): Promise<{ published: boolean; graphRevision: string }> {
  const normalized = normalizedTopologyScope(scope);
  const staged = validatePublicationInput(normalized, input);
  assertInTransaction('publishTopologyBuild');
  return db.transaction(async tx => {
    const [state] = await tx.select().from(topologySiteState).where(scopedWhere(topologySiteState, normalized)).for('update');
    if (!state) throw new Error('Topology site state is missing or inaccessible');
    if (state.buildFence !== BigInt(staged.buildFence) || state.materializedInputRevision >= BigInt(staged.inputRevision)) return { published: false, graphRevision: state.graphRevision.toString() };
    if (BigInt(staged.inputRevision) > state.dirtyRevision) throw new Error('Publication input exceeds captured dirty revision');
    const nodes = await tx.select().from(topologyNodes).where(scopedWhere(topologyNodes, normalized));
    const relationships = await tx.select().from(topologyRelationships).where(scopedWhere(topologyRelationships, normalized));
    const bindings = await tx.select().from(topologyNodeBindings).where(scopedWhere(topologyNodeBindings, normalized));
    // Shared with layout reads/writes: site state, sorted layout headers, then
    // positions. A merge's pin-conflict decision must see protected positions.
    await tx.select().from(topologyLayouts).where(scopedWhere(topologyLayouts, normalized)).orderBy(topologyLayouts.id).for('update');
    const positions = await tx.select().from(topologyNodePositions).where(scopedWhere(topologyNodePositions, normalized));
    const oldNodesById = new Map(nodes.map(n => [n.id, n]));
    const oldNodesByIdentity = new Map(nodes.map(n => [n.identityKey, n]));
    const oldRelationshipsById = new Map(relationships.map(r => [r.id, r]));
    const oldRelationshipsByIdentity = new Map(relationships.map(r => [r.canonicalKey, r]));
    const oldBindingsById = new Map(bindings.map(b => [b.id, b]));
    const oldBindingsByIdentity = new Map(bindings.map(b => [bindingKey(b), b]));
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const remap = new Map(nodes.filter(n => n.aliasTargetId).map(n => [n.id, n.aliasTargetId!]));
    const now = new Date();
    const nodeWrites: (typeof topologyNodes.$inferInsert)[] = [];
    const relationshipWrites: (typeof topologyRelationships.$inferInsert)[] = [];
    const bindingWrites: (typeof topologyNodeBindings.$inferInsert)[] = [];
    for (const row of staged.nodes) {
      const old = oldNodesByIdentity.get(row.identityKey);
      const collision = nodeMap.get(row.id);
      if (collision && collision.identityKey !== row.identityKey) throw new Error('Canonical node ID cannot change identity');
      const id = old?.id ?? row.id;
      remap.set(row.id, old?.aliasTargetId ?? id);
      if (old?.aliasTargetId && row.aliasTargetId !== old.aliasTargetId) throw new Error('A canonical alias cannot be restored as an independent node');
      if (old?.legacySourceRevision != null) {
        if (row.legacySourceRevision == null || old.legacySourceId !== row.legacySourceId || old.legacySourceType !== row.legacySourceType) throw new Error('Legacy source identity and revision are required');
        if (old.legacySourceRevision >= row.legacySourceRevision) continue;
      }
      // Automated refresh cannot erase manual facts. An advancing event from
      // the same legacy manual source can carry an explicit operator edit.
      const manualEdit = row.kind === 'manual' && row.legacySourceRevision != null;
      const labelOverride = manualEdit && row.labelOverride !== undefined ? row.labelOverride : old?.labelOverride ?? row.labelOverride ?? null;
      const notes = manualEdit && row.attributes.notes !== undefined ? row.attributes.notes : old?.attributes.notes ?? row.attributes.notes;
      const next = { ...old, ...row, id, labelOverride, attributes: { ...row.attributes, ...(notes !== undefined ? { notes } : {}) }, revision: (old?.revision ?? 0n) + 1n, createdAt: old?.createdAt ?? now, updatedAt: now };
      nodeWrites.push(next); nodeMap.set(id, next as typeof topologyNodes.$inferSelect);
    }
    const resolve = (id: string) => {
      const seen = new Set<string>();
      while (remap.has(id) && remap.get(id) !== id) {
        if (seen.has(id)) throw new Error('Canonical alias cycle');
        seen.add(id); id = remap.get(id)!;
      }
      return id;
    };
    for (const row of staged.bindings) {
      const old = oldBindingsByIdentity.get(bindingKey(row));
      if (oldBindingsById.has(row.id) && bindingKey(oldBindingsById.get(row.id)!) !== bindingKey(row)) throw new Error('Binding ID cannot change inventory identity');
      bindingWrites.push({ ...old, ...row, id: old?.id ?? row.id, nodeId: resolve(row.nodeId), updatedAt: now });
    }
    const finalBindings = new Map(bindings.map(b => [bindingKey(b), { ...b }]));
    for (const b of bindingWrites) finalBindings.set(bindingKey(b), { ...b } as typeof topologyNodeBindings.$inferSelect);
    const requests = nodeWrites.filter(node => node.aliasTargetId && oldNodesById.get(node.id!)?.aliasTargetId !== node.aliasTargetId)
      .map(node => ({ sourceId: node.id!, targetId: resolve(node.aliasTargetId!) }));
    // Capture takes asset -> site-state locks. A committed MVCC read under
    // site state supplies current accepted authority without inverting locks.
    const aliasAssets = requests.length ? await tx.select().from(discoveredAssets).where(and(eq(discoveredAssets.orgId, normalized.orgId), eq(discoveredAssets.siteId, normalized.siteId))) : [];
    const clusters = planAcceptedAliasClusters(normalized, { nodes: [...nodeMap.values()], requests,
      bindings: [...finalBindings.values()].map(binding => ({ ...binding, nodeId: resolve(binding.nodeId) })), assets: aliasAssets, positions: positions.filter(p => !p.deletedAt) });
    const nodeWriteIndexes = new Map(nodeWrites.map((node, index) => [node.id!, index]));
    for (const cluster of clusters) {
      remap.set(cluster.canonicalId, cluster.canonicalId);
      for (const id of cluster.aliasIds) remap.set(id, cluster.canonicalId);
      for (const id of [cluster.canonicalId, ...cluster.aliasIds]) {
        const node = nodeMap.get(id)!;
        const next = { ...node, ...(id === cluster.canonicalId ? { labelOverride: cluster.labelOverride,
          attributes: { ...node.attributes, ...(cluster.notes !== undefined ? { notes: cluster.notes } : {}) } } : {}),
          aliasTargetId: id === cluster.canonicalId ? null : cluster.canonicalId,
          revision: (oldNodesById.get(id)?.revision ?? 0n) + 1n, updatedAt: now };
        nodeMap.set(id, next);
        const index = nodeWriteIndexes.get(next.id);
        if (index !== undefined) nodeWrites[index] = next;
        else { nodeWriteIndexes.set(next.id, nodeWrites.length); nodeWrites.push(next); }
      }
    }
    for (const binding of finalBindings.values()) {
      const target = resolve(binding.nodeId);
      if (!nodeMap.has(target) || nodeMap.get(target)!.aliasTargetId) throw new Error('Binding target is not a scoped canonical node');
      const original = oldBindingsByIdentity.get(bindingKey(binding));
      if (original && resolve(original.nodeId) !== target) throw new Error('Binding reassignment requires an accepted canonical merge');
      if (target !== binding.nodeId) { binding.nodeId = target; bindingWrites.push({ ...binding, updatedAt: now }); }
    }
    const bindingGroups = new Map<string, typeof bindings>();
    for (const binding of finalBindings.values()) bindingGroups.set(binding.nodeId, [...(bindingGroups.get(binding.nodeId) ?? []), binding]);
    const sharedIdentities = [...bindingGroups.values()].filter(group => group.length > 1);
    if (sharedIdentities.length) {
      const assets = await tx.select().from(discoveredAssets).where(and(eq(discoveredAssets.orgId, normalized.orgId), eq(discoveredAssets.siteId, normalized.siteId)));
      for (const group of sharedIdentities) {
        const managed = group.filter(b => b.deviceId);
        if (managed.length !== 1 || group.some(b => b.manualNodeId)
          || group.filter(b => b.discoveredAssetId).some(b => !assets.some(a => a.id === b.discoveredAssetId && a.linkedDeviceId === managed[0]!.deviceId && !a.autoLinkSuppressedAt))) throw new Error('Shared endpoint bindings require an accepted inventory link');
      }
    }
    for (const old of nodes.filter(n => n.aliasTargetId && resolve(n.aliasTargetId) !== n.aliasTargetId)) {
      const next = { ...old, aliasTargetId: resolve(old.aliasTargetId!), revision: old.revision + 1n, updatedAt: now };
      const index = nodeWriteIndexes.get(old.id);
      if (index !== undefined) nodeWrites[index] = { ...nodeWrites[index]!, aliasTargetId: next.aliasTargetId };
      else { nodeWriteIndexes.set(old.id, nodeWrites.length); nodeWrites.push(next); }
    }
    for (const row of staged.relationships) {
      const old = oldRelationshipsByIdentity.get(row.canonicalKey);
      if (oldRelationshipsById.has(row.id) && oldRelationshipsById.get(row.id)!.canonicalKey !== row.canonicalKey) throw new Error('Relationship ID cannot change identity');
      if (old?.legacySourceRevision != null) {
        if (row.legacySourceRevision == null || old.legacySourceId !== row.legacySourceId || old.legacySourceType !== row.legacySourceType) throw new Error('Legacy source identity and revision are required');
        if (old.legacySourceRevision >= row.legacySourceRevision) continue;
      }
      if (old?.evidenceClass === 'manual' && row.evidenceClass !== 'manual') throw new Error('Automated publication cannot replace a manual assertion');
      relationshipWrites.push({ ...old, ...row, id: old?.id ?? row.id, sourceNodeId: resolve(row.sourceNodeId), targetNodeId: resolve(row.targetNodeId), revision: (old?.revision ?? 0n) + 1n, updatedAt: now });
    }
    for (const row of relationships) {
      if ((resolve(row.sourceNodeId) !== row.sourceNodeId || resolve(row.targetNodeId) !== row.targetNodeId) && !relationshipWrites.some(r => r.id === row.id)) relationshipWrites.push({ ...row, sourceNodeId: resolve(row.sourceNodeId), targetNodeId: resolve(row.targetNodeId), revision: row.revision + 1n, updatedAt: now });
    }
    for (const row of relationshipWrites) {
      for (const id of [row.sourceNodeId, row.targetNodeId]) if (!nodeMap.has(id) || nodeMap.get(id)!.aliasTargetId) throw new Error('Relationship endpoint is outside canonical scope');
    }
    await lockTopologyInventoryReferences(normalized, bindingWrites, tx);
    const structuralChanged = clusters.length > 0
      || nodeWrites.some(n => structuralFingerprint('node', n) !== structuralFingerprint('node', oldNodesById.get(n.id!) ?? {}))
      || relationshipWrites.some(r => structuralFingerprint('relationship', r) !== structuralFingerprint('relationship', oldRelationshipsById.get(r.id!) ?? {}))
      || bindingWrites.some(b => structuralFingerprint('binding', b) !== structuralFingerprint('binding', oldBindingsById.get(b.id!) ?? {}));
    const accepted = await tx.execute(sql`UPDATE topology_site_state
      SET materialized_input_revision = ${staged.inputRevision}::bigint,
          graph_revision = graph_revision + CASE WHEN ${structuralChanged} THEN 1 ELSE 0 END,
          last_build_status = CASE WHEN dirty_revision > ${staged.inputRevision}::bigint THEN 'pending' ELSE 'complete' END,
          last_build_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
      WHERE org_id = ${normalized.orgId}::uuid AND site_id = ${normalized.siteId}::uuid
        AND build_fence = ${staged.buildFence}::bigint AND materialized_input_revision < ${staged.inputRevision}::bigint
      RETURNING graph_revision::text`);
    if (!accepted.length) return { published: false, graphRevision: state.graphRevision.toString() };
    const graphRevision = String(accepted[0]!.graph_revision);
    // All reference migrations and the guard share one transaction. Even a
    // late inventory FK or position failure rolls back the checkpoint.
    // Install every member before its final alias FK, including an existing
    // row whose globally selected target was first created in this batch.
    for (const row of nodeWrites) {
      const { id, ...changes } = row;
      if (oldNodesById.has(id!)) await tx.update(topologyNodes).set({ ...changes, aliasTargetId: null }).where(and(scopedWhere(topologyNodes, normalized), eq(topologyNodes.id, id!)));
      else await tx.insert(topologyNodes).values({ ...row, aliasTargetId: null });
    }
    for (const row of nodeWrites.filter(n => n.aliasTargetId)) await tx.update(topologyNodes).set({ aliasTargetId: row.aliasTargetId }).where(and(scopedWhere(topologyNodes, normalized), eq(topologyNodes.id, row.id!)));
    for (const row of relationshipWrites) {
      const { id, ...changes } = row;
      if (oldRelationshipsById.has(id!)) await tx.update(topologyRelationships).set({ ...changes, graphRevision: BigInt(graphRevision) }).where(and(scopedWhere(topologyRelationships, normalized), eq(topologyRelationships.id, id!)));
      else await tx.insert(topologyRelationships).values({ ...row, graphRevision: BigInt(graphRevision) });
    }
    for (const row of new Map(bindingWrites.map(b => [bindingKey(b), b])).values()) {
      const { id, ...changes } = row;
      if (oldBindingsById.has(id!)) await tx.update(topologyNodeBindings).set(changes).where(and(scopedWhere(topologyNodeBindings, normalized), eq(topologyNodeBindings.id, id!)));
      else await tx.insert(topologyNodeBindings).values(row);
    }
    const changedLayouts = new Set<string>();
    const positionsByNode = new Map<string, typeof positions>();
    for (const position of positions) {
      if (!positionsByNode.has(position.nodeId)) positionsByNode.set(position.nodeId, []);
      positionsByNode.get(position.nodeId)!.push(position);
    }
    for (const cluster of clusters) {
      // Tombstoned slots carry replay high-waters too. Transfer those fences
      // before removing the alias slot; neither retention nor alias resolution
      // may make an older source event eligible again.
      const aliases = new Set(cluster.aliasIds);
      const componentPositions = [cluster.canonicalId, ...cluster.aliasIds].flatMap(id => positionsByNode.get(id) ?? []);
      const affected = new Set(componentPositions.filter(p => aliases.has(p.nodeId)).map(p => p.layoutId));
      for (const layoutId of [...affected].sort()) {
        const chosen = planAliasClusterPosition(cluster.canonicalId, componentPositions.filter(p => p.layoutId === layoutId));
        await tx.insert(topologyNodePositions).values({ ...chosen, updatedAt: now }).onConflictDoUpdate({ target: [topologyNodePositions.layoutId, topologyNodePositions.nodeId], set: { x: chosen.x, y: chosen.y, pinned: chosen.pinned, positionSource: chosen.positionSource, updatedBy: chosen.updatedBy, deletedAt: chosen.deletedAt, revision: chosen.revision, legacySourceRevision: chosen.legacySourceRevision, updatedAt: now } });
        await tx.delete(topologyNodePositions).where(and(scopedWhere(topologyNodePositions, normalized), eq(topologyNodePositions.layoutId, layoutId), sql`${topologyNodePositions.nodeId} IN (${sql.join(cluster.aliasIds.map(id => sql`${id}::uuid`), sql`,`)})`));
        changedLayouts.add(layoutId);
      }
      for (const aliasId of cluster.aliasIds) {
        await tx.insert(auditLogs).values({ orgId: normalized.orgId, actorType: 'system', actorId: '00000000-0000-0000-0000-000000000000', action: 'topology.alias_merged', resourceType: 'topology_node', resourceId: cluster.canonicalId, result: 'success', initiatedBy: 'automation',
          details: { canonicalId: cluster.canonicalId, aliasId, labelOverride: cluster.labelOverride, notes: cluster.notes, siteId: normalized.siteId, evidence: 'accepted_link', inputRevision: staged.inputRevision, buildFence: staged.buildFence } });
      }
    }
    for (const layoutId of [...changedLayouts].sort()) await tx.update(topologyLayouts).set({ revision: sql`${topologyLayouts.revision} + 1`, updatedAt: now }).where(and(scopedWhere(topologyLayouts, normalized), eq(topologyLayouts.id, layoutId)));
    return { published: true, graphRevision };
  });
}
