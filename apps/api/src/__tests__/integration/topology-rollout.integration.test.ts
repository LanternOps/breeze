import './setup';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { closeDb, db, withDbAccessContext } from '../../db';
import { topologyManualNodes, networkTopology, topologyLayout, topologyNodes, topologyRelationships, topologyNodePositions, topologySiteState, topologyChangeOutbox } from '../../db/schema';
import { importLegacyTopologySite, drainTopologyOutbox, compareLegacyTopology } from '../../services/topology/legacyImport';
import { runTopologyMigration } from '../../../scripts/topology-migrate';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());

describe('topology foundation rollout proof', () => {
  it('captures concurrent manual edits through a consumer crash, restart, drain and exact parity', async () => {
    const tenant = await createTopologyTenant();
    const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
    const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
    const [a, b] = await getTestDb().insert(topologyManualNodes).values([
      { ...scope, label: 'Router', role: 'router' }, { ...scope, label: 'Switch', role: 'switch' },
    ]).returning();
    const [edge] = await getTestDb().insert(networkTopology).values({ ...scope, sourceType: 'manual_node', sourceId: a!.id,
      targetType: 'manual_node', targetId: b!.id, connectionType: 'wired', method: 'manual', confidence: 'asserted' }).returning();
    const [position] = await getTestDb().insert(topologyLayout).values({ ...scope, nodeType: 'manual_node', nodeId: a!.id, x: 10, y: 20, pinned: true }).returning();
    const staged = await scoped(() => importLegacyTopologySite(scope, { batchSize: 1 }));
    expect(staged.complete).toBe(false);
    const before = (await getTestDb().select().from(topologySiteState))[0]!;
    const preservedId = (await getTestDb().select().from(topologyNodes))[0]!.id;
    let signalState!: (pid: number) => void;
    const heldState = new Promise<number>(resolve => { signalState = resolve; });
    let allowDrain!: () => void;
    const mayDrain = new Promise<void>(resolve => { allowDrain = resolve; });
    const consumer = scoped(async () => {
      await db.execute(sql`SET LOCAL statement_timeout='8s'`);
      await db.select().from(topologySiteState).where(eq(topologySiteState.siteId, scope.siteId)).for('update');
      signalState(Number((await db.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
      await mayDrain;
      expect((await drainTopologyOutbox(scope, { batchSize: 1000 })).complete).toBe(true);
      // A process loss before outer COMMIT must lose graph and ACKs together.
      throw new Error('simulated consumer crash before commit');
    });
    const crashed = consumer.then(() => 'unexpected commit', error => (error as Error).message);
    const writers: Promise<unknown>[] = [];
    try {
      const holder = await Promise.race([heldState, consumer.then(() => { throw new Error('Consumer exited early'); })]);
      const startWriter = (mutate: () => Promise<unknown>) => {
        let signal!: (pid: number) => void;
        const started = new Promise<number>(resolve => { signal = resolve; });
        const writer = scoped(async () => {
          await db.execute(sql`SET LOCAL statement_timeout='8s'`);
          signal(Number((await db.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid));
          await mutate();
        });
        writers.push(writer);
        // Register a rejection handler immediately; finally joins every writer.
        void writer.catch(() => undefined);
        return Promise.race([started, writer.then(() => { throw new Error('Writer exited early'); })]);
      };
      const positionWriter = await startWriter(() => db.update(topologyLayout).set({ x: 90, pinned: false }).where(eq(topologyLayout.id, position!.id)));
      const edgeWriter = await startWriter(() => db.delete(networkTopology).where(eq(networkTopology.id, edge!.id)));
      for (const waiter of [positionWriter, edgeWriter]) {
        let blocked = false;
        for (let attempt = 0; attempt < 250; attempt++) {
          // The second writer may queue behind the first on the same state
          // tuple. Follow the wait chain instead of requiring a direct edge.
          const rows = await getTestDb().execute(sql`WITH RECURSIVE wait_chain(pid) AS (
            SELECT unnest(pg_blocking_pids(${waiter}::int))
            UNION SELECT unnest(pg_blocking_pids(pid)) FROM wait_chain
          ) SELECT EXISTS(SELECT 1 FROM wait_chain WHERE pid=${holder}::int) AS blocked`);
          if (rows[0]?.blocked === true) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
      }
      allowDrain();
      expect(await crashed).toBe('simulated consumer crash before commit');
      await Promise.all(writers);
      const afterCrash = (await getTestDb().select().from(topologySiteState))[0]!;
      expect(afterCrash.materializedInputRevision).toBe(before.materializedInputRevision);
      expect(afterCrash.dirtyRevision).toBe(before.dirtyRevision + 2n);
      expect((await getTestDb().select().from(topologyChangeOutbox).where(isNull(topologyChangeOutbox.deliveredAt))).length).toBeGreaterThan(2);
      const resumed = await runTopologyMigration({ command: 'backfill', ...scope, resumeToken: staged.runId, batchSize: 1000 });
      expect(resumed.exitCode).toBe(0);
      const barrier = (await getTestDb().select().from(topologySiteState))[0]!.dirtyRevision.toString();
      expect((await runTopologyMigration({ command: 'drain', ...scope, throughRevision: barrier, batchSize: 1000 })).exitCode).toBe(0);
      const report = await scoped(() => compareLegacyTopology(scope, { throughRevision: barrier }));
      expect(report.pendingThroughBarrier).toBe(0);
      expect(report.unexplainedManualDifferences).toEqual([]);
      expect(report.unexplainedPinDifferences).toEqual([]);
      expect(report.resurrectedTombstones).toEqual([]);
      expect(report.ok).toBe(true);
      expect((await getTestDb().select().from(topologyNodes)).some(row => row.id === preservedId)).toBe(true);
      expect((await getTestDb().select().from(topologyNodePositions))[0]).toMatchObject({ x: 90, y: 20, pinned: false });
      expect((await getTestDb().select().from(topologyRelationships))[0]!.deletedAt).not.toBeNull();
      expect((await runTopologyMigration({ command: 'compare', ...scope, throughRevision: barrier, batchSize: 1000 })).exitCode).toBe(0);
    } finally {
      allowDrain();
      await Promise.allSettled([crashed, ...writers]);
    }
  });

  it('refuses CLI backfill before writes when capture is absent and safely reapplies lifecycle hooks', async () => {
    const tenant = await createTopologyTenant();
    const scope = { orgId: tenant.orgId, siteId: tenant.siteId };
    await getTestDb().execute(sql`ALTER TABLE topology_layout DISABLE TRIGGER topology_capture_legacy_change`);
    try {
      await expect(runTopologyMigration({ command: 'backfill', ...scope, batchSize: 1000 })).rejects.toThrow(/capture/);
      for (const table of [topologyNodes, topologyChangeOutbox, topologySiteState]) {
        expect(await getTestDb().select().from(table).where(and(eq(table.orgId, scope.orgId), eq(table.siteId, scope.siteId)))).toHaveLength(0);
      }
    } finally { await getTestDb().execute(sql`ALTER TABLE topology_layout ENABLE TRIGGER topology_capture_legacy_change`); }
    const migration = readFileSync(new URL('../../../migrations/2026-10-17-150300-topology-inventory-lifecycle.sql', import.meta.url), 'utf8');
    await getTestDb().transaction(async tx => { await tx.execute(sql.raw(migration)); await tx.execute(sql.raw(migration)); });
    const triggers = await getTestDb().execute(sql`SELECT tgname FROM pg_trigger WHERE tgname='breeze_topology_inventory_lifecycle' AND NOT tgisinternal`);
    expect(triggers).toHaveLength(3);
  });
});
