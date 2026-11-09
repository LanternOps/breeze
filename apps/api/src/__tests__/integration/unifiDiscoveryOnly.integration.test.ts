/**
 * W04 (#11504, refs #10358): a self-hosted controller's unmapped sites are
 * discovery-only.
 *
 * One self-hosted controller can serve several customers. Before W04 a device
 * or client on a controller site with no Breeze mapping fell back to the
 * collector agent's own org, so customer B's inventory was filed under
 * customer A. Real Postgres, because the widened unifi_clients key
 * (collector_id, local_site_id, mac) is an ON CONFLICT arbiter that only a real
 * planner checks, and the removal statements are set-based SQL.
 *
 * Reconcile runs exactly as the worker runs it: `db` under the system context.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createSite, createDevice } from './db-utils';
import { db, withSystemDbAccessContext } from '../../db';
import { reconcileTelemetry, type TelemetryPayload } from '../../services/unifi/unifiTelemetryService';

const raw = () => getTestDb();

async function fixture() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id }); // the collector agent's org
  const orgB = await createOrganization({ partnerId: partner.id });
  const orgC = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const siteC = await createSite({ orgId: orgC.id });
  const agent = await createDevice({ orgId: orgA.id, siteId: siteA.id });
  const integrationId = crypto.randomUUID();
  const collectorId = crypto.randomUUID();
  await raw().execute(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted)
    VALUES (${integrationId}::uuid, ${partner.id}::uuid, 'k')`);
  // Self-hosted: unifi_host_id NULL. Its mapping rows carry the sentinel unifi_host_id = collector id.
  await raw().execute(sql`INSERT INTO unifi_collectors (id, integration_id, org_id, site_id, unifi_host_id, collector_device_id, controller_url, local_api_key_encrypted)
    VALUES (${collectorId}::uuid, ${integrationId}::uuid, ${orgA.id}::uuid, ${siteA.id}::uuid, NULL, ${agent.id}::uuid, 'https://controller.example', 'k')`);
  const map = async (unifiSiteId: string, orgId: string, siteId: string) => raw().execute(sql`
    INSERT INTO unifi_site_mappings (integration_id, org_id, site_id, unifi_host_id, unifi_site_id)
    VALUES (${integrationId}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${collectorId}, ${unifiSiteId})`);
  await map('s1', orgB.id, siteB.id);
  await map('s3', orgC.id, siteC.id);
  const reconcile = (payload: Omit<TelemetryPayload, 'collectorId' | 'polledAt' | 'firmwareOk'>, markStale = true) =>
    withSystemDbAccessContext(() => reconcileTelemetry(db as never, {
      collectorId, polledAt: new Date().toISOString(), firmwareOk: true, ...payload,
    }, { markStale }));
  return { orgA, orgB, orgC, siteA, siteB, siteC, integrationId, collectorId, reconcile };
}

const telemetryRows = (collectorId: string) => raw().execute<{ unifi_device_id: string; org_id: string }>(sql`
  SELECT unifi_device_id, org_id::text FROM unifi_device_telemetry WHERE collector_id = ${collectorId}::uuid ORDER BY unifi_device_id`);
const clientRows = (collectorId: string) => raw().execute<{ mac: string; local_site_id: string; org_id: string; is_stale: boolean }>(sql`
  SELECT mac, local_site_id, org_id::text, is_stale FROM unifi_clients WHERE collector_id = ${collectorId}::uuid ORDER BY local_site_id, mac`);

const SITES = [{ id: 's1', name: 'Customer B' }, { id: 's2', name: 'Not mapped yet' }, { id: 's3', name: 'Customer C' }];

describe('self-hosted UniFi reconcile: unmapped sites are discovery-only', () => {
  it('files mapped sites in their own org, writes nothing for an unmapped site, and still lists every site', async () => {
    const f = await fixture();

    const res = await f.reconcile({
      sites: SITES,
      devices: [
        { unifiDeviceId: 'd1', unifiSiteId: 's1', name: 'ap-b', raw: { ipAddress: '10.1.0.1' } },
        { unifiDeviceId: 'd2', unifiSiteId: 's2', name: 'ap-unmapped', raw: { ipAddress: '10.2.0.1' } },
      ],
      clients: [
        { mac: '02:00:00:00:00:b1', unifiSiteId: 's1', raw: {} },
        { mac: '02:00:00:00:00:02', unifiSiteId: 's2', raw: {} },
      ],
    });

    expect(await telemetryRows(f.collectorId)).toEqual([{ unifi_device_id: 'd1', org_id: f.orgB.id }]);
    expect(await clientRows(f.collectorId)).toEqual([
      { mac: '02:00:00:00:00:b1', local_site_id: 's1', org_id: f.orgB.id, is_stale: false },
    ]);
    // Nothing for s2 in ANY org: no discovered asset was created for the unmapped device's ip.
    const assets = await raw().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM discovered_assets WHERE ip_address = '10.2.0.1'`);
    expect(assets[0]!.n).toBe(0);
    // Discovery still sees every controller site, so the unmapped one can be mapped.
    const listed = await raw().execute<{ local_site_id: string }>(sql`
      SELECT local_site_id FROM unifi_controller_sites WHERE collector_id = ${f.collectorId}::uuid ORDER BY local_site_id`);
    expect(listed.map((r) => r.local_site_id)).toEqual(['s1', 's2', 's3']);
    expect(res).toMatchObject({ devicesSkippedUnmapped: 1, clientsSkippedUnmapped: 1, devicesUpserted: 1, clientsUpserted: 1 });
  });

  it('removes a pre-existing collector-org row for an unmapped-site device on the next poll, keeping its discovered asset', async () => {
    const f = await fixture();
    // Written before W04 by the collector fallback: customer data filed under org A.
    const [asset] = await raw().execute<{ id: string }>(sql`
      INSERT INTO discovered_assets (org_id, site_id, ip_address, source) VALUES (${f.orgA.id}::uuid, ${f.siteA.id}::uuid, '10.2.0.1', 'unifi') RETURNING id`);
    await raw().execute(sql`INSERT INTO unifi_device_telemetry (collector_id, org_id, site_id, unifi_device_id, discovered_asset_id, raw)
      VALUES (${f.collectorId}::uuid, ${f.orgA.id}::uuid, ${f.siteA.id}::uuid, 'd2', ${asset!.id}::uuid, '{}'::jsonb)`);
    await raw().execute(sql`INSERT INTO unifi_clients (collector_id, org_id, site_id, mac, raw)
      VALUES (${f.collectorId}::uuid, ${f.orgA.id}::uuid, ${f.siteA.id}::uuid, '02:00:00:00:00:02', '{}'::jsonb)`);

    // A partial poll (markStale=false) still removes rows the controller reports under an unmapped site.
    const res = await f.reconcile({
      sites: SITES,
      devices: [{ unifiDeviceId: 'd2', unifiSiteId: 's2', raw: { ipAddress: '10.2.0.1' } }],
      clients: [{ mac: '02:00:00:00:00:02', unifiSiteId: 's2', raw: {} }],
    }, false);

    expect(await telemetryRows(f.collectorId)).toEqual([]);
    expect(await clientRows(f.collectorId)).toEqual([]);
    const kept = await raw().execute<{ id: string }>(sql`SELECT id FROM discovered_assets WHERE id = ${asset!.id}::uuid`);
    expect(kept).toHaveLength(1); // OD-P2: assets are logged for review, never deleted here
    expect(res).toMatchObject({ devicesRemovedUnmapped: 1, clientsRemovedUnmapped: 1, removedDiscoveredAssetIds: [asset!.id] });
  });

  it('an agent that sends no site id skips the record but never deletes', async () => {
    const f = await fixture();
    await raw().execute(sql`INSERT INTO unifi_device_telemetry (collector_id, org_id, site_id, unifi_device_id, raw)
      VALUES (${f.collectorId}::uuid, ${f.orgA.id}::uuid, ${f.siteA.id}::uuid, 'd9', '{}'::jsonb)`);
    await raw().execute(sql`INSERT INTO unifi_clients (collector_id, org_id, site_id, mac, raw)
      VALUES (${f.collectorId}::uuid, ${f.orgA.id}::uuid, ${f.siteA.id}::uuid, '02:00:00:00:00:09', '{}'::jsonb)`);

    const res = await f.reconcile({
      devices: [{ unifiDeviceId: 'd9', raw: {} }],
      clients: [{ mac: '02:00:00:00:00:09', raw: {} }],
    }, false);

    expect(await telemetryRows(f.collectorId)).toHaveLength(1);
    expect(await clientRows(f.collectorId)).toHaveLength(1);
    expect(res).toMatchObject({ devicesSkippedNoSiteId: 1, clientsSkippedNoSiteId: 1, devicesRemovedUnmapped: 0, clientsRemovedUnmapped: 0 });
  });

  it('removal never touches a correctly attributed row of the same MAC at a mapped site', async () => {
    const f = await fixture();
    const mac = '02:00:00:00:00:cc';
    // Already on the widened key, correctly in org B for mapped s1.
    await raw().execute(sql`INSERT INTO unifi_clients (collector_id, org_id, site_id, local_site_id, mac, raw)
      VALUES (${f.collectorId}::uuid, ${f.orgB.id}::uuid, ${f.siteB.id}::uuid, 's1', ${mac}, '{}'::jsonb)`);
    // Wrongly attributed: an org-A row for unmapped s2, plus the legacy '' row.
    await raw().execute(sql`INSERT INTO unifi_clients (collector_id, org_id, site_id, local_site_id, mac, raw)
      VALUES (${f.collectorId}::uuid, ${f.orgA.id}::uuid, ${f.siteA.id}::uuid, 's2', ${mac}, '{}'::jsonb),
             (${f.collectorId}::uuid, ${f.orgA.id}::uuid, ${f.siteA.id}::uuid, '', ${mac}, '{}'::jsonb)`);

    // Partial poll: the MAC is reported at unmapped s2 only (s1 failed this time).
    const res = await f.reconcile({ sites: SITES, devices: [], clients: [{ mac, unifiSiteId: 's2', raw: {} }] }, false);

    expect(await clientRows(f.collectorId)).toEqual([{ mac, local_site_id: 's1', org_id: f.orgB.id, is_stale: false }]);
    expect(res).toMatchObject({ clientsRemovedUnmapped: 2, unmappedSiteIds: ['s2'] });
  });

  it('re-mapping a site to another org moves its rows on the next poll', async () => {
    const f = await fixture();
    const mac = '02:00:00:00:00:dd';
    const payload = { sites: SITES, devices: [{ unifiDeviceId: 'd1', unifiSiteId: 's1', raw: {} }], clients: [{ mac, unifiSiteId: 's1', raw: {} }] };
    await f.reconcile(payload);
    expect(await clientRows(f.collectorId)).toEqual([{ mac, local_site_id: 's1', org_id: f.orgB.id, is_stale: false }]);

    await raw().execute(sql`UPDATE unifi_site_mappings SET org_id = ${f.orgC.id}::uuid, site_id = ${f.siteC.id}::uuid
      WHERE integration_id = ${f.integrationId}::uuid AND unifi_site_id = 's1'`);
    await f.reconcile(payload);

    expect(await telemetryRows(f.collectorId)).toEqual([{ unifi_device_id: 'd1', org_id: f.orgC.id }]);
    expect(await clientRows(f.collectorId)).toEqual([{ mac, local_site_id: 's1', org_id: f.orgC.id, is_stale: false }]);
  });

  it('the same MAC at two mapped sites is two rows in two orgs, and its legacy row is deleted, not left stale', async () => {
    const f = await fixture();
    const mac = '02:00:00:00:00:aa';
    // Legacy row from the old (collector_id, mac) key: local_site_id defaults to ''.
    await raw().execute(sql`INSERT INTO unifi_clients (collector_id, org_id, site_id, mac, raw)
      VALUES (${f.collectorId}::uuid, ${f.orgA.id}::uuid, ${f.siteA.id}::uuid, ${mac}, '{}'::jsonb)`);

    await f.reconcile({
      sites: SITES, devices: [],
      clients: [{ mac, unifiSiteId: 's1', raw: {} }, { mac, unifiSiteId: 's3', raw: {} }],
    });

    expect(await clientRows(f.collectorId)).toEqual([
      { mac, local_site_id: 's1', org_id: f.orgB.id, is_stale: false },
      { mac, local_site_id: 's3', org_id: f.orgC.id, is_stale: false },
    ]);

    // A second identical poll is a no-op on the widened arbiter (no duplicate rows).
    await f.reconcile({ sites: SITES, devices: [], clients: [{ mac, unifiSiteId: 's1', raw: {} }, { mac, unifiSiteId: 's3', raw: {} }] });
    expect(await clientRows(f.collectorId)).toHaveLength(2);
  });

  it('unmapping a site and reconciling removes that site\'s rows', async () => {
    const f = await fixture();
    const mac = '02:00:00:00:00:aa';
    const payload = {
      sites: SITES,
      devices: [{ unifiDeviceId: 'd1', unifiSiteId: 's1', raw: {} }, { unifiDeviceId: 'd3', unifiSiteId: 's3', raw: {} }],
      clients: [{ mac, unifiSiteId: 's1', raw: {} }, { mac, unifiSiteId: 's3', raw: {} }],
    };
    await f.reconcile(payload);
    expect(await telemetryRows(f.collectorId)).toHaveLength(2);

    await raw().execute(sql`DELETE FROM unifi_site_mappings WHERE integration_id = ${f.integrationId}::uuid AND unifi_site_id = 's1'`);
    await f.reconcile(payload);

    expect(await telemetryRows(f.collectorId)).toEqual([{ unifi_device_id: 'd3', org_id: f.orgC.id }]);
    expect(await clientRows(f.collectorId)).toEqual([{ mac, local_site_id: 's3', org_id: f.orgC.id, is_stale: false }]);
  });
});
