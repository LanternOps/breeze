import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { orgContext } from './topology-fixtures';
import { createSite } from './db-utils';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import { expireTopologyEvidence } from '../../services/topology/collectionRetention';
import { runTopologyCollectionRetentionTick } from '../../jobs/topologyCollectionRetentionWorker';
import { publishTopologyBuild } from '../../services/topology/publish';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';

afterAll(() => closeDb());
const system = <T>(work: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(work));

/** A published agent producer: real runs, observations and active support. */
async function fixture() {
  const f = await topologyIngestFixture();
  const scope = { orgId: f.orgId, siteId: f.siteId };
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(f.orgId), fn);
  const publish = () => scoped(async () => {
    const [state] = await db.execute(sql`SELECT build_fence::text, dirty_revision::text FROM topology_site_state
      WHERE org_id=${f.orgId}::uuid AND site_id=${f.siteId}::uuid`);
    return publishTopologyBuild(scope, { buildFence: String(state!.build_fence), inputRevision: String(state!.dirty_revision), nodes: [], relationships: [], bindings: [] });
  });
  await f.ingest(f.full('1', -1000));
  expect((await publish()).published).toBe(true);
  return { ...f, scope, scoped, publish };
}

/** Counted by producer, never by source, so an orphaned row cannot hide. */
const evidence = (siteId: string, producerId: string) => system(async () => {
  const [row] = await db.execute<{ sources: number; runs: number; observations: number; support: number }>(sql`SELECT
    (SELECT count(*)::int FROM topology_collection_sources WHERE site_id=${siteId}::uuid AND producer_id=${producerId}::uuid) AS sources,
    (SELECT count(*)::int FROM topology_collection_runs WHERE site_id=${siteId}::uuid AND producer_id=${producerId}::uuid) AS runs,
    (SELECT count(*)::int FROM topology_observations o WHERE o.site_id=${siteId}::uuid AND EXISTS (
      SELECT 1 FROM topology_collection_runs r WHERE r.id=o.run_id AND r.producer_id=${producerId}::uuid)) AS observations,
    (SELECT count(*)::int FROM topology_relationship_support s WHERE s.site_id=${siteId}::uuid AND EXISTS (
      SELECT 1 FROM topology_collection_sources c WHERE c.id=s.source_id AND c.producer_id=${producerId}::uuid)) AS support`);
  return row!;
});

const siteTotals = (siteId: string) => system(async () => {
  const [row] = await db.execute<{ sources: number; runs: number; observations: number; support: number }>(sql`SELECT
    (SELECT count(*)::int FROM topology_collection_sources WHERE site_id=${siteId}::uuid) AS sources,
    (SELECT count(*)::int FROM topology_collection_runs WHERE site_id=${siteId}::uuid) AS runs,
    (SELECT count(*)::int FROM topology_observations WHERE site_id=${siteId}::uuid) AS observations,
    (SELECT count(*)::int FROM topology_relationship_support WHERE site_id=${siteId}::uuid) AS support`);
  return row!;
});

const collected = (siteId: string) => system(async () => db.execute<{ id: string; lifecycle: string; support_count: string }>(
  sql`SELECT id, lifecycle, support_count::text FROM topology_relationships
    WHERE site_id=${siteId}::uuid AND attributes->>'method'='os_network_context' ORDER BY id`));

const retain = (scope: { orgId: string; siteId: string }) => system(() => expireTopologyEvidence(scope));
const deleteDevice = (deviceId: string) => system(() => db.transaction(tx => deleteDeviceCascade(tx as unknown as DeviceDeletionTx, deviceId)));

describe('deleted-device topology evidence purge', () => {
  it('removes every evidence row for a deleted producer once its withdrawal is published', async () => {
    const f = await fixture();
    const before = await evidence(f.siteId, f.deviceId);
    expect(before.sources).toBeGreaterThan(0);
    expect(before.runs).toBeGreaterThan(0);
    expect(before.observations).toBeGreaterThan(0);
    expect(before.support).toBeGreaterThan(0);
    expect((await collected(f.siteId)).every(row => row.lifecycle === 'active')).toBe(true);

    await deleteDevice(f.deviceId);
    expect((await f.publish()).published).toBe(true);
    const withdrawn = await collected(f.siteId);
    expect(withdrawn.length).toBeGreaterThan(0);
    expect(withdrawn.every(row => row.lifecycle === 'withdrawn' && row.support_count === '0')).toBe(true);

    expect((await retain(f.scope)).purgedSources).toBe(before.sources);
    expect(await evidence(f.siteId, f.deviceId)).toEqual({ sources: 0, runs: 0, observations: 0, support: 0 });
    // The map keeps its history: only the collection evidence is purged.
    expect((await collected(f.siteId)).length).toBe(withdrawn.length);
  });

  it('keeps a supporting source until its withdrawal has been published', async () => {
    const f = await fixture();
    const before = await evidence(f.siteId, f.deviceId);
    expect(before.support).toBeGreaterThan(0);
    await deleteDevice(f.deviceId);
    // No publish. Those support rows are still `active`, and publication — not
    // this purge — is what withdraws them and recomputes the relationships. Any
    // source still holding one has to survive, or the map keeps showing its
    // relationships as active with no observer left that could withdraw them.
    const purged = (await retain(f.scope)).purgedSources;
    const after = await evidence(f.siteId, f.deviceId);
    expect(after.support).toBe(before.support);
    expect(after.sources).toBeGreaterThan(0);
    expect(purged).toBe(before.sources - after.sources);
    expect(purged).toBeLessThan(before.sources);
    expect((await collected(f.siteId)).every(row => row.lifecycle === 'active')).toBe(true);
    // Every run and observation that still backs live support is retained too.
    expect(after.observations).toBeGreaterThan(0);
    expect(after.runs).toBeGreaterThan(0);
  });

  it('retains the evidence of a device that only moved site', async () => {
    const f = await fixture();
    const before = await evidence(f.siteId, f.deviceId);
    const target = await createSite({ orgId: f.orgId });
    await system(() => db.execute(sql`UPDATE devices SET site_id=${target.id}::uuid WHERE id=${f.deviceId}::uuid`));
    const [revoked] = await system(() => db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM topology_collection_sources
      WHERE producer_id=${f.deviceId}::uuid AND revoked_at IS NOT NULL`));
    expect(revoked!.count).toBe(before.sources);
    expect((await f.publish()).published).toBe(true);
    expect((await retain(f.scope)).purgedSources).toBe(0);
    expect(await evidence(f.siteId, f.deviceId)).toEqual(before);
  });

  it('leaves a second producer supporting the same relationship active with its own evidence', async () => {
    const f = await fixture();
    const [relationship] = await collected(f.siteId);
    expect(relationship).toBeDefined();
    const peerDeviceId = crypto.randomUUID(), peerSourceId = crypto.randomUUID();
    await system(async () => {
      await db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
        VALUES (${peerDeviceId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, ${peerDeviceId}, 'peer', 'linux', '1', 'amd64', '1')`);
      await db.execute(sql`INSERT INTO topology_collection_sources (id, org_id, site_id, producer_id, producer_kind, producer_epoch, protocol, context_key)
        VALUES (${peerSourceId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, ${peerDeviceId}::uuid, 'agent', 'peer-epoch', 'routes', 'peer')`);
      await db.execute(sql`INSERT INTO topology_relationship_support (org_id, site_id, relationship_id, source_id, producer_epoch, sequence, content_digest,
        first_positive_at, last_positive_at, effective_at, fresh_until)
        VALUES (${f.orgId}::uuid, ${f.siteId}::uuid, ${relationship!.id}::uuid, ${peerSourceId}::uuid, 'peer-epoch', 1, ${'b'.repeat(64)},
          now(), now(), now(), now()+interval '1 hour')`);
    });

    await deleteDevice(f.deviceId);
    expect((await f.publish()).published).toBe(true);
    await retain(f.scope);

    expect(await evidence(f.siteId, f.deviceId)).toEqual({ sources: 0, runs: 0, observations: 0, support: 0 });
    expect(await evidence(f.siteId, peerDeviceId)).toMatchObject({ sources: 1, support: 1 });
    const shared = (await collected(f.siteId)).find(row => row.id === relationship!.id);
    expect(shared).toMatchObject({ lifecycle: 'active', support_count: '1' });
  });

  it('purges only the scoped site, leaving another tenant untouched', async () => {
    const [a, b] = [await fixture(), await fixture()];
    const foreign = await evidence(b.siteId, b.deviceId);
    for (const f of [a, b]) { await deleteDevice(f.deviceId); expect((await f.publish()).published).toBe(true); }
    expect((await retain(a.scope)).purgedSources).toBeGreaterThan(0);
    expect(await evidence(b.siteId, b.deviceId)).toEqual(foreign);
    // The worker's own candidate query must still reach a site whose only
    // retention work is a purge, or nothing ever runs in production.
    await runTopologyCollectionRetentionTick();
    expect(await evidence(b.siteId, b.deviceId)).toEqual({ sources: 0, runs: 0, observations: 0, support: 0 });
  });

  it('is a no-op when run again', async () => {
    const f = await fixture();
    await deleteDevice(f.deviceId);
    expect((await f.publish()).published).toBe(true);
    expect((await retain(f.scope)).purgedSources).toBeGreaterThan(0);
    const after = await siteTotals(f.siteId);
    expect((await retain(f.scope)).purgedSources).toBe(0);
    expect(await siteTotals(f.siteId)).toEqual(after);
  });
});
