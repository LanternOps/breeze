import { and, eq, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { assertInTransaction, db } from '../../db';
import { auditLogs, topologyNodeBindings, topologyNodes, topologySiteState } from '../../db/schema';
import { normalizedTopologyScope } from './identity';
import { lockTopologyInventoryReferences } from './inventoryLocks';

type SourceNode = Pick<typeof topologyNodes.$inferSelect, 'id' | 'orgId' | 'siteId' | 'kind' | 'createdAt' | 'identityMaterial' | 'legacySourceType' | 'legacySourceId' | 'aliasTargetId' | 'lifecycle' | 'deletedAt'>;
type SourceBinding = Pick<typeof topologyNodeBindings.$inferSelect, 'id' | 'orgId' | 'siteId' | 'nodeId' | 'deviceId' | 'discoveredAssetId' | 'manualNodeId'>;
export type SplitInventoryAsset = { id: string; linkedDeviceId: string | null; suppressedAt: Date | null };
type SplitInput = { nodes: SourceNode[]; bindings: SourceBinding[]; liveDeviceIds: Set<string>; liveAssets: SplitInventoryAsset[] };
type NodeChange = { id: string; aliasTargetId: string | null };
type BindingMove = { id: string; fromNodeId: string; toNodeId: string; deviceId: string | null; discoveredAssetId: string | null };
type SplitCluster = { previousCanonicalId: string; canonicalIds: string[]; retainedSourceNodeIds: string[] };

/** Partition an existing alias cluster using retained source identity and the
 * CURRENT accepted inventory relation. This deliberately does not merge roots,
 * infer source identity from bindings/IP/name, or relocate historical facts. */
export function planLegacyIdentitySplits(scope: TopologyScope, input: SplitInput): { nodeChanges: NodeChange[]; bindingMoves: BindingMove[]; clusters: SplitCluster[] } {
  const normalized = normalizedTopologyScope(scope);
  const byId = new Map(input.nodes.map(node => [node.id, node]));
  for (const row of [...input.nodes, ...input.bindings]) if (row.orgId !== normalized.orgId || row.siteId !== normalized.siteId) throw new Error('Identity split scope mismatch');
  const assetById = new Map(input.liveAssets.map(asset => [asset.id, asset]));
  const rootOf = (node: SourceNode): string => {
    const visited = new Set<string>();
    let current = node;
    while (current.aliasTargetId) {
      if (visited.has(current.id)) throw new Error('Canonical alias cycle');
      visited.add(current.id);
      const parent = byId.get(current.aliasTargetId);
      if (!parent) throw new Error('Canonical alias is outside split scope');
      current = parent;
    }
    return current.id;
  };
  const sourceReference = (node: SourceNode): string | null => {
    if (node.kind !== 'endpoint' || !node.legacySourceId || !['devices', 'discovered_assets'].includes(node.legacySourceType ?? '')) return null;
    // This exception is for retained importer source nodes, never a general
    // permission to resurrect an arbitrary publisher alias.
    if (node.identityMaterial.sourceKey !== `legacy:${node.legacySourceType}:${node.legacySourceId}`) return null;
    return `${node.legacySourceType}:${node.legacySourceId}`;
  };
  const componentOf = (reference: string): string | null => {
    const [table, id] = reference.split(':') as [string, string];
    if (table === 'devices') return input.liveDeviceIds.has(id) ? `device:${id}` : null;
    const asset = assetById.get(id);
    if (!asset) return null;
    return asset.linkedDeviceId && !asset.suppressedAt && input.liveDeviceIds.has(asset.linkedDeviceId)
      ? `device:${asset.linkedDeviceId}` : `asset:${id}`;
  };
  const roots = new Map<string, SourceNode[]>();
  for (const node of input.nodes) {
    const root = rootOf(node);
    const members = roots.get(root);
    if (members) members.push(node); else roots.set(root, [node]);
  }
  const bindingsByRoot = new Map<string, SourceBinding[]>();
  for (const binding of input.bindings) {
    const node = byId.get(binding.nodeId);
    if (!node) throw new Error('Inventory binding is outside split scope');
    const root = rootOf(node);
    const bindings = bindingsByRoot.get(root);
    if (bindings) bindings.push(binding); else bindingsByRoot.set(root, [binding]);
  }
  const nodeChanges: NodeChange[] = [];
  const bindingMoves: BindingMove[] = [];
  const clusters: SplitCluster[] = [];
  for (const [previousCanonicalId, members] of roots) {
    if (members.length < 2) continue;
    const components = new Map<string, SourceNode[]>();
    const liveSources = new Map<string, SourceNode>();
    for (const node of members) {
      const reference = sourceReference(node);
      const component = reference && componentOf(reference);
      if (!reference || !component) continue;
      if (liveSources.has(reference)) throw new Error('Ambiguous retained inventory source identity');
      liveSources.set(reference, node);
      const componentNodes = components.get(component);
      if (componentNodes) componentNodes.push(node); else components.set(component, [node]);
    }
    const nodeCountBefore = nodeChanges.length;
    const bindingCountBefore = bindingMoves.length;
    const desiredCanonical = new Map<string, string>();
    for (const componentNodes of components.values()) {
      const canonical = [...componentNodes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]!;
      for (const node of componentNodes) {
        desiredCanonical.set(node.id, canonical.id);
        const aliasTargetId = node.id === canonical.id ? null : canonical.id;
        if (node.aliasTargetId !== aliasTargetId) nodeChanges.push({ id: node.id, aliasTargetId });
      }
    }
    for (const binding of bindingsByRoot.get(previousCanonicalId) ?? []) {
      const reference = binding.deviceId ? `devices:${binding.deviceId}` : binding.discoveredAssetId ? `discovered_assets:${binding.discoveredAssetId}` : null;
      const sourceNode = reference && liveSources.get(reference);
      const toNodeId = sourceNode && desiredCanonical.get(sourceNode.id);
      if (toNodeId && toNodeId !== binding.nodeId) bindingMoves.push({ id: binding.id, fromNodeId: binding.nodeId, toNodeId, deviceId: binding.deviceId, discoveredAssetId: binding.discoveredAssetId });
    }
    if (nodeCountBefore !== nodeChanges.length || bindingCountBefore !== bindingMoves.length) clusters.push({ previousCanonicalId,
      canonicalIds: [...new Set(desiredCanonical.values())].sort(), retainedSourceNodeIds: [...desiredCanonical.keys()].sort() });
  }
  return { nodeChanges, bindingMoves, clusters };
}

/** The importer owns the surrounding publication transaction/site lock. It
 * may restore retained source aliases only when current inventory has revoked
 * their association. Relationships, manual metadata and layout stay at their
 * existing IDs; inferring which historical fact belongs to which side is unsafe. */
export async function splitRevokedLegacyInventoryLinks(scope: TopologyScope, input: SplitInput, expectedFence: bigint) {
  assertInTransaction('splitRevokedLegacyInventoryLinks');
  const plan = planLegacyIdentitySplits(scope, input);
  const where = and(eq(topologySiteState.orgId, scope.orgId), eq(topologySiteState.siteId, scope.siteId));
  const [state] = await db.select().from(topologySiteState).where(where).for('update');
  if (!state || state.buildFence !== expectedFence) throw new Error('Legacy identity split was fenced');
  if (!plan.clusters.length) return { changed: false, buildFence: expectedFence, graphRevision: state.graphRevision };
  // Fail fast if a concurrent delete/key move already owns an inventory row;
  // never wait here while holding the capture/site-state lock.
  await lockTopologyInventoryReferences(scope, plan.bindingMoves);
  const now = new Date();
  // Restore representatives before retargeting remaining aliases. Lifecycle
  // and source tombstones belong to revision-fenced replay, never to a
  // current-inventory read (the same source UUID may have been recreated).
  for (const change of [...plan.nodeChanges].sort((a, b) => Number(a.aliasTargetId !== null) - Number(b.aliasTargetId !== null) || a.id.localeCompare(b.id))) {
    await db.update(topologyNodes).set({ aliasTargetId: change.aliasTargetId, revision: sql`${topologyNodes.revision}+1`, updatedAt: now })
      .where(and(eq(topologyNodes.orgId, scope.orgId), eq(topologyNodes.siteId, scope.siteId), eq(topologyNodes.id, change.id)));
  }
  for (const move of plan.bindingMoves) await db.update(topologyNodeBindings).set({ nodeId: move.toNodeId, updatedAt: now })
    .where(and(eq(topologyNodeBindings.orgId, scope.orgId), eq(topologyNodeBindings.siteId, scope.siteId), eq(topologyNodeBindings.id, move.id)));
  const buildFence = state.buildFence + 1n;
  await db.update(topologySiteState).set({ buildFence, updatedAt: now }).where(where);
  for (const cluster of plan.clusters) await db.insert(auditLogs).values({ orgId: scope.orgId, actorType: 'system', actorId: '00000000-0000-0000-0000-000000000000',
    action: 'topology.alias_split', resourceType: 'topology_node', resourceId: cluster.previousCanonicalId, result: 'success', initiatedBy: 'automation',
    details: { ...cluster, siteId: scope.siteId, reason: 'inventory_link_revoked', buildFence: buildFence.toString(), movedBindingIds: plan.bindingMoves.filter(move => move.fromNodeId === cluster.previousCanonicalId).map(move => move.id).sort() } });
  // Publisher may also change labels or tombstones in this same transaction.
  // The caller ensures one graph revision for the combined structural change.
  return { changed: true, buildFence, graphRevision: state.graphRevision };
}
