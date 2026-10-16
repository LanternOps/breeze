import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbTransaction } from '../../db';
import { readDeviceAttachments, readSiteAnchorEvidence } from '../../services/topology/presenceInputs';
import { readOrgNetworkDeclarations } from '../../services/topology/siteNetworkDeclarations';
import { closeDb, system, twoSiteOrg } from './topology-presence-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());

/** Site location W2 Task 4 (#7886): presence inputs over the real collection seam. */
const GW_MAC = '00:00:5e:00:01:05';
const HORIZON = 7 * 86_400;

describe('presence inputs', () => {
  it('anchor evidence counts only devices assigned to the declaring site, within the horizon', async () => {
    const f = await twoSiteOrg({
      declare: { B: ['10.1.5.0/24'] },
      devices: [
        { key: 'LOV1', site: 'B', hostname: 'LAKESIDE-PC-01', address: '10.1.5.20', gateway: '10.1.5.1', gatewayMac: GW_MAC },
        { key: 'MIS1', site: 'A', hostname: 'DESKTOP-HD7K2QF', address: '10.1.5.30', gateway: '10.1.5.1', gatewayMac: GW_MAC },
      ],
    });
    await f.reportAll();
    await f.publishAll();
    const lakeside = await system(() => withDbTransaction(() => readSiteAnchorEvidence(db, { orgId: f.orgId, siteId: f.siteB }, ['10.1.5.0/24'], HORIZON)));
    expect(lakeside.evidence.map((e) => e.observerDeviceId)).toEqual([f.ids.LOV1]); // MIS1 never anchors Lakeside
    expect(lakeside.evidence[0]).toMatchObject({ prefix: '10.1.5.0/24', gateway: '10.1.5.1', mac: GW_MAC });
    expect(lakeside.neighborCoverage).toBe('complete');
    // Main Office's own read sees MIS1, but only for prefixes asked about.
    const mainOffice = await system(() => withDbTransaction(() => readSiteAnchorEvidence(db, { orgId: f.orgId, siteId: f.siteA }, ['10.1.2.0/24'], HORIZON)));
    expect(mainOffice.evidence).toEqual([]);

    // A device moved to Lakeside no longer counts for Main Office's graph. (The existing topology authority-detach
    // trigger drops its binding on the site change; the reader's live devices.site_id join is defence in depth.)
    await getTestDb().execute(sql`UPDATE devices SET site_id = ${f.siteB}::uuid WHERE id = ${f.ids.MIS1}::uuid`);
    const moved = await system(() => withDbTransaction(() => readDeviceAttachments(db, { orgId: f.orgId, siteId: f.siteA })));
    expect(moved.has(f.ids.MIS1!)).toBe(false);
  });

  it('device attachments pair gateways by interface, carry the gateway MAC, exclude tunnels and expired evidence', async () => {
    const f = await twoSiteOrg({
      devices: [
        { key: 'W1', site: 'A', hostname: 'WIN-HD4M8T2C9', address: '10.1.2.10', gateway: '10.1.2.100', gatewayMac: GW_MAC },
        { key: 'VPN', site: 'A', hostname: 'LAPTOP-VPN-01', address: '10.1.2.40', gateway: '10.1.2.100', interfaceKind: 'tunnel' },
        { key: 'OLD', site: 'A', hostname: 'DESKTOP-OLD-01', address: '10.1.2.50', gateway: '10.1.2.100' },
      ],
    });
    await f.reportAll();
    await f.publish('A');
    // OLD's evidence expired long ago: push its support out of the freshness window.
    await getTestDb().execute(sql`UPDATE topology_relationship_support s SET fresh_until = now() - interval '1 day', effective_at = now() - interval '2 days'
      FROM topology_node_bindings b WHERE b.device_id = ${f.ids.OLD}::uuid AND s.org_id = b.org_id AND s.relationship_id IN (
        SELECT r.id FROM topology_relationships r WHERE r.source_node_id = b.node_id)`);
    await getTestDb().execute(sql`UPDATE topology_collection_sources SET fresh_until = now() - interval '1 day', confirmed_through_at = now() - interval '2 days'
      WHERE producer_id = ${f.ids.OLD}::uuid`);

    const now = new Date();
    const attachments = await system(() => withDbTransaction(() => readDeviceAttachments(db, { orgId: f.orgId, siteId: f.siteA }, now)));
    expect(attachments.get(f.ids.W1!)).toEqual([expect.objectContaining({
      prefix: '10.1.2.0/24', gateway: '10.1.2.100', mac: GW_MAC, interfaceName: 'eth0', relationshipIds: [expect.any(String), expect.any(String)],
    })]);
    expect(Date.parse(attachments.get(f.ids.W1!)![0]!.freshUntil)).toBeGreaterThan(now.getTime());
    expect(attachments.has(f.ids.VPN!)).toBe(false); // tunnel interface: overlay, never an attachment
    expect(attachments.has(f.ids.OLD!)).toBe(false); // expired: not fresh
    // ...but within the 7-day anchor horizon it still anchors the site's fingerprint.
    const anchors = await system(() => withDbTransaction(() => readSiteAnchorEvidence(db, { orgId: f.orgId, siteId: f.siteA }, ['10.1.2.0/24'], HORIZON, now)));
    expect(anchors.evidence.map((e) => e.observerDeviceId).sort()).toEqual([f.ids.OLD, f.ids.W1].sort());
  });

  it('readOrgNetworkDeclarations returns every site of the org and none of another org', async () => {
    const f = await twoSiteOrg({ declare: { A: ['10.1.2.0/24', '10.1.2.0-10.1.2.255'], B: ['10.1.5.1/24'] }, devices: [] });
    const other = await twoSiteOrg({ declare: { A: ['10.9.9.0/24'] }, devices: [] });
    const read = await system(() => withDbTransaction(() => readOrgNetworkDeclarations(db, f.orgId)));
    expect([...read.bySite.keys()].sort()).toEqual([f.siteA, f.siteB].sort());
    expect([...read.bySite.get(f.siteA)!.keys()]).toEqual(['10.1.2.0/24']);
    expect([...read.bySite.get(f.siteB)!.keys()]).toEqual(['10.1.5.0/24']);
    expect(read.ignored).toBe(1);
    expect(read.bySite.has(other.siteA)).toBe(false);
  });
});
