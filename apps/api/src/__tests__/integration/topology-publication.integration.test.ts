import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db, withDbAccessContext } from '../../db';
import { topologyNodes, topologyNodeBindings, topologyRelationships, topologySiteState, topologyLayouts, topologyNodePositions, devices, discoveredAssets, auditLogs } from '../../db/schema';
import { publishTopologyBuild, type NodePublication, type PublicationInput, type RelationshipPublication } from '../../services/topology/publish';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

const scoped = <T>(scope: TopologyScope, run: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), run);
async function fixture() {
  const tenant = await createTopologyTenant();
  const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
  await getTestDb().insert(topologySiteState).values({ ...scope, dirtyRevision: 10n, buildFence: 2n });
  return scope;
}
function node(scope: TopologyScope, sourceKey = `device:${randomUUID()}`): NodePublication {
  return { ...scope, id: randomUUID(), kind: 'endpoint', identityKey: canonicalIdentityKey(scope, 'endpoint', sourceKey), identityMaterial: { version: 1, kind: 'endpoint', sourceKey }, attributes: { label: 'Endpoint' } };
}
function relationship(scope: TopologyScope, sourceNodeId: string, targetNodeId: string): RelationshipPublication {
  const sourceKey = `manual:${randomUUID()}`;
  return { ...scope, id: randomUUID(), kind: 'attachment', sourceNodeId, targetNodeId, canonicalKey: canonicalIdentityKey(scope, 'attachment', sourceKey), identityMaterial: { version: 1, kind: 'attachment', sourceKey }, evidenceClass: 'manual', confidence: 'asserted', attributes: { method: 'manual', notes: 'Retain manual assertion' } };
}
const input = (nodes: NodePublication[], relationships: RelationshipPublication[] = [], overrides: Partial<PublicationInput> = {}): PublicationInput => ({ buildFence: '2', inputRevision: '1', nodes, relationships, bindings: [], ...overrides });
const publish = (scope: TopologyScope, value: PublicationInput) => scoped(scope, () => publishTopologyBuild(scope, value));
async function state(scope: TopologyScope) { return (await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)))[0]!; }

describe('atomic fenced topology publication', () => {
  it('rejects an older fence and equal checkpoint without changing any rows', async () => {
    const scope = await fixture(); const a = node(scope);
    expect(await publish(scope, input([a]))).toEqual({ published: true, graphRevision: '1' });
    const before = await state(scope);
    await getTestDb().update(topologySiteState).set({ buildFence: 3n }).where(eq(topologySiteState.siteId, scope.siteId));
    expect(await publish(scope, input([{ ...a, attributes: { label: 'stale worker' } }], [], { inputRevision: '2' }))).toEqual({ published: false, graphRevision: '1' });
    expect(await publish(scope, input([a], [], { buildFence: '3' }))).toEqual({ published: false, graphRevision: '1' });
    expect(await state(scope)).toEqual({ ...before, buildFence: 3n });
    expect((await getTestDb().select().from(topologyNodes))[0]!.attributes.label).toBe('Endpoint');
  });

  it('preserves the canonical UUID across label/prefix changes and advances only meaningful graph changes', async () => {
    const scope = await fixture(); const a = node(scope);
    await publish(scope, input([a]));
    const refresh = { ...a, id: randomUUID(), attributes: { label: 'Renamed', prefix: '192.0.2.0/24' } };
    expect(await publish(scope, input([refresh], [], { inputRevision: '2' }))).toEqual({ published: true, graphRevision: '2' });
    const rows = await getTestDb().select().from(topologyNodes);
    expect(rows).toHaveLength(1); expect(rows[0]!.id).toBe(a.id);
    expect(await publish(scope, input([{ ...refresh, lastObservedAt: new Date() }], [], { inputRevision: '3' }))).toEqual({ published: true, graphRevision: '2' });
    expect(await state(scope)).toMatchObject({ materializedInputRevision: 3n, dirtyRevision: 10n, lastBuildStatus: 'pending' });
  });

  it('accepts a no-change layout/health checkpoint, preserving independent revisions and idempotent replay', async () => {
    const scope = await fixture(); const a = node(scope);
    await publish(scope, input([a]));
    const [layout] = await getTestDb().insert(topologyLayouts).values({ ...scope, view: 'overview', revision: 4n }).returning();
    await getTestDb().insert(topologyNodePositions).values({ ...scope, layoutId: layout!.id, nodeId: a.id, x: 42, y: 43, pinned: true });
    await getTestDb().update(topologySiteState).set({ healthRevision: 5n }).where(eq(topologySiteState.siteId, scope.siteId));
    expect(await publish(scope, input([a], [], { inputRevision: '2' }))).toEqual({ published: true, graphRevision: '1' });
    expect(await state(scope)).toMatchObject({ graphRevision: 1n, healthRevision: 5n, materializedInputRevision: 2n });
    const before = await state(scope);
    expect(await publish(scope, input([a], [], { inputRevision: '2' }))).toEqual({ published: false, graphRevision: '1' });
    expect(await state(scope)).toEqual(before);
    expect((await getTestDb().select().from(topologyLayouts))[0]!.revision).toBe(4n);
  });

  it('rolls the guard and graph back together on a late same-scope inventory FK failure', async () => {
    const scope = await fixture(); const a = node(scope); const before = await state(scope);
    await scoped(scope, async () => {
      await expect(publishTopologyBuild(scope, input([a], [], { bindings: [{ ...scope, id: randomUUID(), nodeId: a.id, deviceId: randomUUID(), provenance: { method: 'inventory' } }] }))).rejects.toThrow();
      // Catching the error must leave the ambient transaction usable. This
      // distinguishes the publisher's own rollback from caller rollback.
      expect((await db.select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)))[0]!.materializedInputRevision).toBe(0n);
    });
    expect(await state(scope)).toEqual(before);
    expect(await getTestDb().select().from(topologyNodes)).toHaveLength(0);
  });

  it('rejects foreign staged scope, endpoint and aliases, including a system-visible foreign site', async () => {
    const scope = await fixture(); const other = await fixture(); const foreign = node(other);
    await publish(other, input([foreign]));
    const a = node(scope);
    await expect(publish(scope, input([foreign]))).rejects.toThrow(/scope/);
    await expect(publish(scope, input([a], [relationship(scope, a.id, foreign.id)]))).rejects.toThrow(/scope/);
    await expect(publish(scope, input([{ ...a, aliasTargetId: foreign.id }]))).rejects.toThrow(/alias/);
    await expect(scoped(other, () => publishTopologyBuild(scope, input([a])))).rejects.toThrow(/inaccessible/);
    expect((await state(scope)).graphRevision).toBe(0n);
  });

  it('has no half-published endpoints or relationships for concurrent readers', async () => {
    const scope = await fixture(); const a = node(scope); const b = node(scope);
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let prepared!: () => void; const ready = new Promise<void>(resolve => { prepared = resolve; });
    const write = scoped(scope, async () => {
      const result = await publishTopologyBuild(scope, input([a, b], [relationship(scope, a.id, b.id)]));
      prepared(); await hold; return result;
    });
    const snapshot = () => scoped(scope, () => db.execute(sql`SELECT
      (SELECT count(*)::int FROM topology_nodes WHERE org_id = ${scope.orgId}::uuid AND site_id = ${scope.siteId}::uuid) AS nodes,
      (SELECT count(*)::int FROM topology_relationships WHERE org_id = ${scope.orgId}::uuid AND site_id = ${scope.siteId}::uuid) AS edges,
      (SELECT graph_revision::text FROM topology_site_state WHERE org_id = ${scope.orgId}::uuid AND site_id = ${scope.siteId}::uuid) AS revision`));
    try {
      await Promise.race([ready, write.then(() => { throw new Error('Writer finished before barrier'); })]);
      const readers = await Promise.all([snapshot(), snapshot(), snapshot()]);
      for (const rows of readers) expect(rows[0]).toEqual({ nodes: 0, edges: 0, revision: '0' });
    } finally { release(); }
    expect(await write).toEqual({ published: true, graphRevision: '1' });
    expect((await snapshot())[0]).toEqual({ nodes: 2, edges: 1, revision: '1' });
  });

  it('serializes concurrent snapshots so an older input cannot overwrite a newer one', async () => {
    const scope = await fixture(); const a = node(scope);
    const newer = await publish(scope, input([{ ...a, attributes: { label: 'newest' } }], [], { inputRevision: '5' }));
    const results = await Promise.all([publish(scope, input([a], [], { inputRevision: '4' })), publish(scope, input([a], [], { inputRevision: '5' }))]);
    expect(newer.published).toBe(true); expect(results.every(r => !r.published)).toBe(true);
    expect((await getTestDb().select().from(topologyNodes))[0]!.attributes.label).toBe('newest');
  });

  it('preserves bigint checkpoints above Number safe range and rejects uncaptured future input', async () => {
    const scope = await fixture(); const big = 9007199254740993n;
    await getTestDb().update(topologySiteState).set({ dirtyRevision: big, buildFence: big }).where(eq(topologySiteState.siteId, scope.siteId));
    expect(await publish(scope, input([], [], { buildFence: big.toString(), inputRevision: big.toString() }))).toEqual({ published: true, graphRevision: '0' });
    expect((await state(scope)).materializedInputRevision).toBe(big);
    await expect(publish(scope, input([], [], { buildFence: big.toString(), inputRevision: (big + 1n).toString() }))).rejects.toThrow(/dirty revision/);
  });

  it('does not restore a tombstone from an equal or older legacy source revision', async () => {
    const scope = await fixture(); const a = { ...node(scope), legacySourceType: 'manual_node', legacySourceId: randomUUID(), legacySourceRevision: 3n, deletedAt: new Date(), lifecycle: 'archived' as const };
    await publish(scope, input([a]));
    expect(await publish(scope, input([{ ...a, deletedAt: null, lifecycle: 'active', legacySourceRevision: 2n }], [], { inputRevision: '2' }))).toEqual({ published: true, graphRevision: '1' });
    expect((await getTestDb().select().from(topologyNodes))[0]!.deletedAt).not.toBeNull();
  });

  it('keeps unknown legacy provenance unverified and cannot auto-promote physical links', async () => {
    const scope = await fixture(); const a = node(scope); const b = node(scope);
    const rel = relationship(scope, a.id, b.id);
    const legacy = { ...rel, evidenceClass: 'inferred' as const, confidence: 'low' as const, directness: 'unknown' as const, attributes: { method: 'legacy' as const } };
    await publish(scope, input([a, b], [legacy]));
    const row = (await getTestDb().select().from(topologyRelationships))[0]!;
    expect(row).toMatchObject({ kind: 'attachment', directness: 'unknown', confidence: 'low', evidenceClass: 'inferred' });
    await expect(publish(scope, input([], [{ ...legacy, kind: 'physical_link', canonicalKey: canonicalIdentityKey(scope, 'physical_link', legacy.identityMaterial.sourceKey), identityMaterial: { ...legacy.identityMaterial, kind: 'physical_link' } }], { inputRevision: '2' }))).rejects.toThrow(/physical/);
  });

  it('requires an accepted link before two inventory records can share a new endpoint', async () => {
    const scope = await fixture(); const a = node(scope); const deviceId = randomUUID(); const assetId = randomUUID();
    await getTestDb().insert(devices).values({ ...scope, id: deviceId, agentId: deviceId, hostname: 'fixture', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' });
    await getTestDb().insert(discoveredAssets).values({ ...scope, id: assetId, ipAddress: '192.0.2.1' });
    const bindings = [{ ...scope, id: randomUUID(), nodeId: a.id, deviceId }, { ...scope, id: randomUUID(), nodeId: a.id, discoveredAssetId: assetId }];
    await expect(publish(scope, input([a], [], { bindings }))).rejects.toThrow(/accepted inventory link/);
    expect((await state(scope)).materializedInputRevision).toBe(0n);
    await getTestDb().update(discoveredAssets).set({ linkedDeviceId: deviceId, linkSource: 'manual' }).where(eq(discoveredAssets.id, assetId));
    expect((await publish(scope, input([a], [], { bindings }))).published).toBe(true);
  });

  it('applies a newer explicit legacy manual edit while preserving omitted manual facts', async () => {
    const scope = await fixture(); const sourceKey = `manual:${randomUUID()}`;
    const a: NodePublication = { ...node(scope), kind: 'manual', identityKey: canonicalIdentityKey(scope, 'manual', sourceKey), identityMaterial: { version: 1, kind: 'manual', sourceKey }, legacySourceType: 'manual_node', legacySourceId: randomUUID(), legacySourceRevision: 1n, labelOverride: 'old label', attributes: { notes: 'old note' } };
    await publish(scope, input([a]));
    await publish(scope, input([{ ...a, legacySourceRevision: 2n, labelOverride: 'new label', attributes: { notes: 'new note' } }], [], { inputRevision: '2' }));
    await publish(scope, input([{ ...a, legacySourceRevision: 3n, labelOverride: undefined, attributes: {} }], [], { inputRevision: '3' }));
    expect((await getTestDb().select().from(topologyNodes))[0]).toMatchObject({ labelOverride: 'new label', attributes: { notes: 'new note' } });
  });

  it('merges accepted managed/discovered identity into oldest UUID, preserving bindings, assertions, pins and audit', async () => {
    const scope = await fixture(); const a = node(scope); const b = node(scope); const c = node(scope);
    const deviceId = randomUUID(); const assetId = randomUUID();
    await getTestDb().insert(devices).values({ ...scope, id: deviceId, agentId: deviceId, hostname: 'fixture', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' });
    await getTestDb().insert(discoveredAssets).values({ ...scope, id: assetId, ipAddress: '192.0.2.1', linkedDeviceId: deviceId, linkSource: 'manual' });
    const bindings = [{ ...scope, id: randomUUID(), nodeId: a.id, deviceId, provenance: { method: 'inventory' as const } }, { ...scope, id: randomUUID(), nodeId: b.id, discoveredAssetId: assetId, provenance: { method: 'accepted_link' as const } }];
    await publish(scope, input([a, { ...b, labelOverride: 'Manual label' }, c], [relationship(scope, b.id, c.id)], { bindings }));
    await getTestDb().update(topologyNodes).set({ createdAt: new Date('2020-01-01') }).where(eq(topologyNodes.id, a.id));
    const [layout] = await getTestDb().insert(topologyLayouts).values({ ...scope, view: 'overview' }).returning();
    await getTestDb().insert(topologyNodePositions).values({ ...scope, layoutId: layout!.id, nodeId: b.id, x: 11, y: 22, pinned: true, positionSource: 'user' });
    await getTestDb().insert(topologyNodePositions).values({ ...scope, layoutId: layout!.id, nodeId: a.id, x: 99, y: 22, pinned: true, positionSource: 'user' });
    await expect(publish(scope, input([{ ...b, aliasTargetId: a.id }], [], { inputRevision: '2' }))).rejects.toThrow(/pin/);
    expect((await state(scope)).materializedInputRevision).toBe(1n);
    await getTestDb().delete(topologyNodePositions).where(and(eq(topologyNodePositions.layoutId, layout!.id), eq(topologyNodePositions.nodeId, a.id)));
    await getTestDb().update(discoveredAssets).set({ autoLinkSuppressedAt: new Date() }).where(eq(discoveredAssets.id, assetId));
    await expect(publish(scope, input([{ ...b, aliasTargetId: a.id }], [], { inputRevision: '2' }))).rejects.toThrow(/accepted inventory link/);
    await getTestDb().update(discoveredAssets).set({ autoLinkSuppressedAt: null }).where(eq(discoveredAssets.id, assetId));
    expect(await publish(scope, input([{ ...b, aliasTargetId: a.id }], [], { inputRevision: '2' }))).toEqual({ published: true, graphRevision: '2' });
    const rows = await getTestDb().select().from(topologyNodes);
    expect(rows.find(n => n.id === a.id)).toMatchObject({ labelOverride: 'Manual label', aliasTargetId: null });
    expect(rows.find(n => n.id === b.id)!.aliasTargetId).toBe(a.id);
    expect((await getTestDb().select().from(topologyNodeBindings)).map(x => x.nodeId)).toEqual([a.id, a.id]);
    expect((await getTestDb().select().from(topologyRelationships))[0]).toMatchObject({ sourceNodeId: a.id, attributes: { method: 'manual', notes: 'Retain manual assertion' } });
    expect(await getTestDb().select().from(topologyNodePositions)).toMatchObject([{ nodeId: a.id, x: 11, y: 22, pinned: true }]);
    expect((await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, 'topology.alias_merged')))[0]!.details).toMatchObject({ canonicalId: a.id, aliasId: b.id, evidence: 'accepted_link' });
  });
});
