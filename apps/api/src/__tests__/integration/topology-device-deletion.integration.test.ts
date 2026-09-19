import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import { closeDb, db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { auditLogs, devices, discoveredAssets, topologyManualNodes, topologyNodes, topologyNodeBindings, topologyRelationships, topologyLayouts, topologyNodePositions, topologySiteState, topologyChangeOutbox } from '../../db/schema';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import { importLegacyTopologySite } from '../../services/topology/legacyImport';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { legacyNodeIdentity } from '../../services/topology/legacyProjection';
import { publishTopologyBuild } from '../../services/topology/publish';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());
const system = <T>(work: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(work));
async function fixture() {
  const tenant = await createTopologyTenant(); const scope = { orgId: tenant.orgId, siteId: tenant.siteId }; const database = getTestDb();
  const [device] = await database.insert(devices).values({ ...scope, agentId: randomUUID(), hostname: 'Delete this inventory', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' }).returning();
  const [manual] = await database.insert(topologyManualNodes).values({ ...scope, label: 'Manual peer', role: 'switch', notes: 'Keep operator notes' }).returning();
  expect((await withDbAccessContext(orgContext(scope.orgId), () => importLegacyTopologySite(scope))).complete).toBe(true);
  const [node] = await database.select().from(topologyNodes).where(eq(topologyNodes.identityKey, legacyNodeIdentity(scope, 'devices', device!.id).identityKey));
  const [peer] = await database.select().from(topologyNodes).where(eq(topologyNodes.identityKey, legacyNodeIdentity(scope, 'topology_manual_nodes', manual!.id).identityKey));
  const sourceKey = `manual:${randomUUID()}`;
  await database.insert(topologyRelationships).values({ ...scope, kind: 'attachment', sourceNodeId: node!.id, targetNodeId: peer!.id,
    canonicalKey: canonicalIdentityKey(scope, 'attachment', sourceKey), identityMaterial: { version: 1, kind: 'attachment', sourceKey },
    evidenceClass: 'manual', confidence: 'asserted', attributes: { notes: 'Keep this asserted connection' } });
  const [layout] = await database.insert(topologyLayouts).values({ ...scope, view: 'overview', revision: 7n }).returning();
  await database.insert(topologyNodePositions).values({ ...scope, layoutId: layout!.id, nodeId: node!.id, x: 13, y: 27, pinned: true, positionSource: 'user', revision: 3n });
  // A valid newer captured input makes the stale-publication assertion depend
  // on the deletion fence, not on inputRevision already being materialized.
  await database.update(topologyManualNodes).set({ label: 'Pending unrelated edit' }).where(eq(topologyManualNodes.id, manual!.id));
  return { scope, deviceId: device!.id, nodeId: node!.id };
}
async function snapshot(siteId: string) {
  const database = getTestDb();
  return {
    state: (await database.select().from(topologySiteState).where(eq(topologySiteState.siteId, siteId)))[0]!,
    devices: await database.select().from(devices).where(eq(devices.siteId, siteId)),
    nodes: await database.select().from(topologyNodes).where(eq(topologyNodes.siteId, siteId)),
    bindings: await database.select().from(topologyNodeBindings).where(eq(topologyNodeBindings.siteId, siteId)),
    relationships: await database.select().from(topologyRelationships).where(eq(topologyRelationships.siteId, siteId)),
    layouts: await database.select().from(topologyLayouts).where(eq(topologyLayouts.siteId, siteId)),
    positions: await database.select().from(topologyNodePositions).where(eq(topologyNodePositions.siteId, siteId)),
    outbox: await database.select().from(topologyChangeOutbox).where(eq(topologyChangeOutbox.siteId, siteId)),
    audits: await database.select().from(auditLogs).where(eq(auditLogs.action, 'topology.binding_detached')),
  };
}
const cascade = (deviceId: string) => system(() => db.transaction(tx => deleteDeviceCascade(tx as unknown as DeviceDeletionTx, deviceId)));
async function waitForBlocking(waiter: number, holder: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const rows = await getTestDb().execute(sql`SELECT ${holder}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`);
    if (rows[0]?.blocked === true) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Device cascade never waited on the linked asset holder');
}

describe('permanent device cascade preserves topology lifecycle', () => {
  it('detaches and fences before registry deletion, preserving history and another tenant', async () => {
    const f = await fixture(); const other = await fixture(); const before = await snapshot(f.scope.siteId); const foreign = await snapshot(other.scope.siteId);
    expect(before.bindings.some(binding => binding.deviceId === f.deviceId)).toBe(true);
    expect(before.state.dirtyRevision).toBeGreaterThan(before.state.materializedInputRevision);
    await cascade(f.deviceId);
    const after = await snapshot(f.scope.siteId);
    expect(after.devices).toHaveLength(0);
    expect(after.bindings.some(binding => binding.deviceId === f.deviceId)).toBe(false);
    expect.soft(after.state.buildFence).toBe(before.state.buildFence + 1n);
    expect.soft(after.state.graphRevision).toBe(before.state.graphRevision + 1n);
    expect(after.state.materializedInputRevision).toBe(before.state.materializedInputRevision);
    expect(after.state.dirtyRevision).toBe(before.state.dirtyRevision + 1n);
    expect.soft(after.audits).toHaveLength(1);
    expect.soft(after.audits[0]).toMatchObject({ orgId: f.scope.orgId, resourceId: f.nodeId, details: { inventoryId: f.deviceId, oldOrgId: f.scope.orgId, oldSiteId: f.scope.siteId, reason: 'inventory_deleted' } });
    expect(after.outbox.filter(event => event.aggregateId === f.deviceId && event.deliveredAt === null)).toHaveLength(1);
    expect(after.nodes).toEqual(before.nodes); expect(after.relationships).toEqual(before.relationships);
    expect(after.layouts).toEqual(before.layouts); expect(after.positions).toEqual(before.positions);
    const foreignAfter = await snapshot(other.scope.siteId);
    expect({ ...foreignAfter, audits: [] }).toEqual({ ...foreign, audits: [] });
    expect(await withDbAccessContext(orgContext(f.scope.orgId), () => publishTopologyBuild(f.scope, {
      buildFence: before.state.buildFence.toString(), inputRevision: before.state.dirtyRevision.toString(), nodes: [], relationships: [], bindings: [],
    }))).toEqual({ published: false, graphRevision: after.state.graphRevision.toString() });
    await cascade(f.deviceId);
    expect(await snapshot(f.scope.siteId)).toEqual(after);
  });

  it('rolls the detachment, audit, graph fence and inventory deletion back with the enclosing transaction', async () => {
    const f = await fixture(); const before = await snapshot(f.scope.siteId);
    await expect(system(() => db.transaction(async tx => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, f.deviceId);
      await tx.execute(sql`SELECT 1/0`);
    }))).rejects.toThrow();
    expect(await snapshot(f.scope.siteId)).toEqual(before);
  });

  it('lets an older linked-asset edit commit before taking the topology lifecycle lock', async () => {
    const f = await fixture();
    const [asset] = await getTestDb().insert(discoveredAssets).values({ ...f.scope,
      ipAddress: '192.0.2.88', label: 'Original label', linkedDeviceId: f.deviceId, linkSource: 'manual',
    }).returning();
    const before = await snapshot(f.scope.siteId);
    let held!: (pid: number) => void;
    const assetHeld = new Promise<number>(resolve => { held = resolve; });
    let allowEdit!: () => void;
    const editMayRun = new Promise<void>(resolve => { allowEdit = resolve; });
    const writer = system(async () => {
      await db.execute(sql`SET LOCAL statement_timeout='8s'`);
      await db.execute(sql`SELECT id FROM discovered_assets WHERE id=${asset!.id} FOR UPDATE`);
      held(Number((await db.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
      await editMayRun;
      // This real source write must acquire capture's site-state lock while
      // still holding the asset row. An early cascade hook inverts that order.
      await db.update(discoveredAssets).set({ label: 'Concurrent edit survives' }).where(eq(discoveredAssets.id, asset!.id));
    });
    const writerResult = writer.then(() => ({ completed: true }), error => ({ code: pgErrorCode(error) }));
    let deleting: Promise<unknown> | undefined;
    try {
      const holderPid = await Promise.race([assetHeld, writer.then(() => { throw new Error('Writer finished before taking asset lock'); })]);
      let started!: (pid: number) => void;
      const cascadeStarted = new Promise<number>(resolve => { started = resolve; });
      deleting = system(() => db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
        started(Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
        await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, f.deviceId);
      }));
      const deletionResult = deleting.then(() => ({ completed: true }), error => ({ code: pgErrorCode(error) }));
      const waiterPid = await Promise.race([cascadeStarted, deleting.then(() => { throw new Error('Cascade finished before starting'); })]);
      await waitForBlocking(waiterPid, holderPid);
      allowEdit();
      // Either deadlock victim is a regression: both business operations must
      // commit. Do not depend on PostgreSQL choosing a particular victim.
      expect(await Promise.all([writerResult, deletionResult])).toEqual([{ completed: true }, { completed: true }]);
    } finally {
      allowEdit();
      await Promise.allSettled([writer, deleting]);
    }
    const after = await snapshot(f.scope.siteId);
    const [retainedAsset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, asset!.id));
    expect(retainedAsset).toMatchObject({ label: 'Concurrent edit survives', linkedDeviceId: null, linkSource: null });
    expect(after.devices).toHaveLength(0);
    expect(after.bindings.some(binding => binding.deviceId === f.deviceId)).toBe(false);
    expect(after.state.buildFence).toBe(before.state.buildFence + 1n);
    expect(after.state.graphRevision).toBe(before.state.graphRevision + 1n);
    expect(after.state.dirtyRevision).toBe(before.state.dirtyRevision + 3n);
    expect(after.state.materializedInputRevision).toBe(before.state.materializedInputRevision);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ orgId: f.scope.orgId, resourceId: f.nodeId, details: { inventoryId: f.deviceId, reason: 'inventory_deleted' } });
    expect(after.nodes).toEqual(before.nodes); expect(after.relationships).toEqual(before.relationships);
    expect(after.layouts).toEqual(before.layouts); expect(after.positions).toEqual(before.positions);
    expect(await withDbAccessContext(orgContext(f.scope.orgId), () => publishTopologyBuild(f.scope, {
      buildFence: before.state.buildFence.toString(), inputRevision: before.state.dirtyRevision.toString(), nodes: [], relationships: [], bindings: [],
    }))).toEqual({ published: false, graphRevision: after.state.graphRevision.toString() });
  });
});
