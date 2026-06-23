import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import { networkTopology, discoveredAssets } from '../../db/schema';
import { reconcileTopology } from '../../jobs/reconcileTopology';
import type { DeviceAdjacency } from '../../jobs/discoveryWorker';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const SWITCH_IP = '10.0.0.1';
const HOST_MAC = 'aa:bb:cc:dd:ee:ff';

/**
 * Phase 2 (FDB host attachment) end-to-end against the real DB (breeze_app conn,
 * RLS enforced). The load-bearing invariant: a method='manual' edge survives a
 * full reconcile run untouched, while the FDB pass writes a method='fdb' access
 * edge that coexists with it on the provenance unique index — and is idempotent.
 *
 * Fixtures are re-seeded per `it` (never memoized) so the breeze_app RLS path is
 * exercised against fresh rows each time and never goes vacuous.
 */
describe('reconcileTopology — Phase 2 FDB attach (real DB)', () => {
  let orgId: string;
  let siteId: string;
  let switchId: string;
  let hostId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    orgId = org.id;
    siteId = site.id;

    // The FDB source switch — resolved by its mgmt IP.
    const [sw] = await getTestDb()
      .insert(discoveredAssets)
      .values({
        orgId,
        siteId,
        ipAddress: SWITCH_IP,
        macAddress: '11:22:33:44:55:66',
        hostname: 'edge-switch',
        assetType: 'switch',
        approvalStatus: 'approved',
        isOnline: true,
        discoveryMethods: ['snmp'],
      })
      .returning({ id: discoveredAssets.id });
    if (!sw) throw new Error('insert switch asset returned no row');
    switchId = sw.id;

    // The host attached behind an access port — matched by MAC.
    const [host] = await getTestDb()
      .insert(discoveredAssets)
      .values({
        orgId,
        siteId,
        ipAddress: '10.0.0.50',
        macAddress: HOST_MAC,
        hostname: 'host-pc',
        assetType: 'workstation',
        approvalStatus: 'approved',
        isOnline: true,
        discoveryMethods: ['arp'],
      })
      .returning({ id: discoveredAssets.id });
    if (!host) throw new Error('insert host asset returned no row');
    hostId = host.id;
  });

  const fdbAdjacency = (): DeviceAdjacency[] => [{
    sourceDeviceIp: SWITCH_IP,
    lldp: [],
    cdp: [],
    fdb: [{ mac: HOST_MAC, bridgePort: 5, ifName: 'Gi0/5' }],
  }];

  it('preserves a manual edge while writing an fdb edge; second reconcile stays idempotent', async () => {
    // Pre-existing manual edge on the SAME source/target pair (protects the
    // not-yet-built Phase 4 manual feature). Back-dated so any (incorrect)
    // age-out would have a chance to delete it.
    const [manualRow] = await getTestDb()
      .insert(networkTopology)
      .values({
        orgId,
        siteId,
        sourceType: 'discovered_asset',
        sourceId: switchId,
        targetType: 'discovered_asset',
        targetId: hostId,
        connectionType: 'manual',
        method: 'manual',
        confidence: 'asserted',
        lastVerifiedAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning({ id: networkTopology.id, lastVerifiedAt: networkTopology.lastVerifiedAt });
    if (!manualRow) throw new Error('insert manual edge returned no row');
    const manualId = manualRow.id;
    const manualVerifiedAt = manualRow.lastVerifiedAt;

    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], fdbAdjacency()));

    // Manual edge unchanged: same id, untouched last_verified_at.
    const manualAfter = await getTestDb()
      .select()
      .from(networkTopology)
      .where(and(eq(networkTopology.orgId, orgId), eq(networkTopology.method, 'manual')));
    expect(manualAfter).toHaveLength(1);
    expect(manualAfter[0]!.id).toBe(manualId);
    expect(manualAfter[0]!.lastVerifiedAt!.getTime()).toBe(manualVerifiedAt!.getTime());

    // A distinct fdb edge now coexists for the same source/target pair.
    const fdbAfter = await getTestDb()
      .select()
      .from(networkTopology)
      .where(and(eq(networkTopology.orgId, orgId), eq(networkTopology.method, 'fdb')));
    expect(fdbAfter).toHaveLength(1);
    const fdbEdge = fdbAfter[0]!;
    expect(fdbEdge.sourceId).toBe(switchId);
    expect(fdbEdge.targetId).toBe(hostId);
    expect(fdbEdge.connectionType).toBe('access');
    expect(fdbEdge.confidence).toBe('medium');
    expect(fdbEdge.interfaceName).toBe('Gi0/5');
    expect(fdbEdge.id).not.toBe(manualId);
    const firstFdbVerified = fdbEdge.lastVerifiedAt;

    // Second reconcile: still exactly one manual + one fdb (upsert, no dupes).
    await new Promise((r) => setTimeout(r, 5));
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], fdbAdjacency()));

    const allAfter = await getTestDb()
      .select()
      .from(networkTopology)
      .where(eq(networkTopology.orgId, orgId));
    expect(allAfter.filter((r) => r.method === 'manual')).toHaveLength(1);
    const fdbRows = allAfter.filter((r) => r.method === 'fdb');
    expect(fdbRows).toHaveLength(1);
    // fdb last_verified_at bumped (or equal), no duplicate row.
    expect(fdbRows[0]!.lastVerifiedAt!.getTime()).toBeGreaterThanOrEqual(firstFdbVerified!.getTime());
    // The manual edge is still byte-for-byte the same row.
    const manualFinal = allAfter.filter((r) => r.method === 'manual');
    expect(manualFinal[0]!.id).toBe(manualId);
    expect(manualFinal[0]!.lastVerifiedAt!.getTime()).toBe(manualVerifiedAt!.getTime());
  });

  it('excludes an uplink port: an LLDP neighbor on Gi0/5 suppresses the fdb attach', async () => {
    const adjacency: DeviceAdjacency[] = [{
      sourceDeviceIp: SWITCH_IP,
      lldp: [{
        localPort: '5',
        localIfName: 'Gi0/5',
        remoteChassisId: '99:88:77:66:55:44',
        remotePortId: 'Gi0/1',
        remoteSysName: 'core',
      }],
      cdp: [],
      fdb: [{ mac: HOST_MAC, bridgePort: 5, ifName: 'Gi0/5' }],
    }];

    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency));

    const fdbAfter = await getTestDb()
      .select()
      .from(networkTopology)
      .where(and(eq(networkTopology.orgId, orgId), eq(networkTopology.method, 'fdb')));
    expect(fdbAfter).toHaveLength(0);
  });

  it('skips an unknown MAC: no fdb edge written, reconcile resolves without error', async () => {
    const adjacency: DeviceAdjacency[] = [{
      sourceDeviceIp: SWITCH_IP,
      lldp: [],
      cdp: [],
      fdb: [{ mac: '00:00:00:00:00:99', bridgePort: 7, ifName: 'Gi0/7' }],
    }];

    await expect(
      withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency)),
    ).resolves.toBeUndefined();

    const fdbAfter = await getTestDb()
      .select()
      .from(networkTopology)
      .where(and(eq(networkTopology.orgId, orgId), eq(networkTopology.method, 'fdb')));
    expect(fdbAfter).toHaveLength(0);
  });
});
