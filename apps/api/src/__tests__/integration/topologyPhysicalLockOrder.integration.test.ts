import './setup';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { canonicalizeUnifiResource, type UnifiResource, type UnifiTopologyV1 } from '@breeze/shared';
import vectors from '../../../../../packages/shared/src/testing/topology-unifi-v1.json';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { createSite } from './db-utils';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import { negotiateTopologyContext, registerTopologyProducerAuthority, resetTopologyProducerAuthoritiesForTest } from '../../services/topology/collectionAuthority';
import { adaptUnifiTopology } from '../../services/topology/unifiAdapter';
import { currentUnifiCollectorTopology, loadUnifiCollector, unifiTopologyAuthority } from '../../services/topology/unifiAuthority';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(() => db.transaction(fn));
/** A second, independent pooled connection (outside any ambient context). */
const other = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const vector = vectors.vectors[0]!;

afterEach(() => resetTopologyProducerAuthoritiesForTest());

async function waitForLockWaiter(pattern: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await other(() => db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${pattern}`));
    if (Number(row!.n) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const rows = await other(() => db.execute(sql`SELECT state, wait_event_type, wait_event, left(query, 200) AS q FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`));
  throw new Error(`no lock waiter matching ${pattern}: ${JSON.stringify(rows)}`);
}

describe('physical ingest lock order vs the device lifecycle trigger (#5998 review)', () => {
  async function twoSiteUpload() {
    const f = await topologyIngestFixture();
    const home = f.siteId;
    let target = (await createSite({ orgId: f.orgId })).id;
    while (target < home) target = (await createSite({ orgId: f.orgId })).id;
    const integrationId = crypto.randomUUID(), c1 = crypto.randomUUID();
    await sys(async () => {
      await db.execute(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted) VALUES (${integrationId}::uuid, ${f.partnerId}::uuid, 'k')`);
      await db.execute(sql`INSERT INTO unifi_collectors (id, integration_id, org_id, site_id, unifi_host_id, collector_device_id, controller_url, local_api_key_encrypted)
        VALUES (${c1}::uuid, ${integrationId}::uuid, ${f.orgId}::uuid, ${home}::uuid, 'host:1', ${f.deviceId}::uuid, 'https://host-1', 'k')`);
      await db.execute(sql`INSERT INTO unifi_site_mappings (integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
        VALUES (${integrationId}::uuid, ${f.orgId}::uuid, ${target}::uuid, 'host:1', 'site-t'),
               (${integrationId}::uuid, ${f.orgId}::uuid, ${home}::uuid, 'host:1', 'site-h')`);
    });
    const collector = (await sys(() => loadUnifiCollector(c1)))!;
    const current = (await sys(() => currentUnifiCollectorTopology(f.deviceId, collector)))!;
    const deviceList = vector.report.resources.find(r => r.kind === 'device_list')!;
    // Report order T then H: the first resource's producer check holds state(T).
    const resources = (['site-t', 'site-h'] as const).map(controllerSiteId => ({ ...structuredClone(deviceList), controllerSiteId })) as UnifiResource[];
    for (const r of resources) r.contentDigest = createHash('sha256').update(canonicalizeUnifiResource(current, r)).digest('hex');
    const report = { ...structuredClone(vector.report), producerEpoch: current.producerEpoch, snapshotId: crypto.randomUUID(), sequence: '1',
      capturedAt: new Date(Date.now() - 1000).toISOString(), captureAgeAtSendMs: 0, resources } as UnifiTopologyV1;
    return { f, home, target, collector, report };
  }
  /** Pause inside the first resource's producer re-check (the second authority
   * call: its locks are held), start `competitor` on another connection and
   * resume once it is blocked on a lock. */
  function pauseFirstResource(competitor: () => Promise<unknown>, waiterPattern: string) {
    let calls = 0;
    const state: { competing?: Promise<unknown> } = {};
    registerTopologyProducerAuthority('unifi', async request => {
      calls += 1;
      if (calls === 2) {
        state.competing = competitor().then(() => 'done', (error: unknown) => error);
        await waitForLockWaiter(waiterPattern);
      }
      return unifiTopologyAuthority(request);
    });
    return state;
  }
  const errorCode = (r: unknown) => (r as { code?: string } | null)?.code ?? (r as { cause?: { code?: string } } | null)?.cause?.code;
  const bothSitesAccepted = { accepted: true, resources: [{ controllerSiteId: 'site-t', accepted: true }, { controllerSiteId: 'site-h', accepted: true }] };

  // The heartbeat handshake (negotiateTopologyContext) and the agent's own M1
  // ingest take state(H) FOR UPDATE, then the home root FOR UPDATE. A two-site
  // UniFi upload used to take state(T), the home root FOR SHARE, then — for its
  // next resource — state(H): the heartbeat held state(H) waiting on the root,
  // the upload held the root waiting on state(H): 40P01.
  it('a two-site UniFi upload and a concurrent heartbeat handshake both complete', async () => {
    const { f, collector, report } = await twoSiteUpload();
    const paused = pauseFirstResource(() => other(() => db.transaction(() => negotiateTopologyContext(f.deviceId))), 'select "%');
    const ingest = await sys(() => adaptUnifiTopology(f.deviceId, collector, report)).then(r => r, (error: unknown) => error);
    const handshake = await paused.competing;
    expect([errorCode(ingest), errorCode(handshake)]).not.toContain('40P01');
    expect(handshake).toBe('done');
    expect(ingest).toMatchObject(bothSitesAccepted);
  });

  // The source-lifecycle trigger (2026-11-01-100000) walks the moved device's
  // sites in site_id order: state(S), then S's sources. It cannot interleave
  // with an upload by the same device: a site_id change rewrites the
  // devices(id, org_id, site_id) unique key, so the move takes the device row
  // FOR UPDATE, which conflicts with the ingest's FOR KEY SHARE NOWAIT. This
  // pins that barrier.
  it('a two-site UniFi upload and a concurrent device move both complete', async () => {
    const { f, collector, report } = await twoSiteUpload();
    const destination = (await createSite({ orgId: f.orgId })).id;
    const paused = pauseFirstResource(() => other(() => db.execute(sql`UPDATE devices SET site_id=${destination}::uuid WHERE id=${f.deviceId}::uuid`)), 'UPDATE devices SET site_id%');
    const ingest = await sys(() => adaptUnifiTopology(f.deviceId, collector, report)).then(r => r, (error: unknown) => error);
    const moved = await paused.competing;
    expect([errorCode(ingest), errorCode(moved)]).not.toContain('40P01');
    expect(moved).toBe('done');
    expect(ingest).toMatchObject(bothSitesAccepted);
    // The move then revoked every source the device produced, in both sites.
    const live = await sys(() => db.execute(sql`SELECT count(*)::int AS n FROM topology_collection_sources
      WHERE org_id=${f.orgId}::uuid AND producer_id=${f.deviceId}::uuid AND revoked_at IS NULL`));
    expect(Number(live[0]!.n)).toBe(0);
  });
});
