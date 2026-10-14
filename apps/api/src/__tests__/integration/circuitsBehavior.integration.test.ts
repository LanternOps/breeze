/**
 * Circuits / WAN behaviour against real Postgres (spec §17 Integration).
 *
 * Covers what the generic RLS, cascade and merge contracts do not prove on their
 * own: the CHECK constraints, same-org composite FKs (cross-org termination and
 * served site rejected at the DB), one termination per interface, the BEFORE
 * DELETE trigger that marks needs_reassociation on hard delete, and the derived
 * terminationState read model.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  circuits,
  circuitServedSites,
  circuitTerminations,
  devices,
  discoveredAssets,
  sites,
  topologyInterfaces,
  topologyNodeBindings,
  topologyNodes,
} from '../../db/schema';
import { getCircuitDto } from '../../services/circuits';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { pgErrorCode } from '../../utils/pgErrors';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const createdOrgs: string[] = [];

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

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

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  createdOrgs.push(org.id);
  const site = await createSite({ orgId: org.id });
  return { orgId: org.id, siteId: site.id };
}

/** Owner node + WAN-marked current interface at the given site. */
async function seedWanInterface(t: { orgId: string; siteId: string }, key = 'name:Gi0/1'): Promise<{ nodeId: string; ifaceId: string }> {
  return asSystem(async () => {
    const nodeId = crypto.randomUUID();
    const ifaceId = crypto.randomUUID();
    await db.insert(topologyNodes).values({
      id: nodeId, orgId: t.orgId, siteId: t.siteId, kind: 'endpoint',
      identityKey: canonicalIdentityKey({ orgId: t.orgId, siteId: t.siteId }, 'endpoint', `inventory:${nodeId}`),
      identityMaterial: { version: 1, kind: 'endpoint', sourceKey: `inventory:${nodeId}` },
    });
    await db.insert(topologyInterfaces).values({
      id: ifaceId, orgId: t.orgId, siteId: t.siteId, ownerNodeId: nodeId,
      interfaceKey: key, epoch: 'gen:1', role: 'wan',
    });
    return { nodeId, ifaceId };
  });
}

async function seedCircuit(orgId: string, cid = 'CID-1'): Promise<string> {
  return asSystem(async () => {
    const [row] = await db.insert(circuits).values({ orgId, providerName: 'Acme', cid }).returning({ id: circuits.id });
    return row!.id;
  });
}

describe('circuit row invariants', () => {
  runDb('rejects non-positive bandwidth and an unknown administrative status', async () => {
    const t = await seedTenant();
    const badBw = await asSystem(() =>
      db.insert(circuits).values({ orgId: t.orgId, providerName: 'a', cid: 'b', bandwidthBps: 0 }),
    ).catch((e) => pgErrorCode(e));
    expect(badBw).toBe('23514');

    const badStatus = await asSystem(() =>
      db.insert(circuits).values({ orgId: t.orgId, providerName: 'a', cid: 'b', administrativeStatus: 'live' }),
    ).catch((e) => pgErrorCode(e));
    expect(badStatus).toBe('23514');
  });
});

describe('same-org composite FKs', () => {
  runDb('rejects a termination whose interface belongs to another org', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const circuitId = await seedCircuit(a.orgId);
    const { ifaceId } = await seedWanInterface(b);

    const code = await asSystem(() =>
      db.insert(circuitTerminations).values({ circuitId, orgId: a.orgId, interfaceId: ifaceId }),
    ).catch((e) => pgErrorCode(e));
    expect(code).toBe('23503');
  });

  runDb('rejects a served site that belongs to another org', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const circuitId = await seedCircuit(a.orgId);

    const code = await asSystem(() =>
      db.insert(circuitServedSites).values({ circuitId, siteId: b.siteId, orgId: a.orgId }),
    ).catch((e) => pgErrorCode(e));
    expect(code).toBe('23503');
  });
});

describe('one current termination per interface', () => {
  runDb('a second circuit cannot terminate the same interface', async () => {
    const t = await seedTenant();
    const { ifaceId } = await seedWanInterface(t);
    const first = await seedCircuit(t.orgId, 'CID-A');
    const second = await seedCircuit(t.orgId, 'CID-B');

    await asSystem(() => db.insert(circuitTerminations).values({ circuitId: first, orgId: t.orgId, interfaceId: ifaceId }));
    const code = await asSystem(() =>
      db.insert(circuitTerminations).values({ circuitId: second, orgId: t.orgId, interfaceId: ifaceId }),
    ).catch((e) => pgErrorCode(e));
    expect(code).toBe('23505');
  });
});

describe('hard-delete trigger and derived termination state', () => {
  runDb('deleting the terminating interface keeps the circuit and marks needs_reassociation', async () => {
    const t = await seedTenant();
    const { ifaceId } = await seedWanInterface(t);
    const circuitId = await seedCircuit(t.orgId);
    await asSystem(() => db.insert(circuitTerminations).values({ circuitId, orgId: t.orgId, interfaceId: ifaceId }));

    await asSystem(() => db.delete(topologyInterfaces).where(eq(topologyInterfaces.id, ifaceId)));

    const [circuit] = await asSystem(() => db.select().from(circuits).where(eq(circuits.id, circuitId)));
    expect(circuit).toBeDefined();
    expect(circuit!.needsReassociation).toBe(true);

    const [term] = await asSystem(() => db.select().from(circuitTerminations).where(eq(circuitTerminations.circuitId, circuitId)));
    expect(term).toBeUndefined();

    const dto = await asSystem(() => getCircuitDto(circuitId));
    expect(dto?.terminationState).toBe('needs_reassociation');
    expect(dto?.termination).toBeNull();
  });

  runDb('a termination whose owner node has no binding derives needs_reassociation', async () => {
    const t = await seedTenant();
    const { ifaceId } = await seedWanInterface(t);
    const circuitId = await seedCircuit(t.orgId);
    await asSystem(() => db.insert(circuitTerminations).values({ circuitId, orgId: t.orgId, interfaceId: ifaceId }));

    const dto = await asSystem(() => getCircuitDto(circuitId));
    expect(dto?.terminationState).toBe('needs_reassociation');
    expect(dto?.termination).toBeNull();
  });

  runDb('a bound owner node derives assigned with the derived primary site', async () => {
    const t = await seedTenant();
    const { nodeId, ifaceId } = await seedWanInterface(t);
    const device = await asSystem(() => createDevice({ orgId: t.orgId, siteId: t.siteId }));
    await asSystem(() => db.insert(topologyNodeBindings).values({
      orgId: t.orgId, siteId: t.siteId, nodeId, deviceId: device.id, provenance: {},
    }));
    const circuitId = await seedCircuit(t.orgId);
    await asSystem(() => db.insert(circuitTerminations).values({ circuitId, orgId: t.orgId, interfaceId: ifaceId }));

    const dto = await asSystem(() => getCircuitDto(circuitId));
    expect(dto?.terminationState).toBe('assigned');
    expect(dto?.termination?.primarySite.id).toBe(t.siteId);
    expect(dto?.termination?.asset?.kind).toBe('device');
  });
});
