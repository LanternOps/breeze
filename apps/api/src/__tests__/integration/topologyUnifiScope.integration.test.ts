import './setup';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { canonicalizeUnifiResource, type UnifiResource, type UnifiTopologyV1 } from '@breeze/shared';
import vectors from '../../../../../packages/shared/src/testing/topology-unifi-v1.json';
import { db, withSystemDbAccessContext } from '../../db';
import { createSite } from './db-utils';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import { adaptUnifiTopology } from '../../services/topology/unifiAdapter';
import {
  currentUnifiCollectorTopology, loadUnifiCollector, revokeUnifiCollectorDrift, revokeUnifiMappingDrift, snapshotUnifiCollectors, snapshotUnifiMappings,
  unifiTopologyAdvertisement,
} from '../../services/topology/unifiAuthority';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(() => db.transaction(fn));
const vector = vectors.vectors[0]!;
const MAC_A = '02:00:00:00:03:01'; // wired client in the fixture
const MAC_B = '02:00:00:00:03:02'; // wireless client in the fixture

async function fixture() {
  const f = await topologyIngestFixture();
  const siteB = (await createSite({ orgId: f.orgId })).id;
  const integrationId = crypto.randomUUID();
  const c1 = crypto.randomUUID(), c2 = crypto.randomUUID();
  const mappingA = crypto.randomUUID();
  await sys(async () => {
    await db.execute(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted) VALUES (${integrationId}::uuid, ${f.partnerId}::uuid, 'k')`);
    for (const [id, host] of [[c1, 'host:1'], [c2, 'host:2']] as const) {
      await db.execute(sql`INSERT INTO unifi_collectors (id, integration_id, org_id, site_id, unifi_host_id, collector_device_id, controller_url, local_api_key_encrypted)
        VALUES (${id}::uuid, ${integrationId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, ${host}, ${f.deviceId}::uuid, ${`https://${host.replace(':', '-')}`}, 'k')`);
    }
    await db.execute(sql`INSERT INTO unifi_site_mappings (id, integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
      VALUES (${mappingA}::uuid, ${integrationId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, 'host:1', 'default')`);
  });
  const collector = async (id: string) => (await sys(() => loadUnifiCollector(id)))!;
  /** Wire report exactly as the Go collector builds it, bound to the advertised epoch. */
  const report = async (collectorId: string, sequence: string, offsetMs: number, controllerSiteId = 'default', edit?: (r: UnifiResource[]) => void): Promise<UnifiTopologyV1> => {
    const current = (await sys(async () => currentUnifiCollectorTopology(f.deviceId, await collector(collectorId))))!;
    const resources = structuredClone(vector.report.resources).map(r => ({ ...r, controllerSiteId })) as UnifiResource[];
    edit?.(resources);
    for (const r of resources) r.contentDigest = createHash('sha256').update(canonicalizeUnifiResource(current, r)).digest('hex');
    return { ...structuredClone(vector.report), producerEpoch: current.producerEpoch, snapshotId: crypto.randomUUID(), sequence,
      capturedAt: new Date(Date.now() + offsetMs).toISOString(), captureAgeAtSendMs: 0, resources } as UnifiTopologyV1;
  };
  const adapt = async (collectorId: string, r: UnifiTopologyV1) => sys(async () => adaptUnifiTopology(f.deviceId, await collector(collectorId), r));
  const sources = (siteId?: string) => sys(async () => db.execute(sql`SELECT site_id::text, protocol, context_key, revoked_at, producer_epoch, content_digest, current_baseline
    FROM topology_collection_sources WHERE org_id=${f.orgId}::uuid AND producer_kind='unifi' ${siteId ? sql`AND site_id=${siteId}::uuid` : sql``} ORDER BY protocol`));
  const runs = () => sys(async () => Number((await db.execute(sql`SELECT count(*)::int AS n FROM topology_collection_runs r JOIN topology_collection_sources s ON s.id=r.source_id
    WHERE s.producer_kind='unifi' AND r.org_id=${f.orgId}::uuid`))[0]!.n));
  const addDevice = (siteId: string, mac: string) => sys(async () => {
    const id = crypto.randomUUID();
    await db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (${id}::uuid, ${f.orgId}::uuid, ${siteId}::uuid, ${id}, 'nic-fixture', 'linux', '1', 'amd64', '1')`);
    await db.execute(sql`INSERT INTO device_network (device_id, org_id, interface_name, mac_address) VALUES (${id}::uuid, ${f.orgId}::uuid, 'eth0', ${mac.toUpperCase()})`);
    return id;
  });
  return { ...f, siteB, integrationId, c1, c2, mappingA, collector, report, adapt, sources, runs, addDevice };
}
const clientRows = (source: Record<string, any> | undefined) => (source?.current_baseline?.section?.rows ?? []) as Array<Record<string, any>>;

describe('UniFi topology scope (M2 Task 5)', () => {
  it('advertises topology only for mapped collectors and ingests only the exact controller-site mapping', async () => {
    const f = await fixture();
    const advertised = await sys(() => unifiTopologyAdvertisement(f.deviceId, f.c1));
    expect(advertised).toMatchObject({ acceptedUnifiTopologyVersions: [1], topologySourceIdentity: `${f.orgId}:${f.siteId}:unifi:${f.deviceId}:${f.c1}` });
    // c2's host has no mapping yet: legacy-only.
    expect(await sys(() => unifiTopologyAdvertisement(f.deviceId, f.c2))).toBeNull();

    const receipt = await f.adapt(f.c1, await f.report(f.c1, '1', -1000));
    expect(receipt.accepted).toBe(true);
    expect(receipt.resources).toHaveLength(4);
    expect(receipt.resources.every(r => r.accepted && r.contentDigest)).toBe(true);
    const rows = await f.sources();
    expect(rows.map(r => r.protocol)).toEqual(['unifi_client_list', 'unifi_device_details', 'unifi_device_list', 'unifi_statistics']);
    expect(rows.every(r => r.site_id === f.siteId && r.context_key === `${f.c1}:default`)).toBe(true);
    const clients = clientRows(rows.find(r => r.protocol === 'unifi_client_list'));
    expect(clients.find(r => r.clientId === 'client-wired-1')).toMatchObject({
      endpointKey: `unifi:host%3A1:default:mac:${encodeURIComponent(MAC_A)}`, uplinkEndpointKey: 'unifi:host%3A1:default:device:dev-switch-1', inventoryDeviceId: null,
    });
  });

  it('ingests nothing for an unknown controller site and records a bounded coverage reason', async () => {
    const f = await fixture();
    const receipt = await f.adapt(f.c1, await f.report(f.c1, '1', -1000, 'site-nobody-mapped'));
    expect(receipt.accepted).toBe(false);
    expect(receipt.resources.every(r => !r.accepted && r.reason === 'controller_site_unmapped')).toBe(true);
    expect(await f.sources()).toHaveLength(0);
    expect(await f.runs()).toBe(0);
    const [note] = await sys(() => db.execute(sql`SELECT topology_coverage_reason FROM unifi_controller_sites WHERE collector_id=${f.c1}::uuid AND local_site_id='site-nobody-mapped'`));
    expect(note!.topology_coverage_reason).toBe('controller_site_unmapped');
    // A tampered resource digest is refused before scope resolution.
    const forged = await f.report(f.c1, '2', 0);
    forged.resources[0]!.contentDigest = 'f'.repeat(64);
    expect((await f.adapt(f.c1, forged)).resources[0]).toMatchObject({ accepted: false, reason: 'content_digest_mismatch' });
    // A report bound to a stale epoch is refused as a whole.
    expect(await f.adapt(f.c1, { ...(await f.report(f.c1, '3', 0)), producerEpoch: 'stale' })).toMatchObject({ accepted: false, reason: 'producer_epoch_changed' });
  });

  it('isolates the same controller site id on two hosts', async () => {
    const f = await fixture();
    // host:2/default is unmapped: collector 2 never borrows host:1's mapping.
    const unmapped = await f.adapt(f.c2, { ...(await f.report(f.c1, '1', -2000)) });
    expect(unmapped).toMatchObject({ accepted: false, reason: 'topology_unavailable' });
    await sys(() => db.execute(sql`INSERT INTO unifi_site_mappings (integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
      VALUES (${f.integrationId}::uuid, ${f.orgId}::uuid, ${f.siteB}::uuid, 'host:2', 'default')`));
    expect((await f.adapt(f.c1, await f.report(f.c1, '1', -1000))).accepted).toBe(true);
    expect((await f.adapt(f.c2, await f.report(f.c2, '1', -1000))).accepted).toBe(true);
    const a = await f.sources(f.siteId), b = await f.sources(f.siteB);
    expect(a.every(r => r.context_key === `${f.c1}:default`)).toBe(true);
    expect(b.every(r => r.context_key === `${f.c2}:default`)).toBe(true);
    expect(a).toHaveLength(4); expect(b).toHaveLength(4);
    expect(clientRows(b.find(r => r.protocol === 'unifi_client_list'))[0]!.endpointKey).toMatch(/^unifi:host%3A2:default:/);
  });

  it('binds only a unique same-site agent-reported NIC MAC, never cross-site or ambiguous', async () => {
    const f = await fixture();
    await f.addDevice(f.siteB, MAC_A);              // same MAC in another site: never binds
    const bound = await f.addDevice(f.siteId, MAC_B);  // unique in site A: binds
    await f.addDevice(f.siteId, '02:00:00:00:02:01'); // duplicate within site A (switch MAC) -> ambiguous
    await f.addDevice(f.siteId, '02:00:00:00:02:01');
    // A discovered asset with the wired MAC in site A is NOT a binding source (D16).
    await sys(() => db.execute(sql`INSERT INTO discovered_assets (org_id, site_id, ip_address, mac_address) VALUES (${f.orgId}::uuid, ${f.siteId}::uuid, '192.0.2.77', ${MAC_A})`));
    expect((await f.adapt(f.c1, await f.report(f.c1, '1', -1000))).accepted).toBe(true);
    const rows = await f.sources(f.siteId);
    const clients = clientRows(rows.find(r => r.protocol === 'unifi_client_list'));
    expect(clients.find(r => r.mac === MAC_A)!.inventoryDeviceId).toBeNull();
    expect(clients.find(r => r.mac === MAC_B)!.inventoryDeviceId).toBe(bound);
    expect(clientRows(rows.find(r => r.protocol === 'unifi_device_list')).find(r => r.deviceId === 'dev-switch-1')!.inventoryDeviceId).toBeNull();
  });

  it('confirms an unchanged report without creating a run', async () => {
    const f = await fixture();
    await f.adapt(f.c1, await f.report(f.c1, '1', -600_000));
    const before = await f.runs();
    expect(before).toBe(4);
    const again = await f.adapt(f.c1, await f.report(f.c1, '2', 0));
    expect(again.accepted).toBe(true);
    expect(await f.runs()).toBe(before);
    // A changed resource creates exactly one new run.
    const changed = await f.report(f.c1, '3', 1000, 'default', r => { (r.find(x => x.kind === 'device_list')!.rows[0] as { name: string | null }).name = 'renamed'; });
    expect((await f.adapt(f.c1, changed)).accepted).toBe(true);
    expect(await f.runs()).toBe(before + 1);
  });

  it('revokes sources on a mapping change and re-baselines under a new epoch, including a remap back', async () => {
    const f = await fixture();
    expect((await f.adapt(f.c1, await f.report(f.c1, '1', -3000))).accepted).toBe(true);
    const epochA = (await f.sources(f.siteId))[0]!.producer_epoch;
    // Remap host:1/default from site A to site B.
    await sys(async () => {
      const before = await snapshotUnifiMappings(f.integrationId);
      await db.execute(sql`UPDATE unifi_site_mappings SET site_id=${f.siteB}::uuid WHERE id=${f.mappingA}::uuid`);
      expect(await revokeUnifiMappingDrift(f.integrationId, before)).toBe(4);
    });
    expect((await f.sources(f.siteId)).every(r => r.revoked_at !== null)).toBe(true);
    expect((await f.adapt(f.c1, await f.report(f.c1, '2', -2000))).accepted).toBe(true);
    expect((await f.sources(f.siteB)).every(r => r.revoked_at === null)).toBe(true);
    // Remap back: the old site's fenced sources re-baseline under a NEW epoch.
    await sys(async () => {
      const before = await snapshotUnifiMappings(f.integrationId);
      await db.execute(sql`UPDATE unifi_site_mappings SET site_id=${f.siteId}::uuid WHERE id=${f.mappingA}::uuid`);
      await revokeUnifiMappingDrift(f.integrationId, before);
    });
    expect((await f.adapt(f.c1, await f.report(f.c1, '3', -1000))).accepted).toBe(true);
    const back = await f.sources(f.siteId);
    expect(back.every(r => r.revoked_at === null)).toBe(true);
    expect(back[0]!.producer_epoch).not.toBe(epochA);
    expect((await f.sources(f.siteB)).every(r => r.revoked_at !== null)).toBe(true);
  });

  it('revokes a reassigned collector\'s sources and stops advertising to the old device', async () => {
    const f = await fixture();
    expect((await f.adapt(f.c1, await f.report(f.c1, '1', -1000))).accepted).toBe(true);
    const other = await f.addDevice(f.siteId, '02:00:00:00:09:09');
    await sys(async () => {
      const before = await snapshotUnifiCollectors(f.integrationId);
      await db.execute(sql`UPDATE unifi_collectors SET collector_device_id=${other}::uuid WHERE id=${f.c1}::uuid`);
      expect(await revokeUnifiCollectorDrift(f.integrationId, before)).toBe(4);
    });
    expect((await f.sources(f.siteId)).every(r => r.revoked_at !== null)).toBe(true);
    expect(await sys(() => unifiTopologyAdvertisement(f.deviceId, f.c1))).toBeNull();
    // Unrelated edits (poll bookkeeping) never revoke.
    await sys(async () => {
      const before = await snapshotUnifiCollectors(f.integrationId);
      await db.execute(sql`UPDATE unifi_collectors SET last_poll_at=now(), updated_at=now(), status='connected' WHERE id=${f.c2}::uuid`);
      expect(await revokeUnifiCollectorDrift(f.integrationId, before)).toBe(0);
    });
  });
});
