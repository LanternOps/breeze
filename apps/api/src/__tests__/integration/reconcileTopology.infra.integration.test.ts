import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import { networkTopology, discoveredAssets } from '../../db/schema';
import { reconcileTopology, MEASURED_EDGE_AGEOUT_MS } from '../../jobs/reconcileTopology';
import type { DeviceAdjacency } from '../../jobs/discoveryWorker';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const adjacency: DeviceAdjacency[] = [{
  sourceDeviceIp: '10.0.0.1',
  lldp: [{ localPort: '1', localIfName: 'Gi0/1', remoteChassisId: 'aa:bb:cc:dd:ee:ff', remotePortId: 'Gi0/24', remoteSysName: 'core' }],
  cdp: [],
  fdb: [],
}];

describe('reconcileTopology (real DB)', () => {
  let orgId: string;
  let siteId: string;
  let coreId: string;
  let edgeId: string;

  beforeEach(async () => {
    // seed partner→org→site, then two discovered_assets (core + edge switch) in this site.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    orgId = org.id;
    siteId = site.id;

    // edge switch: mgmt IP 10.0.0.1, mac 11:22:33:44:55:66
    const [edge] = await getTestDb()
      .insert(discoveredAssets)
      .values({
        orgId,
        siteId,
        ipAddress: '10.0.0.1',
        macAddress: '11:22:33:44:55:66',
        hostname: 'edge',
        assetType: 'switch',
        approvalStatus: 'approved',
        isOnline: true,
        discoveryMethods: ['snmp'],
      })
      .returning({ id: discoveredAssets.id });
    if (!edge) throw new Error('insert edge asset returned no row');
    edgeId = edge.id;

    // core switch: mgmt IP 10.0.0.254, mac aa:bb:cc:dd:ee:ff, hostname 'core'
    const [core] = await getTestDb()
      .insert(discoveredAssets)
      .values({
        orgId,
        siteId,
        ipAddress: '10.0.0.254',
        macAddress: 'aa:bb:cc:dd:ee:ff',
        hostname: 'core',
        assetType: 'switch',
        approvalStatus: 'approved',
        isOnline: true,
        discoveryMethods: ['snmp'],
      })
      .returning({ id: discoveredAssets.id });
    if (!core) throw new Error('insert core asset returned no row');
    coreId = core.id;
  });

  it('upserts an infra edge and is idempotent across two scans (one row, bumped last_verified_at)', async () => {
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency));
    const first = await getTestDb().select().from(networkTopology).where(eq(networkTopology.orgId, orgId));
    expect(first).toHaveLength(1);
    const firstEdge = first[0];
    if (!firstEdge) throw new Error('expected one topology edge after first reconcile');
    expect(firstEdge.method).toBe('lldp');
    expect(firstEdge.confidence).toBe('high');
    expect(firstEdge.connectionType).toBe('infra');
    expect(firstEdge.interfaceName).toBe('Gi0/1');
    expect(firstEdge.sourceId).toBe(edgeId);
    expect(firstEdge.targetId).toBe(coreId);
    const firstVerified = firstEdge.lastVerifiedAt;

    await new Promise((r) => setTimeout(r, 5));
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency));
    const second = await getTestDb().select().from(networkTopology).where(eq(networkTopology.orgId, orgId));
    expect(second).toHaveLength(1); // upsert, not a duplicate
    const secondEdge = second[0];
    if (!secondEdge) throw new Error('expected one topology edge after second reconcile');
    expect(secondEdge.lastVerifiedAt!.getTime()).toBeGreaterThanOrEqual(firstVerified!.getTime());
  });

  it('ages out a measured edge that is not re-observed and is old enough', async () => {
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency));
    // backdate the edge beyond the age-out window, then reconcile with empty-but-defined
    // adjacency for that pair (no neighbors → the edge is not re-observed).
    await getTestDb().update(networkTopology)
      .set({ lastVerifiedAt: new Date(Date.now() - MEASURED_EDGE_AGEOUT_MS - 10_000) })
      .where(eq(networkTopology.orgId, orgId));
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], [{
      sourceDeviceIp: '10.0.0.1', lldp: [], cdp: [], fdb: [],
    }]));
    const rows = await getTestDb().select().from(networkTopology).where(eq(networkTopology.orgId, orgId));
    expect(rows.filter((r) => r.method === 'lldp')).toHaveLength(0);
  });

  it('never deletes a manual edge during reconcile', async () => {
    await getTestDb().insert(networkTopology).values({
      orgId,
      siteId,
      sourceType: 'discovered_asset',
      sourceId: edgeId,
      targetType: 'discovered_asset',
      targetId: coreId,
      connectionType: 'infra',
      method: 'manual',
      confidence: 'asserted',
      lastVerifiedAt: new Date(Date.now() - MEASURED_EDGE_AGEOUT_MS - 60_000),
    });
    await withSystemDbAccessContext(() => reconcileTopology(orgId, siteId, [], adjacency));
    const manual = await getTestDb().select().from(networkTopology)
      .where(and(eq(networkTopology.orgId, orgId), eq(networkTopology.method, 'manual')));
    expect(manual).toHaveLength(1); // survived
  });
});
