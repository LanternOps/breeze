/**
 * listAssetCircuitDtos against real Postgres (W1-D2a, #8134). NOT run in the
 * authoring session (no Postgres); needs DATABASE_URL like its siblings.
 *
 * Proves what the mocked unit test cannot: the real join/filters, retired-interface
 * needs_reassociation, soft-deleted node exclusion and device-before-discovered
 * asset choice when two bindings collapse on one node.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  circuits, circuitTerminations, devices, discoveredAssets, sites,
  topologyInterfaces, topologyNodeBindings, topologyNodes,
} from '../../db/schema';
import { listAssetCircuitDtos } from '../../services/circuitAssetView';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const createdOrgs: string[] = [];
const asSystem = <T,>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const open = { scope: { allowedSiteIds: null }, canAccessOrg: () => true, includeInterfaces: true };

afterEach(async () => {
  if (createdOrgs.length === 0) return;
  const orgs = [...createdOrgs];
  createdOrgs.length = 0;
  await asSystem(async () => {
    await db.delete(circuits).where(inArray(circuits.orgId, orgs));
    await db.delete(topologyNodeBindings).where(inArray(topologyNodeBindings.orgId, orgs));
    await db.delete(topologyInterfaces).where(inArray(topologyInterfaces.orgId, orgs));
    await db.delete(topologyNodes).where(inArray(topologyNodes.orgId, orgs));
    await db.delete(discoveredAssets).where(inArray(discoveredAssets.orgId, orgs));
    await db.delete(devices).where(inArray(devices.orgId, orgs));
    await db.delete(sites).where(inArray(sites.orgId, orgs));
  });
});

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  createdOrgs.push(org.id);
  const site = await createSite({ orgId: org.id });
  const t = { orgId: org.id, siteId: site.id };
  const nodeId = crypto.randomUUID();
  await asSystem(async () => {
    await db.insert(topologyNodes).values({
      id: nodeId, ...t, kind: 'endpoint',
      identityKey: canonicalIdentityKey(t, 'endpoint', `inventory:${nodeId}`),
      identityMaterial: { version: 1, kind: 'endpoint', sourceKey: `inventory:${nodeId}` },
    });
  });
  const device = await asSystem(() => createDevice(t));
  await asSystem(() => db.insert(topologyNodeBindings).values({ ...t, nodeId, deviceId: device.id }));
  return { ...t, nodeId, deviceId: device.id };
}

async function addInterface(s: { orgId: string; siteId: string; nodeId: string }, key: string, retired = false) {
  const id = crypto.randomUUID();
  await asSystem(() => db.insert(topologyInterfaces).values({
    id, orgId: s.orgId, siteId: s.siteId, ownerNodeId: s.nodeId, interfaceKey: key,
    epoch: retired ? 'gen:1' : 'gen:2', role: 'wan', retiredAt: retired ? new Date() : null,
  }));
  return id;
}

async function terminate(orgId: string, interfaceId: string, cid: string) {
  return asSystem(async () => {
    const [c] = await db.insert(circuits).values({ orgId, providerName: 'Acme', cid }).returning({ id: circuits.id });
    await db.insert(circuitTerminations).values({ circuitId: c!.id, orgId, interfaceId });
    return c!.id;
  });
}

describe('listAssetCircuitDtos (real db)', () => {
  runDb('returns assigned and retired-interface (needs_reassociation) circuits; omits unassigned', async () => {
    const s = await seed();
    const cur = await addInterface(s, 'name:wan0');
    const old = await addInterface(s, 'name:wan1', true);
    const assigned = await terminate(s.orgId, cur, 'A');
    const reassoc = await terminate(s.orgId, old, 'B');
    await asSystem(() => db.insert(circuits).values({ orgId: s.orgId, providerName: 'Acme', cid: 'U' }));

    const view = await asSystem(() => listAssetCircuitDtos({ kind: 'device', id: s.deviceId, orgId: s.orgId, siteId: s.siteId }, open));
    expect(view.bound).toBe(true);
    expect(view.circuits.map((c) => [c.id, c.terminationState]).sort()).toEqual(
      [[assigned, 'assigned'], [reassoc, 'needs_reassociation']].sort(),
    );
    expect(view.interfaces.find((i) => i.id === old)).toMatchObject({ retired: true, circuitId: reassoc });
    expect(view.interfaces.find((i) => i.id === cur)).toMatchObject({ retired: false, circuitId: assigned });
  });

  runDb('treats an asset whose node is soft-deleted as unbound', async () => {
    const s = await seed();
    await asSystem(() => db.update(topologyNodes).set({ deletedAt: new Date() }).where(eq(topologyNodes.id, s.nodeId)));
    const view = await asSystem(() => listAssetCircuitDtos({ kind: 'device', id: s.deviceId, orgId: s.orgId, siteId: s.siteId }, open));
    expect(view.bound).toBe(false);
  });

  runDb('presents the device (not the discovered asset) when both bind the same node', async () => {
    const s = await seed();
    const iface = await addInterface(s, 'name:wan0');
    const asset = await asSystem(async () => {
      const [a] = await db.insert(discoveredAssets).values({
        orgId: s.orgId, siteId: s.siteId, assetType: 'router', ipAddress: '10.0.0.1',
      } as never).returning({ id: discoveredAssets.id });
      await db.insert(topologyNodeBindings).values({ orgId: s.orgId, siteId: s.siteId, nodeId: s.nodeId, discoveredAssetId: a!.id });
      return a!;
    });
    await terminate(s.orgId, iface, 'A');
    const view = await asSystem(() => listAssetCircuitDtos({ kind: 'discovered', id: asset.id, orgId: s.orgId, siteId: s.siteId }, open));
    expect(view.circuits[0]!.termination!.asset).toMatchObject({ kind: 'device', id: s.deviceId });
  });
});
