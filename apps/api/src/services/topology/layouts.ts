import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { layoutPatchSchema, topologyViewSchema, type LayoutPatch, type LayoutWriteResult, type TopologyView } from '@breeze/shared';
import { db } from '../../db';
import { topologyLayout, topologyLayouts, topologyNodeBindings, topologyNodePositions, topologyNodes } from '../../db/schema';
import type { TopologyRequestContext } from './access';
import { auditTopologyWrite, lockLegacyTopologySourceRows, checkRevision, expectedRevisionSchema, missingTopologyEntity, parseWrite, scopedWrite, withTopologyWrite, TopologyWriteError } from './writes';

/** Saved layouts contain only real scoped nodes, and return only this batch. */
export async function saveTopologyLayout(ctx: TopologyRequestContext, view: TopologyView, input: LayoutPatch): Promise<LayoutWriteResult> {
  const patch = parseWrite(layoutPatchSchema.extend({ expectedRevision: expectedRevisionSchema }), input);
  parseWrite(topologyViewSchema, view);
  const ids = patch.positions.map(p => p.nodeId);
  if (new Set(ids).size !== ids.length) throw new TopologyWriteError('invalid_topology_mutation', 400, 'Duplicate topology position');
  return withTopologyWrite(ctx, true, async () => {
    if (ids.length) {
      const nodes = await db.select({ id: topologyNodes.id }).from(topologyNodes).where(and(scopedWrite(ctx.scope, topologyNodes), inArray(topologyNodes.id, ids), isNull(topologyNodes.deletedAt), isNull(topologyNodes.aliasTargetId)));
      if (nodes.length !== ids.length) throw missingTopologyEntity();
    }
    await db.insert(topologyLayouts).values({ ...ctx.scope, view }).onConflictDoNothing();
    const [layout] = await db.select().from(topologyLayouts).where(and(scopedWrite(ctx.scope, topologyLayouts), eq(topologyLayouts.view, view))).for('update');
    if (!layout) throw missingTopologyEntity();
    checkRevision(layout.revision, patch.expectedRevision, ids);
    if (!ids.length) return { siteId: ctx.scope.siteId, view, layoutRevision: layout.revision.toString(), positions: [] };
    const [updated] = await db.update(topologyLayouts).set({ revision: sql`${topologyLayouts.revision}+1`, updatedAt: new Date() }).where(and(scopedWrite(ctx.scope, topologyLayouts), eq(topologyLayouts.id, layout.id), eq(topologyLayouts.revision, BigInt(patch.expectedRevision)))).returning();
    if (!updated) throw new TopologyWriteError('topology_revision_conflict', 409, 'Topology layout changed');
    const accepted: LayoutWriteResult['positions'] = [];
    for (const p of patch.positions) {
      const [saved] = await db.insert(topologyNodePositions).values({ ...ctx.scope, layoutId: layout.id, ...p, positionSource: 'user', revision: 1n, updatedBy: ctx.auth.user.id })
        .onConflictDoUpdate({ target: [topologyNodePositions.layoutId, topologyNodePositions.nodeId], set: { x: p.x, y: p.y, pinned: p.pinned, positionSource: 'user', revision: sql`${topologyNodePositions.revision}+1`, updatedBy: ctx.auth.user.id, deletedAt: null, updatedAt: new Date() } }).returning();
      if (!saved) throw missingTopologyEntity();
      accepted.push({ nodeId: p.nodeId, x: p.x, y: p.y, pinned: p.pinned, source: 'user', rowRevision: saved.revision.toString() });
      // The legacy canvas has one coordinate set. It is Overview only; other
      // views cannot overwrite its arrangement during rollback.
      if (view === 'overview') {
        const bindings = await db.select().from(topologyNodeBindings).where(and(scopedWrite(ctx.scope, topologyNodeBindings), eq(topologyNodeBindings.nodeId, p.nodeId)));
        for (const binding of bindings) {
          const nodeId = binding.manualNodeId ?? binding.discoveredAssetId;
          if (!nodeId) continue;
          const nodeType = binding.manualNodeId ? 'manual_node' : 'discovered_asset';
          await lockLegacyTopologySourceRows(ctx.scope, 'topology_layout', and(eq(topologyLayout.nodeType, nodeType), eq(topologyLayout.nodeId, nodeId))!);
          await db.insert(topologyLayout).values({ ...ctx.scope, nodeType, nodeId, x: p.x, y: p.y, pinned: p.pinned, updatedBy: ctx.auth.user.id })
            .onConflictDoUpdate({ target: [topologyLayout.siteId, topologyLayout.nodeType, topologyLayout.nodeId], set: { x: p.x, y: p.y, pinned: p.pinned, updatedBy: ctx.auth.user.id, updatedAt: new Date() } });
        }
      }
    }
    await auditTopologyWrite(ctx, 'layout.saved', layout.id, { view, revision: updated.revision.toString(), nodeIds: ids });
    return { siteId: ctx.scope.siteId, view, layoutRevision: updated.revision.toString(), positions: accepted };
  });
}
