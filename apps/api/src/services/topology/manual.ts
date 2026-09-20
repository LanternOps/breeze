import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { relationshipKindSchema } from '@breeze/shared';
import { z } from 'zod';
import { db } from '../../db';
import { topologyManualNodes, topologyNodes, topologyNodeBindings, topologyRelationships, networkTopology, topologyLayout, topologyNodePositions, topologyLayouts } from '../../db/schema';
import type { TopologyRequestContext } from './access';
import { canonicalIdentityKey } from './identity';
import { enqueueTopologyChange, type TopologyTransaction } from './legacyCapture';
import { projectLegacyNode, stableLegacyId } from './legacyProjection';
import { auditTopologyWrite, lockLegacyTopologySourceRows, bumpStructuralRevision, checkRevision, expectedRevisionSchema, missingTopologyEntity, parseWrite, readWriteState, scopedWrite, TopologyWriteError, withTopologyWrite } from './writes';
export { expectedRevisionSchema } from './writes';

const uuid = z.string().uuid();
const role = z.enum(['switch', 'router', 'ap', 'firewall', 'patch_panel', 'other']);
const label = z.string().trim().min(1).max(255);
const notes = z.string().max(8192);
const prefix = z.string().max(128).refine(value => {
  const parts = value.split('/');
  const family = isIP(parts[0] ?? '');
  return parts.length === 2 && family !== 0 && /^(0|[1-9]\d*)$/.test(parts[1]!) && Number(parts[1]) <= (family === 4 ? 32 : 128);
});
export const createManualNodeSchema = z.object({ label, role, notes: notes.optional(), prefix: prefix.optional() }).strict();
export const updateManualNodeSchema = z.object({ expectedRevision: expectedRevisionSchema, label: label.optional(), role: role.optional(), notes: notes.optional() }).strict()
  .refine(v => v.label !== undefined || v.role !== undefined || v.notes !== undefined);
export const deleteManualSchema = z.object({ expectedRevision: expectedRevisionSchema }).strict();
export const createManualRelationshipSchema = z.object({ sourceNodeId: uuid, targetNodeId: uuid, kind: relationshipKindSchema,
  sourceInterfaceId: uuid.optional(), targetInterfaceId: uuid.optional(), label: label.optional(), notes: notes.optional(),
}).strict().refine(v => v.sourceNodeId !== v.targetNodeId);
export type ManualNodeInput = z.infer<typeof createManualNodeSchema>;
export type ManualRelationshipInput = z.infer<typeof createManualRelationshipSchema>;
export type ManualWriteResult = { id: string; legacyId: string | null; revision: string; graphRevision: string };

async function activeNode(ctx: TopologyRequestContext, id: string, manual = false) {
  parseWrite(uuid, id);
  const [node] = await db.select().from(topologyNodes).where(and(scopedWrite(ctx.scope, topologyNodes), eq(topologyNodes.id, id), isNull(topologyNodes.deletedAt), isNull(topologyNodes.aliasTargetId)));
  if (!node || (manual && (node.kind !== 'manual' || node.legacySourceType !== 'topology_manual_nodes' || !node.legacySourceId))) throw missingTopologyEntity();
  return node;
}
export async function createTopologyManualNode(ctx: TopologyRequestContext, input: ManualNodeInput): Promise<ManualWriteResult> {
  const value = parseWrite(createManualNodeSchema, input);
  return withTopologyWrite(ctx, true, async () => {
    const [legacy] = await db.insert(topologyManualNodes).values({ ...ctx.scope, label: value.label, role: value.role, notes: value.notes ?? null, createdBy: ctx.auth.user.id }).returning();
    if (!legacy) throw missingTopologyEntity();
    const fence = (await readWriteState(ctx.scope)).dirtyRevision;
    const projected = projectLegacyNode(ctx.scope, { sourceTable: 'topology_manual_nodes', sourceId: legacy.id, sourceRevision: fence.toString(), data: legacy });
    const [node] = await db.insert(topologyNodes).values({ ...projected, revision: 1n, attributes: { ...projected.attributes, ...(value.prefix ? { prefix: value.prefix, addressFamily: isIP(value.prefix.split('/')[0]!) as 4 | 6 } : {}) } }).returning();
    if (!node) throw missingTopologyEntity();
    await db.insert(topologyNodeBindings).values({ ...ctx.scope, nodeId: node.id, manualNodeId: legacy.id, provenance: { method: 'manual', sourceId: legacy.id, createdBy: ctx.auth.user.id } });
    const graphRevision = await bumpStructuralRevision(ctx.scope);
    await auditTopologyWrite(ctx, 'node.created', node.id, { legacyId: legacy.id, revision: '1' });
    return { id: node.id, legacyId: legacy.id, revision: '1', graphRevision: graphRevision.toString() };
  });
}
export async function updateTopologyManualNode(ctx: TopologyRequestContext, id: string, input: z.infer<typeof updateManualNodeSchema>): Promise<ManualWriteResult> {
  const value = parseWrite(updateManualNodeSchema, input);
  return withTopologyWrite(ctx, true, async () => {
    const node = await activeNode(ctx, id, true);
    checkRevision(node.revision, value.expectedRevision, [id]);
    const next = { label: value.label ?? node.labelOverride ?? node.attributes.label ?? '', role: value.role ?? node.role!, notes: value.notes ?? node.attributes.notes ?? '' };
    const changed = next.label !== node.labelOverride || next.role !== node.role || next.notes !== (node.attributes.notes ?? '');
    if (!changed) return { id, legacyId: node.legacySourceId, revision: node.revision.toString(), graphRevision: (await readWriteState(ctx.scope)).graphRevision.toString() };
    await lockLegacyTopologySourceRows(ctx.scope, 'topology_manual_nodes', eq(topologyManualNodes.id, node.legacySourceId!));
    const updated = await db.update(topologyManualNodes).set({ ...next, updatedAt: new Date() }).where(and(scopedWrite(ctx.scope, topologyManualNodes), eq(topologyManualNodes.id, node.legacySourceId!))).returning();
    if (!updated.length) throw missingTopologyEntity();
    const fence = (await readWriteState(ctx.scope)).dirtyRevision;
    await db.update(topologyNodes).set({ labelOverride: next.label, role: next.role, attributes: { ...node.attributes, label: next.label, notes: next.notes }, revision: node.revision + 1n, legacySourceRevision: fence, updatedAt: new Date() }).where(and(scopedWrite(ctx.scope, topologyNodes), eq(topologyNodes.id, id)));
    const graphRevision = await bumpStructuralRevision(ctx.scope);
    await auditTopologyWrite(ctx, 'node.updated', id, { revision: (node.revision + 1n).toString() });
    return { id, legacyId: node.legacySourceId, revision: (node.revision + 1n).toString(), graphRevision: graphRevision.toString() };
  });
}

/** Remove only hand-authored dependencies. Independently measured rows are
 * retained against the tombstoned identity, preserving their history. */
export async function tombstoneManualDependencies(ctx: TopologyRequestContext, nodeId: string, fence: bigint) {
  const now = new Date();
  await db.update(topologyRelationships).set({ lifecycle: 'withdrawn', deletedAt: now, revision: sql`${topologyRelationships.revision}+1`, legacySourceRevision: fence, updatedAt: now })
    .where(and(scopedWrite(ctx.scope, topologyRelationships), isNull(topologyRelationships.deletedAt), eq(topologyRelationships.evidenceClass, 'manual'), eq(topologyRelationships.supportCount, 0n), or(eq(topologyRelationships.sourceNodeId, nodeId), eq(topologyRelationships.targetNodeId, nodeId))));
  const positions = await db.update(topologyNodePositions).set({ deletedAt: now, revision: sql`${topologyNodePositions.revision}+1`, legacySourceRevision: fence, updatedAt: now })
    .where(and(scopedWrite(ctx.scope, topologyNodePositions), eq(topologyNodePositions.nodeId, nodeId), isNull(topologyNodePositions.deletedAt))).returning({ layoutId: topologyNodePositions.layoutId });
  for (const layoutId of [...new Set(positions.map(p => p.layoutId))].sort()) {
    await db.update(topologyLayouts).set({ revision: sql`${topologyLayouts.revision}+1`, updatedAt: now }).where(and(scopedWrite(ctx.scope, topologyLayouts), eq(topologyLayouts.id, layoutId)));
  }
}
export async function deleteTopologyManualNode(ctx: TopologyRequestContext, id: string, input: z.infer<typeof deleteManualSchema>): Promise<ManualWriteResult> {
  const value = parseWrite(deleteManualSchema, input);
  return withTopologyWrite(ctx, true, async () => {
    const node = await activeNode(ctx, id, true);
    checkRevision(node.revision, value.expectedRevision, [id]);
    await deleteLegacyManualNodeRows(ctx, node.legacySourceId!);
    const fence = (await readWriteState(ctx.scope)).dirtyRevision;
    await tombstoneManualDependencies(ctx, id, fence);
    await db.update(topologyNodes).set({ deletedAt: new Date(), lifecycle: 'withdrawn', revision: node.revision + 1n, legacySourceRevision: fence, updatedAt: new Date() }).where(and(scopedWrite(ctx.scope, topologyNodes), eq(topologyNodes.id, id)));
    const graphRevision = await bumpStructuralRevision(ctx.scope);
    await auditTopologyWrite(ctx, 'node.deleted', id, { legacyId: node.legacySourceId, revision: (node.revision + 1n).toString(), sourceRevision: fence.toString() });
    return { id, legacyId: node.legacySourceId, revision: (node.revision + 1n).toString(), graphRevision: graphRevision.toString() };
  });
}
export async function lockLegacyManualNodeRows(ctx: TopologyRequestContext, legacyId: string) {
  await lockLegacyTopologySourceRows(ctx.scope, 'topology_manual_nodes', eq(topologyManualNodes.id, legacyId));
  await lockLegacyTopologySourceRows(ctx.scope, 'network_topology', and(eq(networkTopology.method, 'manual'), or(
    and(eq(networkTopology.sourceType, 'manual_node'), eq(networkTopology.sourceId, legacyId)), and(eq(networkTopology.targetType, 'manual_node'), eq(networkTopology.targetId, legacyId))))!);
  await lockLegacyTopologySourceRows(ctx.scope, 'topology_layout', and(eq(topologyLayout.nodeType, 'manual_node'), eq(topologyLayout.nodeId, legacyId))!);
}
export async function deleteLegacyManualNodeRows(ctx: TopologyRequestContext, legacyId: string) {
  await lockLegacyManualNodeRows(ctx, legacyId);
  await db.delete(networkTopology).where(and(scopedWrite(ctx.scope, networkTopology), eq(networkTopology.method, 'manual'), or(
    and(eq(networkTopology.sourceType, 'manual_node'), eq(networkTopology.sourceId, legacyId)), and(eq(networkTopology.targetType, 'manual_node'), eq(networkTopology.targetId, legacyId)))));
  await db.delete(topologyLayout).where(and(scopedWrite(ctx.scope, topologyLayout), eq(topologyLayout.nodeType, 'manual_node'), eq(topologyLayout.nodeId, legacyId)));
  await db.delete(topologyManualNodes).where(and(scopedWrite(ctx.scope, topologyManualNodes), eq(topologyManualNodes.id, legacyId)));
}

async function legacyEndpoint(ctx: TopologyRequestContext, nodeId: string) {
  const bindings = await db.select().from(topologyNodeBindings).where(and(scopedWrite(ctx.scope, topologyNodeBindings), eq(topologyNodeBindings.nodeId, nodeId)));
  const manual = bindings.find(b => b.manualNodeId);
  if (manual?.manualNodeId) return { type: 'manual_node', id: manual.manualNodeId };
  const asset = bindings.find(b => b.discoveredAssetId);
  return asset?.discoveredAssetId ? { type: 'discovered_asset', id: asset.discoveredAssetId } : null;
}
export async function createTopologyManualRelationship(ctx: TopologyRequestContext, input: ManualRelationshipInput): Promise<ManualWriteResult> {
  const value = parseWrite(createManualRelationshipSchema, input);
  if (value.sourceInterfaceId || value.targetInterfaceId) throw new TopologyWriteError('capability_unavailable', 409, 'Interface binding is not available');
  return withTopologyWrite(ctx, true, async () => {
    await activeNode(ctx, value.sourceNodeId); await activeNode(ctx, value.targetNodeId);
    const [duplicate] = await db.select({ id: topologyRelationships.id }).from(topologyRelationships).where(and(scopedWrite(ctx.scope, topologyRelationships),
      eq(topologyRelationships.sourceNodeId, value.sourceNodeId), eq(topologyRelationships.targetNodeId, value.targetNodeId), eq(topologyRelationships.kind, value.kind),
      eq(topologyRelationships.evidenceClass, 'manual'), isNull(topologyRelationships.deletedAt))).limit(1);
    if (duplicate) throw new TopologyWriteError('topology_relationship_exists', 409, 'A manual relationship already connects these nodes');
    const source = await legacyEndpoint(ctx, value.sourceNodeId); const target = await legacyEndpoint(ctx, value.targetNodeId);
    let legacyId: string | null = null;
    if (value.kind === 'attachment' && source && target) {
      await lockLegacyTopologySourceRows(ctx.scope, 'network_topology', and(eq(networkTopology.sourceType, source.type), eq(networkTopology.sourceId, source.id),
        eq(networkTopology.targetType, target.type), eq(networkTopology.targetId, target.id), eq(networkTopology.method, 'manual'))!);
      const [legacy] = await db.insert(networkTopology).values({ ...ctx.scope, sourceType: source.type, sourceId: source.id, targetType: target.type, targetId: target.id, method: 'manual', confidence: 'asserted', connectionType: 'manual', createdBy: ctx.auth.user.id }).onConflictDoNothing().returning();
      if (!legacy) throw new TopologyWriteError('topology_relationship_exists', 409, 'A manual relationship already connects these nodes');
      legacyId = legacy.id;
    }
    const sourceKey = legacyId ? `legacy:network_topology:${legacyId}` : `manual:${randomUUID()}`;
    const canonicalKey = canonicalIdentityKey(ctx.scope, value.kind, sourceKey);
    const id = stableLegacyId(canonicalKey);
    if (!legacyId) await enqueueTopologyChange(db as unknown as TopologyTransaction, ctx.scope, { version: 1, type: 'relationship.upsert', sourceTable: 'v2_intents', sourceId: id, oldIdentity: null, newIdentity: { ...ctx.scope, sourceId: id }, idempotencyKey: `manual:${id}:create`, data: { sourceType: 'canonical', sourceId: value.sourceNodeId, targetType: 'canonical', targetId: value.targetNodeId, connectionType: value.kind, interfaceName: null, vlan: null, bandwidth: null, method: 'manual', createdBy: ctx.auth.user.id } });
    const fence = (await readWriteState(ctx.scope)).dirtyRevision;
    const graphRevision = await bumpStructuralRevision(ctx.scope);
    await db.insert(topologyRelationships).values({ ...ctx.scope, id, canonicalKey, identityMaterial: { version: 1, kind: value.kind, sourceKey }, kind: value.kind, sourceNodeId: value.sourceNodeId, targetNodeId: value.targetNodeId,
      confidence: 'asserted', evidenceClass: 'manual', directness: 'unknown', attributes: { method: 'manual', createdBy: ctx.auth.user.id, ...(value.label ? { label: value.label } : {}), ...(value.notes !== undefined ? { notes: value.notes } : {}) },
      revision: 1n, graphRevision, legacySourceType: legacyId ? 'network_topology' : null, legacySourceId: legacyId, legacySourceRevision: legacyId ? fence : null });
    await auditTopologyWrite(ctx, 'relationship.created', id, { legacyId, revision: '1', kind: value.kind });
    return { id, legacyId, revision: '1', graphRevision: graphRevision.toString() };
  });
}
export async function deleteTopologyManualRelationship(ctx: TopologyRequestContext, id: string, input: z.infer<typeof deleteManualSchema>): Promise<ManualWriteResult> {
  parseWrite(uuid, id); const value = parseWrite(deleteManualSchema, input);
  return withTopologyWrite(ctx, true, async () => {
    const [row] = await db.select().from(topologyRelationships).where(and(scopedWrite(ctx.scope, topologyRelationships), eq(topologyRelationships.id, id), isNull(topologyRelationships.deletedAt), eq(topologyRelationships.evidenceClass, 'manual')));
    if (!row) throw missingTopologyEntity();
    checkRevision(row.revision, value.expectedRevision, [id]);
    // M0 stores separate manual and measured rows. A future mixed-support row
    // needs the support service; never destroy that independent evidence here.
    if (row.supportCount > 0n) throw new TopologyWriteError('capability_unavailable', 409, 'Independent relationship support must be preserved');
    if (row.legacySourceId && row.legacySourceType === 'network_topology') {
      await lockLegacyTopologySourceRows(ctx.scope, 'network_topology', eq(networkTopology.id, row.legacySourceId));
      await db.delete(networkTopology).where(and(scopedWrite(ctx.scope, networkTopology), eq(networkTopology.id, row.legacySourceId), eq(networkTopology.method, 'manual')));
    }
    else await enqueueTopologyChange(db as unknown as TopologyTransaction, ctx.scope, { version: 1, type: 'relationship.delete', sourceTable: 'v2_intents', sourceId: id, oldIdentity: { ...ctx.scope, sourceId: id }, newIdentity: null, idempotencyKey: `manual:${id}:delete:${value.expectedRevision}`, data: null });
    const fence = (await readWriteState(ctx.scope)).dirtyRevision;
    const graphRevision = await bumpStructuralRevision(ctx.scope);
    await db.update(topologyRelationships).set({ deletedAt: new Date(), lifecycle: 'withdrawn', revision: row.revision + 1n, graphRevision, legacySourceRevision: row.legacySourceId ? fence : null, updatedAt: new Date() }).where(and(scopedWrite(ctx.scope, topologyRelationships), eq(topologyRelationships.id, id)));
    await auditTopologyWrite(ctx, 'relationship.deleted', id, { legacyId: row.legacySourceId, sourceRevision: fence.toString() });
    return { id, legacyId: row.legacySourceId, revision: (row.revision + 1n).toString(), graphRevision: graphRevision.toString() };
  });
}
