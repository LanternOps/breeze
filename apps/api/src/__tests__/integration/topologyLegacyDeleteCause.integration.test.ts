import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { closeDb, db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { discoveredAssets, networkTopology, topologyChangeOutbox, topologyRelationships } from '../../db/schema';
import { drainTopologyOutbox, importLegacyTopologySite } from '../../services/topology/legacyImport';
import { reconcileTopology } from '../../jobs/reconcileTopology';
import { cleanupSpeculativeTopologyLinks } from '../../jobs/discoveryWorker';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

/**
 * M2 D5: legacy collector-absence cleanup (reconcileTopology age-out,
 * discoveryWorker speculative ethernet/routed cleanup) is tagged with a
 * transaction-local `breeze.topology_delete_cause`; the capture trigger
 * records it and legacy replay turns such a tombstone into support expiry
 * (lifecycle archived, never deleted) while any other delete still withdraws.
 */
afterAll(() => closeDb());
const tenant = async (): Promise<TopologyScope> => { const t = await createTopologyTenant(); return { orgId: t.orgId, siteId: t.siteId }; };
const scoped = <T>(scope: TopologyScope, fn: () => Promise<T>) => withDbAccessContext(orgContext(scope.orgId), fn);
async function settle(scope: TopologyScope, first: () => Promise<{ complete: boolean }>) {
  let result = await scoped(scope, first);
  for (let n = 0; !result.complete && n < 30; n++) result = await scoped(scope, () => drainTopologyOutbox(scope));
  expect(result.complete).toBe(true);
}

async function seed(scope: TopologyScope) {
  const database = getTestDb();
  const asset = async (ip: string) => (await database.insert(discoveredAssets).values({ ...scope, ipAddress: ip, hostname: `h-${ip}` }).returning())[0]!;
  const [a, b, c, d] = [await asset('192.0.2.30'), await asset('192.0.2.31'), await asset('192.0.2.32'), await asset('192.0.2.33')];
  const edge = async (sourceId: string, targetId: string, method: string, connectionType: string) => (await database.insert(networkTopology).values({ ...scope,
    sourceType: 'discovered_asset', sourceId, targetType: 'discovered_asset', targetId, connectionType, method, confidence: 'high', lastVerifiedAt: new Date(Date.now() - 86_400_000) }).returning())[0]!;
  return {
    aged: await edge(a.id, b.id, 'lldp', 'infra'),        // collector absence: reconcileTopology age-out
    speculative: await edge(c.id, d.id, 'cdp', 'ethernet'), // collector absence: speculative-link cleanup
    removed: await edge(b.id, c.id, 'lldp', 'infra'),       // ordinary delete (user/inventory)
  };
}
const relationship = async (legacySourceId: string) =>
  (await getTestDb().select().from(topologyRelationships).where(eq(topologyRelationships.legacySourceId, legacySourceId)))[0];
const deleteEvents = async (scope: TopologyScope) => (await getTestDb().select().from(topologyChangeOutbox)
  .where(sql`${topologyChangeOutbox.orgId}=${scope.orgId}::uuid AND ${topologyChangeOutbox.eventKind}='relationship.delete'`))
  .map(row => ({ sourceId: row.aggregateId, cause: (row.payload as { cause?: string }).cause ?? null }));

describe('legacy collector-absence delete cause (D5)', () => {
  it('archives collector-absence tombstones and still withdraws ordinary deletes', async () => {
    const scope = await tenant();
    const edges = await seed(scope);
    await settle(scope, () => importLegacyTopologySite(scope));
    for (const edge of Object.values(edges)) expect(await relationship(edge.id)).toMatchObject({ lifecycle: 'active', deletedAt: null });

    await withSystemDbAccessContext(async () => {
      // A walked switch (192.0.2.30) reporting no neighbours ages its lldp edge out…
      await reconcileTopology(scope.orgId, scope.siteId, [], [{ sourceDeviceIp: '192.0.2.30', lldp: [], cdp: [], fdb: [] }]);
      await cleanupSpeculativeTopologyLinks(scope.orgId, scope.siteId);
      // …and the cause never leaks to a later delete in the same transaction.
      await db.delete(networkTopology).where(eq(networkTopology.id, edges.removed.id));
    });
    expect((await deleteEvents(scope)).sort((x, y) => x.sourceId.localeCompare(y.sourceId))).toEqual([
      { sourceId: edges.aged.id, cause: 'collector_absence' },
      { sourceId: edges.speculative.id, cause: 'collector_absence' },
      { sourceId: edges.removed.id, cause: null },
    ].sort((x, y) => x.sourceId.localeCompare(y.sourceId)));

    await settle(scope, () => drainTopologyOutbox(scope));
    expect(await relationship(edges.aged.id)).toMatchObject({ lifecycle: 'archived', deletedAt: null });
    expect(await relationship(edges.speculative.id)).toMatchObject({ lifecycle: 'archived', deletedAt: null });
    expect(await relationship(edges.removed.id)).toMatchObject({ lifecycle: 'withdrawn' });
    expect((await relationship(edges.removed.id))!.deletedAt).not.toBeNull();
  });

  it('refuses a forged cause on anything but a relationship tombstone', async () => {
    const scope = await tenant();
    const bad = { version: 1, type: 'node.delete', sourceTable: 'v2_intents', sourceId: crypto.randomUUID(), cause: 'collector_absence',
      oldIdentity: { orgId: scope.orgId, siteId: scope.siteId, sourceId: '' }, newIdentity: null, idempotencyKey: 'forged', data: null };
    bad.oldIdentity.sourceId = bad.sourceId;
    await expect(scoped(scope, () => db.execute(sql`SELECT topology_validate_capture_event(${JSON.stringify(bad)}::jsonb)`))).rejects.toThrow();
    const other = { ...bad, type: 'relationship.delete', sourceTable: 'network_topology', cause: 'user' };
    await expect(scoped(scope, () => db.execute(sql`SELECT topology_validate_capture_event(${JSON.stringify(other)}::jsonb)`))).rejects.toThrow();
  });
});
