import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { discoveredAssets, topologyManualNodes, topologyNodes, topologyLayout } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { getUserPermissions, type UserPermissions } from '../permissions';
import { requireTopologySiteAccess, TopologyError, type TopologyRequestContext } from './access';
import { tombstoneManualDependencies, lockLegacyManualNodeRows } from './manual';
import { readWriteState, scopedWrite, withTopologyWrite, missingTopologyEntity, auditTopologyWrite, lockLegacyTopologySourceRows } from './writes';

/** Existing clients have no revision field. Serialize their explicit writes
 * under the same site lock, replaying into a ready graph in this transaction.
 * An uninitialized site remains capture-only; this path never starts import. */
export async function withLegacyTopologyWrite<T>(auth: AuthContext, permissions: UserPermissions | undefined, scope: TopologyScope,
  work: (ctx: TopologyRequestContext) => Promise<T>, deletedManualNodeId?: string): Promise<T> {
  const currentPermissions = permissions ?? await getUserPermissions(auth.user.id, { partnerId: auth.partnerId ?? undefined, orgId: auth.orgId ?? undefined, scope: auth.scope });
  if (!currentPermissions) throw new TopologyError('topology_permission_denied', 403, 'Topology permission denied');
  const ctx = await requireTopologySiteAccess(auth, currentPermissions, scope.siteId, 'write');
  if (ctx.scope.orgId !== scope.orgId) throw missingTopologyEntity();
  return withTopologyWrite(ctx, false, async ready => {
    if (deletedManualNodeId) await lockLegacyManualNodeRows(ctx, deletedManualNodeId);
    const result = await work(ctx);
    if (ready && deletedManualNodeId) {
      const [node] = await db.select({ id: topologyNodes.id }).from(topologyNodes).where(and(scopedWrite(scope, topologyNodes), eq(topologyNodes.legacySourceType, 'topology_manual_nodes'), eq(topologyNodes.legacySourceId, deletedManualNodeId), isNull(topologyNodes.deletedAt)));
      if (node) {
        const fence = (await readWriteState(scope)).dirtyRevision;
        await tombstoneManualDependencies(ctx, node.id, fence);
        await auditTopologyWrite(ctx, 'node.deleted', node.id, { legacyId: deletedManualNodeId, sourceRevision: fence.toString(), origin: 'legacy' });
      }
    }
    return result;
  });
}
export async function requireLegacyLayoutNodes(ctx: TopologyRequestContext, positions: { nodeType: 'discovered_asset' | 'manual_node'; nodeId: string }[]) {
  for (const nodeType of ['manual_node', 'discovered_asset'] as const) {
    const ids = [...new Set(positions.filter(p => p.nodeType === nodeType).map(p => p.nodeId))];
    if (!ids.length) continue;
    const table = nodeType === 'manual_node' ? topologyManualNodes : discoveredAssets;
    const nodes = await db.select({ id: table.id }).from(table).where(and(eq(table.orgId, ctx.scope.orgId), eq(table.siteId, ctx.scope.siteId), inArray(table.id, ids)));
    if (nodes.length !== ids.length) throw missingTopologyEntity();
    await lockLegacyTopologySourceRows(ctx.scope, 'topology_layout', and(eq(topologyLayout.nodeType, nodeType), inArray(topologyLayout.nodeId, ids))!);
  }
}
