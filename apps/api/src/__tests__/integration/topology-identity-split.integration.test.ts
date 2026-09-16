import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { closeDb, withDbAccessContext } from '../../db';
import { auditLogs, devices, discoveredAssets, networkTopology, sites, topologyLayout, topologyLayouts, topologyManualNodes, topologyNodeBindings, topologyNodePositions, topologyNodes, topologyRelationships, topologySiteState } from '../../db/schema';
import { compareLegacyTopology, drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { publishTopologyBuild, type NodePublication } from '../../services/topology/publish';
import { legacyNodeIdentity } from '../../services/topology/legacyProjection';
import { getTestDb } from './setup';
import { createTopologyTenant, orgContext } from './topology-fixtures';

afterAll(() => closeDb());
const scoped = <T>(scope: TopologyScope, fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
const where = (scope: TopologyScope) => and(eq(topologySiteState.orgId, scope.orgId), eq(topologySiteState.siteId, scope.siteId));
const state = async (scope: TopologyScope) => (await getTestDb().select().from(topologySiteState).where(where(scope)))[0]!;
const drain = (scope: TopologyScope) => scoped(scope, () => drainTopologyOutbox(scope, { batchSize: 1000 }));

async function fixture(oldest: 'device' | 'asset') {
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  const database = getTestDb();
  const [device] = await database.insert(devices).values({ ...scope, agentId: randomUUID(), hostname: 'managed', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' }).returning();
  const [asset] = await database.insert(discoveredAssets).values({ ...scope, ipAddress: '192.0.2.60', hostname: 'discovered' }).returning();
  const [manual] = await database.insert(topologyManualNodes).values({ ...scope, label: 'Manual peer', role: 'switch' }).returning();
  await database.insert(networkTopology).values({ ...scope, sourceType: 'discovered_asset', sourceId: asset!.id, targetType: 'manual_node', targetId: manual!.id, method: 'manual', confidence: 'asserted', connectionType: 'wired' });
  expect((await scoped(scope, () => importLegacyTopologySite(scope, { batchSize: 1000 }))).complete).toBe(true);
  const deviceNodeId = (await database.select().from(topologyNodes).where(eq(topologyNodes.identityKey, legacyNodeIdentity(scope, 'devices', device!.id).identityKey)))[0]!.id;
  const assetNodeId = (await database.select().from(topologyNodes).where(eq(topologyNodes.identityKey, legacyNodeIdentity(scope, 'discovered_assets', asset!.id).identityKey)))[0]!.id;
  const canonicalId = oldest === 'device' ? deviceNodeId : assetNodeId;
  const aliasId = oldest === 'device' ? assetNodeId : deviceNodeId;
  await database.update(topologyNodes).set({ createdAt: new Date('2020-01-01'), labelOverride: 'Pinned manual name', attributes: { label: 'Preserve display', notes: 'Preserve manual note' } }).where(eq(topologyNodes.id, canonicalId));
  await database.update(topologyNodes).set({ createdAt: new Date('2021-01-01') }).where(eq(topologyNodes.id, aliasId));
  const [layout] = await database.insert(topologyLayouts).values({ ...scope, view: 'overview', revision: 7n }).returning();
  await database.insert(topologyNodePositions).values({ ...scope, layoutId: layout!.id, nodeId: canonicalId, x: 13, y: 27, pinned: true, positionSource: 'user', revision: 3n });
  await database.update(discoveredAssets).set({ linkedDeviceId: device!.id, linkSource: 'manual' }).where(eq(discoveredAssets.id, asset!.id));
  expect((await drain(scope)).complete).toBe(true);
  expect((await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.deviceId, device!.id)))[0]!.nodeId).toBe(canonicalId);
  expect((await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.discoveredAssetId, asset!.id)))[0]!.nodeId).toBe(canonicalId);
  return { scope, device: device!, asset: asset!, manual: manual!, deviceNodeId, assetNodeId, canonicalId, aliasId, layout: layout! };
}

async function facts(scope: TopologyScope) {
  const database = getTestDb();
  return {
    positions: await database.select().from(topologyNodePositions).where(eq(topologyNodePositions.siteId, scope.siteId)),
    relations: await database.select().from(topologyRelationships).where(eq(topologyRelationships.siteId, scope.siteId)),
    layout: await database.select().from(topologyLayouts).where(eq(topologyLayouts.siteId, scope.siteId)),
  };
}

describe('authoritative accepted-link revocation and retained UUID splits', () => {
  it.each([
    { oldest: 'device' as const, revocation: 'unlink' }, { oldest: 'asset' as const, revocation: 'unlink' },
    { oldest: 'device' as const, revocation: 'suppress' }, { oldest: 'asset' as const, revocation: 'suppress' },
  ])('splits $revocation with oldest $oldest, preserves history, then relinks the same UUIDs', async ({ oldest, revocation }) => {
    const f = await fixture(oldest); const database = getTestDb();
    const before = await state(f.scope); const history = await facts(f.scope);
    await database.update(discoveredAssets).set(revocation === 'unlink' ? { linkedDeviceId: null, linkSource: null } : { autoLinkSuppressedAt: new Date() }).where(eq(discoveredAssets.id, f.asset.id));
    // An unrelated edit behind the revocation cannot be poisoned by invalid
    // shared bindings. Both changes publish as one structural graph revision.
    await database.update(topologyManualNodes).set({ label: 'Unrelated edit' }).where(eq(topologyManualNodes.id, f.manual.id));
    expect((await drain(f.scope)).complete).toBe(true);
    const after = await state(f.scope);
    expect(after.buildFence).toBe(before.buildFence + 1n);
    expect(after.graphRevision).toBe(before.graphRevision + 1n);
    const bindings = await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, f.scope.siteId));
    expect(bindings.find(b => b.deviceId === f.device.id)!.nodeId).toBe(f.deviceNodeId);
    expect(bindings.find(b => b.discoveredAssetId === f.asset.id)!.nodeId).toBe(f.assetNodeId);
    const nodes = await database.select().from(topologyNodes).where(eq(topologyNodes.siteId, f.scope.siteId));
    expect(nodes.find(n => n.id === f.deviceNodeId)).toMatchObject({ aliasTargetId: null, lifecycle: 'active', deletedAt: null });
    expect(nodes.find(n => n.id === f.assetNodeId)).toMatchObject({ aliasTargetId: null, lifecycle: 'active', deletedAt: null });
    expect(nodes.find(n => n.id === f.canonicalId)).toMatchObject({ labelOverride: 'Pinned manual name', attributes: { notes: 'Preserve manual note' } });
    expect(await facts(f.scope)).toEqual(history);
    const audits = await database.select().from(auditLogs).where(eq(auditLogs.action, 'topology.alias_split'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ previousCanonicalId: f.canonicalId, reason: 'inventory_link_revoked', buildFence: after.buildFence.toString() });
    expect((await drain(f.scope)).complete).toBe(true);
    expect(await state(f.scope)).toEqual(after);
    expect(await facts(f.scope)).toEqual(history);
    expect(await database.select().from(auditLogs).where(eq(auditLogs.action, 'topology.alias_split'))).toEqual(audits);
    // A pre-revocation worker cannot publish after the split fence changes.
    await database.update(topologyManualNodes).set({ label: 'Next edit' }).where(eq(topologyManualNodes.id, f.manual.id));
    const pending = await state(f.scope);
    expect(await scoped(f.scope, () => publishTopologyBuild(f.scope, { buildFence: before.buildFence.toString(), inputRevision: pending.dirtyRevision.toString(), nodes: [], relationships: [], bindings: [] }))).toEqual({ published: false, graphRevision: after.graphRevision.toString() });
    await drain(f.scope);
    await database.update(discoveredAssets).set({ linkedDeviceId: f.device.id, autoLinkSuppressedAt: null }).where(eq(discoveredAssets.id, f.asset.id));
    expect((await drain(f.scope)).complete).toBe(true);
    const relinked = await database.select().from(topologyNodes).where(eq(topologyNodes.siteId, f.scope.siteId));
    expect(relinked.map(node => node.id).sort()).toEqual(nodes.map(node => node.id).sort());
    expect(relinked.find(n => n.id === f.aliasId)!.aliasTargetId).toBe(f.canonicalId);
    const linkedBindings = await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, f.scope.siteId));
    expect(linkedBindings.filter(b => b.deviceId || b.discoveredAssetId).map(b => b.nodeId)).toEqual([f.canonicalId, f.canonicalId]);
    expect((await facts(f.scope)).positions).toEqual(history.positions);
  });

  it('moves the remaining accepted component to its retained device UUID when the oldest asset leaves', async () => {
    const f = await fixture('asset'); const database = getTestDb();
    const [second] = await database.insert(discoveredAssets).values({ ...f.scope, ipAddress: '192.0.2.61', hostname: 'second source' }).returning();
    await drain(f.scope);
    const [secondNode] = await database.select().from(topologyNodes).where(eq(topologyNodes.identityKey, legacyNodeIdentity(f.scope, 'discovered_assets', second!.id).identityKey));
    await database.update(discoveredAssets).set({ linkedDeviceId: f.device.id, linkSource: 'manual' }).where(eq(discoveredAssets.id, second!.id));
    await drain(f.scope);
    const history = await facts(f.scope);
    await database.update(discoveredAssets).set({ linkedDeviceId: null, linkSource: null }).where(eq(discoveredAssets.id, f.asset.id));
    await drain(f.scope);
    const bindings = await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, f.scope.siteId));
    expect(bindings.find(b => b.discoveredAssetId === f.asset.id)!.nodeId).toBe(f.assetNodeId);
    expect(bindings.find(b => b.deviceId === f.device.id)!.nodeId).toBe(f.deviceNodeId);
    expect(bindings.find(b => b.discoveredAssetId === second!.id)!.nodeId).toBe(f.deviceNodeId);
    expect((await database.select().from(topologyNodes).where(eq(topologyNodes.id, secondNode!.id)))[0]!.aliasTargetId).toBe(f.deviceNodeId);
    expect(await facts(f.scope)).toEqual(history);
    await database.update(discoveredAssets).set({ linkedDeviceId: f.device.id }).where(eq(discoveredAssets.id, f.asset.id));
    await drain(f.scope);
    expect((await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.discoveredAssetId, second!.id)))[0]!.nodeId).toBe(f.assetNodeId);
  });

  it.each(['device', 'asset'] as const)('relinks an oldest %s cluster to another actual device without reusing the old device binding', async oldest => {
    const f = await fixture(oldest); const database = getTestDb();
    const [nextDevice] = await database.insert(devices).values({ ...f.scope, agentId: randomUUID(), hostname: 'replacement', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' }).returning();
    await drain(f.scope);
    const history = await facts(f.scope);
    await database.update(discoveredAssets).set({ linkedDeviceId: nextDevice!.id }).where(eq(discoveredAssets.id, f.asset.id));
    expect((await drain(f.scope)).complete).toBe(true);
    const bindings = await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, f.scope.siteId));
    expect(bindings.find(b => b.deviceId === f.device.id)!.nodeId).toBe(f.deviceNodeId);
    expect(bindings.find(b => b.discoveredAssetId === f.asset.id)!.nodeId).toBe(bindings.find(b => b.deviceId === nextDevice!.id)!.nodeId);
    expect(bindings.find(b => b.deviceId === f.device.id)!.nodeId).not.toBe(bindings.find(b => b.deviceId === nextDevice!.id)!.nodeId);
    expect((await facts(f.scope)).positions).toEqual(history.positions);
    expect((await facts(f.scope)).relations).toEqual(history.relations);
  });

  it.each([
    { oldest: 'device' as const, departure: 'move' }, { oldest: 'asset' as const, departure: 'move' },
    { oldest: 'device' as const, departure: 'delete' }, { oldest: 'asset' as const, departure: 'delete' },
  ])('preserves the surviving live source after canonical $oldest $departure pre-detaches its binding', async ({ oldest, departure }) => {
    const f = await fixture(oldest); const database = getTestDb(); const history = await facts(f.scope);
    if (departure === 'move') {
      const [nextSite] = await database.insert(sites).values({ orgId: f.scope.orgId, name: 'New site' }).returning();
      if (oldest === 'device') await database.update(devices).set({ siteId: nextSite!.id }).where(eq(devices.id, f.device.id));
      else await database.update(discoveredAssets).set({ siteId: nextSite!.id }).where(eq(discoveredAssets.id, f.asset.id));
    } else if (oldest === 'device') {
      await database.transaction(async tx => {
        await tx.update(discoveredAssets).set({ linkedDeviceId: null, linkSource: null }).where(eq(discoveredAssets.id, f.asset.id));
        await tx.delete(devices).where(eq(devices.id, f.device.id));
      });
    } else await database.delete(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
    const survivingId = oldest === 'device' ? f.assetNodeId : f.deviceNodeId;
    // The source BEFORE trigger already removed the departing binding. The
    // remaining source must be found from retained source identity, not from a
    // now-absent shared binding pair.
    expect((await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, f.scope.siteId))).filter(b => b.deviceId || b.discoveredAssetId)).toHaveLength(1);
    expect((await drain(f.scope)).complete).toBe(true);
    const [survivor] = await database.select().from(topologyNodes).where(eq(topologyNodes.id, survivingId));
    expect(survivor).toMatchObject({ aliasTargetId: null, lifecycle: 'active', deletedAt: null });
    const [binding] = (await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, f.scope.siteId))).filter(b => b.deviceId || b.discoveredAssetId);
    expect(binding!.nodeId).toBe(survivingId);
    const [departed] = await database.select().from(topologyNodes).where(eq(topologyNodes.id, f.canonicalId));
    expect(departed!.deletedAt).not.toBeNull();
    expect((await facts(f.scope)).positions).toEqual(history.positions);
    expect((await facts(f.scope)).relations).toEqual(history.relations);
    await database.update(topologyManualNodes).set({ label: 'Site keeps working' }).where(eq(topologyManualNodes.id, f.manual.id));
    expect((await drain(f.scope)).complete).toBe(true);
  });

  it('keeps ambiguous historical pin parity fail-closed while later edits continue to drain', async () => {
    const f = await fixture('device'); const database = getTestDb();
    // The old asset position matches a user pin on the merged device. An echo
    // preserves positionSource=user; source identity cannot prove that the
    // user's pin should move to the asset after the accepted link is revoked.
    await database.insert(topologyLayout).values({ ...f.scope, nodeType: 'discovered_asset', nodeId: f.asset.id, x: 13, y: 27, pinned: true });
    await drain(f.scope);
    expect((await scoped(f.scope, () => compareLegacyTopology(f.scope))).ok).toBe(true);
    const history = await facts(f.scope);
    expect(history.positions[0]!.positionSource).toBe('user');
    await database.update(discoveredAssets).set({ linkedDeviceId: null, linkSource: null }).where(eq(discoveredAssets.id, f.asset.id));
    await database.update(topologyManualNodes).set({ label: 'Unaffected later edit' }).where(eq(topologyManualNodes.id, f.manual.id));
    expect((await drain(f.scope)).complete).toBe(true);
    const report = await scoped(f.scope, () => compareLegacyTopology(f.scope));
    expect(report).toMatchObject({ pendingThroughBarrier: 0, complete: true, sameBarrier: true, ok: false, unexplainedPinDifferenceCount: 1 });
    expect(report.unexplainedPinDifferences).toHaveLength(1);
    expect(report.unexplainedPinDifferences[0]).toMatch(/^[a-f0-9]{24}$/);
    expect(report.unexplainedPinDifferences[0]).not.toContain(f.asset.id);
    expect((await facts(f.scope)).positions).toEqual(history.positions);
    await database.update(topologyManualNodes).set({ label: 'Another unrelated edit' }).where(eq(topologyManualNodes.id, f.manual.id));
    expect((await drain(f.scope)).complete).toBe(true);
    expect((await scoped(f.scope, () => compareLegacyTopology(f.scope))).unexplainedPinDifferences).toEqual(report.unexplainedPinDifferences);
  });

  it('imports multiple accepted assets for one device in the initial all-at-once batch', async () => {
    const tenant = await createTopologyTenant(); const scope = { orgId: tenant.orgId, siteId: tenant.siteId }; const database = getTestDb();
    const [device] = await database.insert(devices).values({ ...scope, agentId: randomUUID(), hostname: 'shared managed device', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' }).returning();
    await database.insert(discoveredAssets).values([
      { ...scope, ipAddress: '192.0.2.70', linkedDeviceId: device!.id, linkSource: 'manual' },
      { ...scope, ipAddress: '192.0.2.71', linkedDeviceId: device!.id, linkSource: 'manual' },
    ]);
    expect((await scoped(scope, () => importLegacyTopologySite(scope, { batchSize: 1000 }))).complete).toBe(true);
    const bindings = await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, scope.siteId));
    expect(bindings).toHaveLength(3);
    expect(new Set(bindings.map(binding => binding.nodeId)).size).toBe(1);
    expect((await database.select().from(topologyNodes).where(eq(topologyNodes.siteId, scope.siteId))).filter(node => node.aliasTargetId)).toHaveLength(2);
  });

  it('keeps ordinary publisher alias restoration forbidden', async () => {
    const f = await fixture('device'); const database = getTestDb();
    const [alias] = await database.select().from(topologyNodes).where(eq(topologyNodes.id, f.aliasId));
    await database.update(topologyManualNodes).set({ label: 'A new input' }).where(eq(topologyManualNodes.id, f.manual.id));
    const current = await state(f.scope);
    const { createdAt: _created, updatedAt: _updated, revision: _revision, ...row } = alias!;
    await expect(scoped(f.scope, () => publishTopologyBuild(f.scope, { buildFence: current.buildFence.toString(), inputRevision: current.dirtyRevision.toString(),
      nodes: [{ ...row, aliasTargetId: null, legacySourceRevision: current.dirtyRevision } as NodePublication], bindings: [], relationships: [] }))).rejects.toThrow(/cannot be restored/);
    expect((await database.select().from(topologyNodes).where(eq(topologyNodes.id, f.aliasId)))[0]!.aliasTargetId).toBe(f.canonicalId);
  });
});
