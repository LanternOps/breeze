import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db, withDbAccessContext } from '../../db';
import { topologyNodes, topologyNodeBindings, topologyRelationships, topologySiteState, topologyLayouts, topologyNodePositions, topologyChangeOutbox, devices, discoveredAssets, auditLogs } from '../../db/schema';
import { publishTopologyBuild, type NodePublication, type PublicationInput, type RelationshipPublication } from '../../services/topology/publish';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';
import { legacyNodeIdentity } from '../../services/topology/legacyProjection';
import { replayLegacyBatch } from '../../services/topology/legacyReplay';
import { emptyLegacyCounts } from '../../services/topology/legacyImportState';

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

async function aliasPair(scope: TopologyScope, ipAddress = '192.0.2.1') {
  const deviceId = randomUUID(); const assetId = randomUUID();
  const a = { ...node(scope), ...legacyNodeIdentity(scope, 'devices', deviceId) };
  const b = { ...node(scope), ...legacyNodeIdentity(scope, 'discovered_assets', assetId) };
  await getTestDb().insert(devices).values({ ...scope, id: deviceId, agentId: deviceId, hostname: 'fixture', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' });
  await getTestDb().insert(discoveredAssets).values({ ...scope, id: assetId, ipAddress, linkedDeviceId: deviceId, linkSource: 'manual' });
  await publish(scope, input([a, b], [], { inputRevision: ((await state(scope)).materializedInputRevision + 1n).toString(), bindings: [
    { ...scope, id: randomUUID(), nodeId: a.id, deviceId }, { ...scope, id: randomUUID(), nodeId: b.id, discoveredAssetId: assetId },
  ] }));
  await getTestDb().update(topologyNodes).set({ createdAt: new Date('2020-01-01') }).where(eq(topologyNodes.id, a.id));
  return { a, b, assetId };
}

async function waitForBlocking(waiter: number, holder: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await getTestDb().execute(sql`SELECT ${holder}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`);
    if (rows[0]?.blocked === true) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Asset UPDATE never reached the held capture barrier');
}

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

  it('advances alias layout CAS once per affected header, rows and no-change replay independently', async () => {
    const scope = await fixture(); const first = await aliasPair(scope); const second = await aliasPair(scope, '192.0.2.2');
    const layouts = await getTestDb().insert(topologyLayouts).values([
      { ...scope, view: 'overview', revision: 7n }, { ...scope, view: 'physical', revision: 11n }, { ...scope, view: 'logical', revision: 15n },
    ]).returning();
    const overview = layouts.find(l => l.view === 'overview')!; const physical = layouts.find(l => l.view === 'physical')!;
    for (const pair of [first, second]) await getTestDb().insert(topologyNodePositions).values([
      { ...scope, layoutId: overview.id, nodeId: pair.a.id, x: 0, y: 0, revision: 2n, legacySourceRevision: 2n },
      { ...scope, layoutId: overview.id, nodeId: pair.b.id, x: 11, y: 22, pinned: true, revision: 4n, legacySourceRevision: 10n },
    ]);
    await getTestDb().insert(topologyNodePositions).values({ ...scope, layoutId: physical.id, nodeId: first.b.id, x: 3, y: 4, pinned: true, revision: 0n });
    const build = input([first, second].map(pair => ({ ...pair.b, aliasTargetId: pair.a.id })), [], { inputRevision: '3' });
    expect((await publish(scope, build)).published).toBe(true);
    const after = await getTestDb().select().from(topologyLayouts);
    expect(Object.fromEntries(after.map(l => [l.view, l.revision]))).toEqual({ overview: 8n, physical: 12n, logical: 15n });
    const positions = await getTestDb().select().from(topologyNodePositions).where(eq(topologyNodePositions.layoutId, overview.id));
    expect(positions).toHaveLength(2);
    for (const position of positions) expect(position).toMatchObject({ pinned: true, x: 11, y: 22, revision: 5n, legacySourceRevision: 10n });
    // The old expected revision can no longer authorize an editor's CAS.
    expect(await getTestDb().update(topologyLayouts).set({ revision: 999n }).where(and(eq(topologyLayouts.id, overview.id), eq(topologyLayouts.revision, 7n))).returning()).toHaveLength(0);
    expect((await publish(scope, build)).published).toBe(false);
    expect(await getTestDb().select().from(topologyLayouts)).toEqual(after);
  });

  it.each([false, true])('retains alias replay high-water through a destination tombstone=%s and outbox removal', async deleted => {
    const scope = await fixture(); const pair = await aliasPair(scope);
    const [layout] = await getTestDb().insert(topologyLayouts).values({ ...scope, view: 'overview', revision: 7n }).returning();
    await getTestDb().insert(topologyNodePositions).values([
      { ...scope, layoutId: layout!.id, nodeId: pair.a.id, x: 0, y: 0, revision: 2n, legacySourceRevision: deleted ? 20n : 2n, deletedAt: deleted ? new Date(0) : null },
      { ...scope, layoutId: layout!.id, nodeId: pair.b.id, x: 11, y: 22, pinned: true, revision: 4n, legacySourceRevision: 10n },
    ]);
    await publish(scope, input([{ ...pair.b, aliasTargetId: pair.a.id }], [], { inputRevision: '2' }));
    const before = (await getTestDb().select().from(topologyNodePositions))[0]!;
    expect(before).toMatchObject({ nodeId: pair.a.id, pinned: true, x: 11, legacySourceRevision: deleted ? 20n : 10n, revision: 5n, deletedAt: null });
    await getTestDb().delete(topologyChangeOutbox).where(eq(topologyChangeOutbox.siteId, scope.siteId));
    expect(await getTestDb().select().from(topologyChangeOutbox)).toHaveLength(0);
    // A retained/recovered old snapshot is delivered at a newer outbox ordinal.
    // Its source revision remains 5, and alias resolution must consult the
    // destination's durable fence rather than the now-removed outbox history.
    const sourceId = randomUUID(); const runId = randomUUID();
    const [event] = await getTestDb().insert(topologyChangeOutbox).values({ ...scope, eventKind: 'legacy.snapshot', aggregateId: sourceId, sourceRevision: 100n,
      idempotencyKey: `test-replay:${sourceId}`, payload: { version: 1, kind: 'legacy.snapshot', runId, sourceRevision: '5', item: { sourceTable: 'topology_layout', sourceId, data: { nodeType: 'discovered_asset', nodeId: pair.assetId, x: 99, y: 99, pinned: false, updatedBy: null } } } }).returning();
    await getTestDb().update(topologySiteState).set({ dirtyRevision: 100n }).where(eq(topologySiteState.siteId, scope.siteId));
    const result = await scoped(scope, async () => {
      await db.select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)).for('update');
      return replayLegacyBatch(scope, [event!], 2n, { version: 1, runId, capturedThrough: '20', snapshotThrough: '100', deliveredThrough: '2', status: 'staged', snapshotRows: 1, counts: emptyLegacyCounts(), mismatches: [] });
    });
    expect(result.counts.skipped).toBeGreaterThan(0); expect(result.counts.conflicted).toBe(0);
    expect((await getTestDb().select().from(topologyNodePositions))[0]).toEqual(before);
    expect((await getTestDb().select().from(topologyLayouts))[0]!.revision).toBe(8n);
  });

  it('publishes accepted identity while an asset UPDATE holds its row and waits in capture', async () => {
    const scope = await fixture(); const pair = await aliasPair(scope); const before = await state(scope);
    let signalState!: (pid: number) => void; const heldState = new Promise<number>(resolve => { signalState = resolve; });
    let allowPublish!: () => void; const mayPublish = new Promise<void>(resolve => { allowPublish = resolve; });
    const publisher = scoped(scope, async () => {
      await db.execute(sql`SET LOCAL statement_timeout = '8s'`);
      await db.select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)).for('update');
      signalState(Number((await db.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
      await mayPublish;
      return publishTopologyBuild(scope, input([{ ...pair.b, aliasTargetId: pair.a.id }], [], { inputRevision: '2' }));
    });
    const publisherSettled = publisher.then(value => ({ value }), error => ({ error }));
    let updater: Promise<unknown> | undefined; let updaterSettled: Promise<unknown> | undefined;
    try {
      const holder = await Promise.race([heldState, publisher.then(() => { throw new Error('Publisher exited before holding site state'); })]);
      let signalUpdater!: (pid: number) => void; const updaterStarted = new Promise<number>(resolve => { signalUpdater = resolve; });
      updater = scoped(scope, async () => {
        await db.execute(sql`SET LOCAL statement_timeout = '8s'`);
        signalUpdater(Number((await db.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
        // Label is in the capture projection, so this is a meaningful UPDATE.
        await db.update(discoveredAssets).set({ label: 'Changed while publishing' }).where(eq(discoveredAssets.id, pair.assetId));
      });
      updaterSettled = updater.then(() => ({ completed: true }), error => ({ error }));
      const waiter = await Promise.race([updaterStarted, updater.then(() => { throw new Error('Updater exited before signaling its backend'); })]);
      await waitForBlocking(waiter, holder);
      allowPublish();
      expect(await publisherSettled).toMatchObject({ value: { published: true } });
      expect(await updaterSettled).toEqual({ completed: true });
      expect((await state(scope))).toMatchObject({ materializedInputRevision: 2n, dirtyRevision: before.dirtyRevision + 1n });
      const events = await getTestDb().select().from(topologyChangeOutbox).where(and(eq(topologyChangeOutbox.aggregateId, pair.assetId), eq(topologyChangeOutbox.sourceRevision, before.dirtyRevision + 1n)));
      expect(events).toHaveLength(1); expect(events[0]!.payload).toMatchObject({ data: { label: 'Changed while publishing' } });
    } finally {
      allowPublish();
      await Promise.allSettled([publisherSettled, ...(updaterSettled ? [updaterSettled] : [])]);
    }
  });
});
