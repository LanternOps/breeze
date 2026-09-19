import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { closeDb, withDbAccessContext } from '../../db';
import { auditLogs, devices, discoveredAssets, networkTopology, topologyLayouts, topologyManualNodes, topologyNodeBindings, topologyNodePositions, topologyNodes, topologyRelationships, topologySiteState, topologyChangeOutbox } from '../../db/schema';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { publishTopologyBuild, type NodePublication } from '../../services/topology/publish';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());
const scoped = <T>(scope: TopologyScope, work: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), work);
const state = async (scope: TopologyScope) => (await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)))[0]!;
const drain = (scope: TopologyScope) => scoped(scope, () => drainTopologyOutbox(scope, { batchSize: 1000 }));
async function fixture(linked = false) {
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const database = getTestDb();
  const [device] = await database.insert(devices).values({ ...scope, agentId: randomUUID(), hostname: 'cluster device', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' }).returning();
  const assets = await database.insert(discoveredAssets).values([1, 2].map(n => ({ ...scope, ipAddress: `192.0.2.${n}`, hostname: `cluster asset ${n}`, linkedDeviceId: linked ? device!.id : null }))).returning();
  const [peer] = await database.insert(topologyManualNodes).values({ ...scope, label: 'Manual peer', role: 'switch' }).returning();
  await database.insert(networkTopology).values(assets.map(asset => ({ ...scope, sourceType: 'discovered_asset', sourceId: asset.id, targetType: 'manual_node', targetId: peer!.id, method: 'manual', confidence: 'asserted', connectionType: 'wired' })));
  expect((await scoped(scope, () => importLegacyTopologySite(scope, { batchSize: 1000 }))).complete).toBe(true);
  const nodes = await database.select().from(topologyNodes).where(eq(topologyNodes.siteId, scope.siteId));
  const deviceNode = nodes.find(n => n.legacySourceId === device!.id)!;
  const assetNodes = assets.map(asset => nodes.find(n => n.legacySourceId === asset.id)!);
  return { scope, device: device!, assets, deviceNode, assetNodes, nodes };
}
async function linkAll(f: Awaited<ReturnType<typeof fixture>>) {
  for (const asset of f.assets) await getTestDb().update(discoveredAssets).set({ linkedDeviceId: f.device.id, linkSource: 'manual' }).where(eq(discoveredAssets.id, asset.id));
}
async function makeAssetOldest(f: Awaited<ReturnType<typeof fixture>>) {
  for (const [node, year] of [[f.deviceNode, 2022], [f.assetNodes[0]!, 2020], [f.assetNodes[1]!, 2021]] as const) {
    await getTestDb().update(topologyNodes).set({ createdAt: new Date(`${year}-01-01`) }).where(eq(topologyNodes.id, node.id));
  }
}
const audits = (scope: TopologyScope) => getTestDb().select().from(auditLogs).where(and(eq(auditLogs.orgId, scope.orgId), eq(auditLogs.action, 'topology.alias_merged')));

describe('atomic accepted inventory alias clusters', () => {
  it('imports D plus A1/A2 already linked in the same batch into one oldest endpoint and one structural revision', async () => {
    const f = await fixture(true); const database = getTestDb();
    const endpoints = f.nodes.filter(n => n.kind === 'endpoint');
    const canonicalId = [...endpoints].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]!.id;
    expect(endpoints).toHaveLength(3);
    expect(endpoints.filter(n => !n.aliasTargetId).map(n => n.id)).toEqual([canonicalId]);
    expect(endpoints.filter(n => n.aliasTargetId).every(n => n.aliasTargetId === canonicalId)).toBe(true);
    const bindings = await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, f.scope.siteId));
    expect(bindings.filter(b => b.deviceId || b.discoveredAssetId).map(b => b.nodeId)).toEqual([canonicalId, canonicalId, canonicalId]);
    expect((await state(f.scope)).graphRevision).toBe(1n);
    const relations = await database.select().from(topologyRelationships).where(eq(topologyRelationships.siteId, f.scope.siteId));
    expect(relations).toHaveLength(2); expect(relations.every(r => r.sourceNodeId === canonicalId && r.evidenceClass === 'manual')).toBe(true);
    expect(await audits(f.scope)).toHaveLength(2);
    const before = await state(f.scope);
    await drain(f.scope);
    expect(await state(f.scope)).toEqual(before); expect(await audits(f.scope)).toHaveLength(2);
  });

  it('combines all original pins/fences into the oldest asset without intermediate overwrite or identity loss', async () => {
    const f = await fixture(); const database = getTestDb(); await makeAssetOldest(f);
    const canonical = f.assetNodes[0]!;
    await database.update(topologyNodes).set({ labelOverride: 'Operator label' }).where(eq(topologyNodes.id, f.deviceNode.id));
    await database.update(topologyNodes).set({ attributes: { notes: 'Operator note' } }).where(eq(topologyNodes.id, f.assetNodes[1]!.id));
    const [layout] = await database.insert(topologyLayouts).values({ ...f.scope, view: 'overview', revision: 7n }).returning();
    await database.insert(topologyNodePositions).values([
      { ...f.scope, layoutId: layout!.id, nodeId: canonical.id, x: 0, y: 0, revision: 2n, legacySourceRevision: 50n, deletedAt: new Date(0) },
      { ...f.scope, layoutId: layout!.id, nodeId: f.deviceNode.id, x: 8, y: 9, pinned: true, positionSource: 'user', revision: 8n, legacySourceRevision: 20n },
      { ...f.scope, layoutId: layout!.id, nodeId: f.assetNodes[1]!.id, x: 99, y: 99, pinned: false, revision: 5n, legacySourceRevision: 30n },
    ]);
    const before = await state(f.scope);
    const oldRelations = await database.select().from(topologyRelationships).where(eq(topologyRelationships.siteId, f.scope.siteId));
    await linkAll(f); expect((await drain(f.scope)).complete).toBe(true);
    expect((await state(f.scope)).graphRevision).toBe(before.graphRevision + 1n);
    const nodes = await database.select().from(topologyNodes).where(eq(topologyNodes.siteId, f.scope.siteId));
    expect(nodes.map(n => n.id).sort()).toEqual(f.nodes.map(n => n.id).sort());
    expect(nodes.find(n => n.id === canonical.id)).toMatchObject({ aliasTargetId: null, labelOverride: 'Operator label', attributes: { notes: 'Operator note' } });
    expect(nodes.filter(n => n.kind === 'endpoint' && n.id !== canonical.id).every(n => n.aliasTargetId === canonical.id)).toBe(true);
    const positions = await database.select().from(topologyNodePositions).where(eq(topologyNodePositions.siteId, f.scope.siteId));
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ nodeId: canonical.id, x: 8, y: 9, pinned: true, positionSource: 'user', revision: 9n, legacySourceRevision: 50n, deletedAt: null });
    expect((await database.select().from(topologyLayouts).where(eq(topologyLayouts.id, layout!.id)))[0]!.revision).toBe(8n);
    const relations = await database.select().from(topologyRelationships).where(eq(topologyRelationships.siteId, f.scope.siteId));
    expect(relations.map(r => r.id).sort()).toEqual(oldRelations.map(r => r.id).sort());
    expect(relations.every(r => r.sourceNodeId === canonical.id && r.evidenceClass === 'manual')).toBe(true);
    const merged = await audits(f.scope);
    expect(merged).toHaveLength(2);
    expect(merged.every(a => (a.details as { canonicalId: string }).canonicalId === canonical.id)).toBe(true);
    const after = await state(f.scope);
    await drain(f.scope);
    expect(await state(f.scope)).toEqual(after);
    expect(await database.select().from(topologyNodePositions).where(eq(topologyNodePositions.siteId, f.scope.siteId))).toEqual(positions);
    expect(await audits(f.scope)).toEqual(merged);
  });

  it('rejects conflicting pins on two noncanonical members atomically and succeeds after explicit resolution', async () => {
    const f = await fixture(); const database = getTestDb(); await makeAssetOldest(f);
    const [layout] = await database.insert(topologyLayouts).values({ ...f.scope, view: 'overview', revision: 4n }).returning();
    await database.insert(topologyNodePositions).values([f.deviceNode, f.assetNodes[1]!].map((node, i) => ({ ...f.scope, layoutId: layout!.id, nodeId: node.id, x: i, y: 0, pinned: true, revision: 2n })));
    const before = await state(f.scope); await linkAll(f);
    await expect(drain(f.scope)).rejects.toThrow(/Conflicting pins/);
    expect(await state(f.scope)).toMatchObject({ graphRevision: before.graphRevision, materializedInputRevision: before.materializedInputRevision });
    expect((await database.select().from(topologyNodes)).every(n => !n.aliasTargetId)).toBe(true);
    expect(await audits(f.scope)).toHaveLength(0);
    expect(await database.select().from(topologyChangeOutbox).where(isNull(topologyChangeOutbox.deliveredAt))).toHaveLength(2);
    expect((await database.select().from(topologyLayouts))[0]!.revision).toBe(4n);
    await database.update(topologyNodePositions).set({ x: 1 }).where(eq(topologyNodePositions.nodeId, f.deviceNode.id));
    expect((await drain(f.scope)).complete).toBe(true);
    expect((await database.select().from(topologyNodePositions))).toMatchObject([{ nodeId: f.assetNodes[0]!.id, x: 1, pinned: true }]);
  });

  it.each(['oldest', 'intermediate'] as const)('retains nonempty operator labels and notes despite an %s empty value', async emptyAt => {
    const f = await fixture(); const database = getTestDb(); await makeAssetOldest(f);
    const emptyNode = emptyAt === 'oldest' ? f.assetNodes[0]! : f.assetNodes[1]!;
    await database.update(topologyNodes).set({ labelOverride: '', attributes: { notes: '' } }).where(eq(topologyNodes.id, emptyNode.id));
    // Device is newest, so both facts must survive the whole three-member fold.
    await database.update(topologyNodes).set({ labelOverride: 'Retained operator label', attributes: { notes: 'Retained operator note' } }).where(eq(topologyNodes.id, f.deviceNode.id));
    await linkAll(f); expect((await drain(f.scope)).complete).toBe(true);
    expect((await database.select().from(topologyNodes).where(eq(topologyNodes.id, f.assetNodes[0]!.id)))[0])
      .toMatchObject({ aliasTargetId: null, labelOverride: 'Retained operator label', attributes: { notes: 'Retained operator note' } });
    const merged = await audits(f.scope);
    expect(merged).toHaveLength(2);
    expect(merged.every(a => (a.details as { labelOverride: string; notes: string }).labelOverride === 'Retained operator label'
      && (a.details as { notes: string }).notes === 'Retained operator note')).toBe(true);
  });

  it.each(['label', 'notes'] as const)('rejects conflicting manual %s anywhere in the group without partial aliases or ACKs', async field => {
    const f = await fixture(); const database = getTestDb(); await makeAssetOldest(f);
    for (const [i, node] of [f.deviceNode, f.assetNodes[1]!].entries()) await database.update(topologyNodes)
      .set(field === 'label' ? { labelOverride: `Operator ${i}` } : { attributes: { notes: `Operator ${i}` } }).where(eq(topologyNodes.id, node.id));
    const before = await state(f.scope); await linkAll(f);
    await expect(drain(f.scope)).rejects.toThrow(/Conflicting manual/);
    expect(await state(f.scope)).toMatchObject({ graphRevision: before.graphRevision, materializedInputRevision: before.materializedInputRevision });
    expect((await database.select().from(topologyNodes)).every(n => !n.aliasTargetId)).toBe(true);
    expect(await audits(f.scope)).toHaveLength(0);
  });

  it('does not let a suppressed member piggyback on another valid accepted pair', async () => {
    const f = await fixture(); const database = getTestDb(); await linkAll(f);
    await database.update(discoveredAssets).set({ autoLinkSuppressedAt: new Date() }).where(eq(discoveredAssets.id, f.assets[1]!.id));
    const before = await state(f.scope);
    const nodes: NodePublication[] = f.assetNodes.map(node => {
      const { createdAt: _created, updatedAt: _updated, revision: _revision, ...source } = node;
      return { ...source, aliasTargetId: f.deviceNode.id, legacySourceRevision: before.dirtyRevision };
    });
    await expect(scoped(f.scope, () => publishTopologyBuild(f.scope, { nodes, bindings: [], relationships: [], buildFence: before.buildFence.toString(), inputRevision: before.dirtyRevision.toString() }))).rejects.toThrow(/accepted inventory link/);
    expect(await state(f.scope)).toEqual(before);
    expect((await database.select().from(topologyNodes)).every(n => !n.aliasTargetId)).toBe(true);
    expect(await audits(f.scope)).toHaveLength(0);
  });
});
