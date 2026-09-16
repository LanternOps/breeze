import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { closeDb, db, withDbAccessContext } from '../../db';
import { discoveredAssets, devices, networkTopology, topologyLayout, topologyManualNodes, topologyNodes, topologyRelationships, topologyNodeBindings, topologyNodePositions, topologyLayouts, topologySiteState, topologyChangeOutbox, organizations } from '../../db/schema';
import { compareLegacyTopology, drainTopologyOutbox, getLegacyTopologyStatus, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { getTopologyCaptureStatus, LEGACY_CAPTURE_TABLES } from '../../services/topology/legacyImportState';
import { pruneDeliveredTopologyOutbox } from '../../services/topology/legacyRetention';
import { legacyNodeIdentity } from '../../services/topology/legacyProjection';
import { runTopologyRepairTick } from '../../jobs/topologyOutboxWorker';
import { executeTopologyMigration, runTopologyMigration } from '../../../scripts/topology-migrate';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());
const scoped = <T>(scope: TopologyScope, fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
const tenant = async () => { const row = await createTopologyTenant(); return { orgId: row.orgId, siteId: row.siteId }; };
async function finish(scope: TopologyScope) {
  let result = await scoped(scope, () => importLegacyTopologySite(scope));
  for (let n = 0; !result.complete && n < 30; n++) result = await scoped(scope, () => drainTopologyOutbox(scope));
  expect(result.complete).toBe(true); return result;
}
async function drain(scope: TopologyScope) {
  let result = await scoped(scope, () => drainTopologyOutbox(scope));
  for (let n = 0; !result.complete && n < 30; n++) result = await scoped(scope, () => drainTopologyOutbox(scope));
  expect(result.complete).toBe(true); return result;
}
async function seed(scope: TopologyScope) {
  const database = getTestDb();
  const [manual] = await database.insert(topologyManualNodes).values({ ...scope, label: 'Core', role: 'switch', notes: 'Keep me' }).returning();
  const [device] = await database.insert(devices).values({ ...scope, agentId: randomUUID(), hostname: 'managed', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1' }).returning();
  const [asset] = await database.insert(discoveredAssets).values({ ...scope, ipAddress: '192.0.2.20', hostname: 'discovered', linkedDeviceId: device!.id, linkSource: 'manual' }).returning();
  const [edge] = await database.insert(networkTopology).values({ ...scope, sourceType: 'manual_node', sourceId: manual!.id, targetType: 'discovered_asset', targetId: asset!.id, connectionType: 'wired', method: 'manual', confidence: 'asserted' }).returning();
  const [position] = await database.insert(topologyLayout).values({ ...scope, nodeType: 'manual_node', nodeId: manual!.id, x: 42, y: 24, pinned: true }).returning();
  return { manual: manual!, device: device!, asset: asset!, edge: edge!, position: position! };
}
async function withoutCapture<T>(fn: () => Promise<T>): Promise<T> {
  const database = getTestDb();
  for (const table of LEGACY_CAPTURE_TABLES) await database.execute(sql`ALTER TABLE ${sql.identifier(table)} DISABLE TRIGGER topology_capture_legacy_change`);
  try { return await fn(); }
  finally { for (const table of LEGACY_CAPTURE_TABLES) await database.execute(sql`ALTER TABLE ${sql.identifier(table)} ENABLE TRIGGER topology_capture_legacy_change`); }
}

describe('restartable topology legacy import, drain and shadow parity', () => {
  it('refuses missing capture before any import writes and CLI returns nonzero', async () => {
    const scope = await tenant();
    await getTestDb().execute(sql`ALTER TABLE topology_layout DISABLE TRIGGER topology_capture_legacy_change`);
    try {
      expect(await scoped(scope, () => getTopologyCaptureStatus(scope))).toMatchObject({ complete: false, missing: ['topology_layout'] });
      await expect(scoped(scope, () => importLegacyTopologySite(scope))).rejects.toThrow(/capture/);
      expect((await scoped(scope, () => executeTopologyMigration({ command: 'capture-status', ...scope, batchSize: 200 }))).exitCode).toBe(2);
      expect(await getTestDb().select().from(topologySiteState)).toHaveLength(0);
      expect(await getTestDb().select().from(topologyChangeOutbox)).toHaveLength(0);
    } finally { await getTestDb().execute(sql`ALTER TABLE topology_layout ENABLE TRIGGER topology_capture_legacy_change`); }
  });

  it('restarts between batches with the same run/UUIDs, imports accepted links and conservatively pins old positions', async () => {
    const scope = await tenant();
    const source = await withoutCapture(() => seed(scope));
    await withoutCapture(() => getTestDb().update(topologyLayout).set({ pinned: false }).where(eq(topologyLayout.id, source.position.id)));
    const first = await scoped(scope, () => importLegacyTopologySite(scope, { batchSize: 1 }));
    expect(first).toMatchObject({ capturedThrough: '0', complete: false, pendingThroughBarrier: 5 });
    const partial = await getTestDb().select().from(topologyNodes);
    expect(partial).toHaveLength(1);
    await expect(scoped(scope, () => importLegacyTopologySite(scope, { resumeToken: randomUUID() }))).rejects.toThrow(/resume/);
    const resumed = await scoped(scope, () => importLegacyTopologySite(scope, { resumeToken: first.runId, batchSize: 1000 }));
    expect(resumed.complete).toBe(true); expect(resumed.runId).toBe(first.runId);
    const nodes = await getTestDb().select().from(topologyNodes);
    expect(nodes.some(node => node.id === partial[0]!.id)).toBe(true);
    expect(nodes.filter(node => !node.aliasTargetId)).toHaveLength(2);
    const bindings = await getTestDb().select().from(topologyNodeBindings);
    expect(bindings.find(b => b.deviceId === source.device.id)!.nodeId).toBe(bindings.find(b => b.discoveredAssetId === source.asset.id)!.nodeId);
    expect((await getTestDb().select().from(topologyNodePositions))[0]).toMatchObject({ x: 42, y: 24, pinned: true, positionSource: 'legacy' });
    const before = await scoped(scope, () => getLegacyTopologyStatus(scope));
    await scoped(scope, () => importLegacyTopologySite(scope));
    expect(await scoped(scope, () => getLegacyTopologyStatus(scope))).toEqual(before);
    expect(await scoped(scope, () => compareLegacyTopology(scope))).toMatchObject({ ok: true, pendingThroughBarrier: 0, unexplainedManualDifferences: [], unexplainedPinDifferences: [] });
  });

  it('drains edits/deletes after the snapshot, retains tombstones and keeps graph revision stable for layout-only echoes', async () => {
    const scope = await tenant(); const source = await seed(scope); await finish(scope);
    const before = await scoped(scope, () => getLegacyTopologyStatus(scope));
    await getTestDb().update(topologyLayout).set({ x: 80, pinned: false }).where(eq(topologyLayout.id, source.position.id));
    await drain(scope);
    expect((await scoped(scope, () => getLegacyTopologyStatus(scope))).graphRevision).toBe(before.graphRevision);
    const [layout] = await getTestDb().select().from(topologyLayouts);
    const [position] = await getTestDb().select().from(topologyNodePositions);
    expect(position).toMatchObject({ x: 80, pinned: false });
    await drain(scope);
    expect((await getTestDb().select().from(topologyLayouts))[0]!.revision).toBe(layout!.revision);
    // A v2 CAS save mirrors to legacy in the same transaction. The captured
    // echo acknowledges its source fence without relabelling or incrementing
    // the canonical user position/layout a second time.
    await getTestDb().update(topologyNodePositions).set({ x: 81, positionSource: 'user', revision: sql`${topologyNodePositions.revision}+1` }).where(eq(topologyNodePositions.nodeId, position!.nodeId));
    await getTestDb().update(topologyLayouts).set({ revision: sql`${topologyLayouts.revision}+1` }).where(eq(topologyLayouts.id, layout!.id));
    const [saved] = await getTestDb().select().from(topologyNodePositions);
    await getTestDb().update(topologyLayout).set({ x: 81 }).where(eq(topologyLayout.id, source.position.id));
    await drain(scope);
    expect((await getTestDb().select().from(topologyNodePositions))[0]).toMatchObject({ positionSource: 'user', revision: saved!.revision });
    expect((await getTestDb().select().from(topologyLayouts))[0]!.revision).toBe(layout!.revision + 1n);
    await getTestDb().update(topologyManualNodes).set({ label: 'Renamed', notes: null }).where(eq(topologyManualNodes.id, source.manual.id));
    await getTestDb().delete(networkTopology).where(eq(networkTopology.id, source.edge.id));
    await getTestDb().delete(topologyLayout).where(eq(topologyLayout.id, source.position.id));
    await drain(scope);
    expect((await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.legacySourceId, source.manual.id)))[0]).toMatchObject({ labelOverride: 'Renamed', attributes: { notes: '' } });
    expect((await getTestDb().select().from(topologyRelationships))[0]!.deletedAt).not.toBeNull();
    expect((await getTestDb().select().from(topologyNodePositions))[0]!.deletedAt).not.toBeNull();
    expect(await scoped(scope, () => compareLegacyTopology(scope))).toMatchObject({ ok: true, resurrectedTombstones: [] });
  });

  it('never merges reused addresses across scopes and hides a foreign site even with a valid resume token', async () => {
    const scope = await tenant(); const other = await tenant();
    await seed(scope); await seed(other); await finish(scope); const foreign = await finish(other);
    const nodes = await getTestDb().select().from(topologyNodes);
    expect(new Set(nodes.map(n => n.id)).size).toBe(nodes.length);
    await expect(scoped(scope, () => importLegacyTopologySite(other, { resumeToken: foreign.runId }))).rejects.toThrow(/inaccessible/);
  });

  it('quarantines missing endpoint references and refuses parity until manual differences are resolved', async () => {
    const scope = await tenant();
    await getTestDb().insert(networkTopology).values({ ...scope, sourceType: 'discovered_asset', sourceId: randomUUID(), targetType: 'discovered_asset', targetId: randomUUID(), connectionType: 'wired', method: 'manual' });
    await finish(scope);
    const parity = await scoped(scope, () => compareLegacyTopology(scope));
    expect(parity).toMatchObject({ ok: false, unexplainedManualDifferenceCount: 1 });
    expect(parity.conflicted).toBeGreaterThan(0); expect(parity.mismatchIds[0]).toMatch(/^[a-f0-9]{24}$/);
    expect((await scoped(scope, () => executeTopologyMigration({ command: 'compare', ...scope, batchSize: 200 }))).exitCode).toBe(2);
  });

  it('rolls back canonical rows and ACKs when a caller catches a failed drain and continues', async () => {
    const scope = await tenant(); const source = await seed(scope); await finish(scope);
    await getTestDb().update(topologyManualNodes).set({ label: 'Must roll back' }).where(eq(topologyManualNodes.id, source.manual.id));
    const [event] = await getTestDb().select().from(topologyChangeOutbox).where(and(eq(topologyChangeOutbox.siteId, scope.siteId), sql`${topologyChangeOutbox.deliveredAt} IS NULL`));
    // Cause a late layout failure after publisher has written the first event.
    await getTestDb().update(topologySiteState).set({ dirtyRevision: sql`${topologySiteState.dirtyRevision}+1` }).where(eq(topologySiteState.siteId, scope.siteId));
    const [state] = await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId));
    const invalidSourceId = randomUUID();
    const invalid = { ...event!.payload, newIdentity: { ...scope, sourceId: invalidSourceId }, oldIdentity: null, type: 'layout.upsert', sourceTable: 'topology_layout', sourceId: invalidSourceId, data: { nodeType: 'manual_node', nodeId: source.manual.id, x: 9999, y: 2, pinned: true, updatedBy: null }, sourceRevision: state!.dirtyRevision.toString() };
    await getTestDb().insert(topologyChangeOutbox).values({ ...scope, eventKind: 'layout.upsert', aggregateId: invalid.sourceId, sourceRevision: state!.dirtyRevision, idempotencyKey: randomUUID(), payload: invalid });
    await getTestDb().execute(sql`CREATE FUNCTION topology_test_reject_position() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.x=9999 THEN RAISE EXCEPTION 'test late position failure'; END IF; RETURN NEW; END $$`);
    await getTestDb().execute(sql`CREATE TRIGGER topology_test_reject_position BEFORE INSERT OR UPDATE ON topology_node_positions FOR EACH ROW EXECUTE FUNCTION topology_test_reject_position()`);
    try { await scoped(scope, async () => {
      await expect(drainTopologyOutbox(scope)).rejects.toThrow();
      const [node] = await db.select().from(topologyNodes).where(eq(topologyNodes.legacySourceId, source.manual.id));
      expect(node!.labelOverride).toBe('Core');
      expect((await db.select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)))[0]!.materializedInputRevision).toBe(state!.materializedInputRevision);
      await db.execute(sql`SELECT 1`); // savepoint rollback leaves caller usable
    }); } finally {
      await getTestDb().execute(sql`DROP TRIGGER topology_test_reject_position ON topology_node_positions`);
      await getTestDb().execute(sql`DROP FUNCTION topology_test_reject_position()`);
    }
    expect((await getTestDb().select().from(topologyChangeOutbox).where(eq(topologyChangeOutbox.id, event!.id)))[0]!.deliveredAt).toBeNull();
  });

  it('captures a writer that changed its source row before waiting for the snapshot lock', async () => {
    const scope = await tenant(); const source = await seed(scope);
    let writer: Promise<unknown> | undefined;
    await scoped(scope, async () => {
      await db.select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)).for('update');
      let writerPid = 0;
      let announce!: () => void; const announced = new Promise<void>(resolve => { announce = resolve; });
      writer = getTestDb().transaction(async tx => {
        const pid = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`); writerPid = pid[0]!.pid; announce();
        await tx.update(topologyManualNodes).set({ label: 'Late writer' }).where(eq(topologyManualNodes.id, source.manual.id));
      });
      await announced;
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const locks = await getTestDb().execute<{ blocked: boolean }>(sql`SELECT cardinality(pg_blocking_pids(${writerPid}))>0 AS blocked`);
        if (locks[0]!.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      await importLegacyTopologySite(scope, { batchSize: 1000 });
      expect((await db.select().from(topologyNodes).where(eq(topologyNodes.legacySourceId, source.manual.id)))[0]!.labelOverride).toBe('Core');
    });
    await writer;
    await drain(scope);
    expect((await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.legacySourceId, source.manual.id)))[0]!.labelOverride).toBe('Late writer');
    expect(await scoped(scope, () => compareLegacyTopology(scope))).toMatchObject({ ok: true });
  });

  it('retains unresolved deletion fences past seven days while pruning delivered snapshots and preserving pending rows', async () => {
    const scope = await tenant(); const source = await seed(scope);
    await getTestDb().delete(networkTopology).where(eq(networkTopology.id, source.edge.id));
    await finish(scope);
    expect(await getTestDb().select().from(topologyRelationships)).toHaveLength(1);
    // An edge created and deleted before capture/import has no canonical
    // endpoints. Its captured tombstone alone must survive ordinary retention.
    const [orphan] = await withoutCapture(() => getTestDb().insert(networkTopology).values({ ...scope, sourceType: 'discovered_asset', sourceId: source.asset.id, targetType: 'manual_node', targetId: source.manual.id, method: 'manual', connectionType: 'wired' }).returning());
    await getTestDb().delete(networkTopology).where(eq(networkTopology.id, orphan!.id)); await drain(scope);
    await getTestDb().update(topologyChangeOutbox).set({ deliveredAt: new Date(Date.now() - 8 * 86_400_000) }).where(sql`${topologyChangeOutbox.deliveredAt} IS NOT NULL`);
    await getTestDb().update(topologyManualNodes).set({ label: 'Pending' }).where(eq(topologyManualNodes.id, source.manual.id));
    expect(await scoped(scope, () => pruneDeliveredTopologyOutbox(scope))).toBeGreaterThan(0);
    const retained = await getTestDb().select().from(topologyChangeOutbox);
    expect(retained.some(row => row.aggregateId === orphan!.id && row.eventKind === 'relationship.delete')).toBe(true);
    expect(retained.some(row => row.deliveredAt === null)).toBe(true);
    expect(retained.some(row => row.eventKind === 'legacy.snapshot')).toBe(false);
    await drain(scope);
    // Both real endpoint nodes exist. Without the retained source fence this
    // valid older snapshot would resurrect the deleted relation.
    const tombstone = retained.find(row => row.aggregateId === orphan!.id && row.eventKind === 'relationship.delete')!;
    await getTestDb().update(topologySiteState).set({ dirtyRevision: sql`${topologySiteState.dirtyRevision}+1` }).where(eq(topologySiteState.siteId, scope.siteId));
    const [state] = await getTestDb().select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId));
    await getTestDb().insert(topologyChangeOutbox).values({ ...scope, eventKind: 'legacy.snapshot', aggregateId: orphan!.id, sourceRevision: state!.dirtyRevision, idempotencyKey: randomUUID(),
      payload: { version: 1, kind: 'legacy.snapshot', runId: randomUUID(), sourceRevision: (tombstone.sourceRevision - 1n).toString(), item: { sourceTable: 'network_topology', sourceId: orphan!.id,
        data: { sourceType: 'discovered_asset', sourceId: source.asset.id, targetType: 'manual_node', targetId: source.manual.id, method: 'manual', connectionType: 'wired', interfaceName: null, vlan: null, bandwidth: null, createdBy: null } } } });
    await drain(scope);
    expect(await getTestDb().select().from(topologyRelationships).where(eq(topologyRelationships.legacySourceId, orphan!.id))).toHaveLength(0);
    expect(await scoped(scope, () => compareLegacyTopology(scope))).toMatchObject({ ok: true, resurrectedTombstones: [] });
  });

  it('repairs accepted events with a registered DB tick and flags off prevents materialization', async () => {
    const scope = await tenant(); const source = await seed(scope); await finish(scope);
    await getTestDb().update(topologyManualNodes).set({ label: 'Accepted while Redis is irrelevant' }).where(eq(topologyManualNodes.id, source.manual.id));
    await runTopologyRepairTick();
    expect((await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.legacySourceId, source.manual.id)))[0]!.labelOverride).toBe('Core');
    await getTestDb().update(organizations).set({ settings: { topologyFeatureFlags: { materialization: true } } }).where(eq(organizations.id, scope.orgId));
    await runTopologyRepairTick();
    expect((await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.legacySourceId, source.manual.id)))[0]!.labelOverride).toBe('Accepted while Redis is irrelevant');
    expect(await scoped(scope, () => compareLegacyTopology(scope))).toMatchObject({ ok: true });
  });

  it('fails comparison at an outdated barrier and audits scoped operator invocations', async () => {
    const scope = await tenant(); await seed(scope); const imported = await finish(scope);
    const [manual] = await getTestDb().select().from(topologyManualNodes);
    await getTestDb().update(topologyManualNodes).set({ label: 'Newer than barrier' }).where(eq(topologyManualNodes.id, manual!.id));
    expect(await scoped(scope, () => compareLegacyTopology(scope, { throughRevision: imported.barrierRevision }))).toMatchObject({ ok: false, sameBarrier: false });
    const result = await runTopologyMigration({ command: 'drain', ...scope, batchSize: 200 }); expect(result.exitCode).toBe(0);
    const audit = await getTestDb().execute(sql`SELECT action,details FROM audit_logs WHERE org_id=${scope.orgId}::uuid AND action='topology.migration.drain'`);
    expect(audit).toHaveLength(1); expect(audit[0]!.details).toMatchObject({ siteId: scope.siteId, command: 'drain', exitCode: 0 });
    const identity = legacyNodeIdentity(scope, 'topology_manual_nodes', manual!.id);
    expect((await getTestDb().select().from(topologyNodes).where(eq(topologyNodes.identityKey, identity.identityKey)))[0]!.labelOverride).toBe('Newer than barrier');
  });
});
