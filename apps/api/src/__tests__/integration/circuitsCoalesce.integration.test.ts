/**
 * Interface coalescing and generation roll for WAN circuits (spec §6.4), against
 * real Postgres. Coalescing with a known successor must carry the operator WAN role
 * and the circuit termination; the loser row delete must not drop the termination.
 * A generation roll proves no successor: the termination stays on the retired row
 * as history and the circuit derives needs_reassociation.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  circuits,
  circuitTerminations,
  devices,
  discoveredAssets,
  sites,
  topologyInterfaces,
  topologyNodeBindings,
  topologyNodes,
} from '../../db/schema';
import { getCircuitDto } from '../../services/circuits';
import { applyMergedInterfaces, type MergedInterfacePlan } from '../../services/topology/physicalPublication';
import { canonicalIdentityKey } from '../../services/topology/identity';
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

/** Owner node plus one interface on it. */
async function seedInterface(
  t: { orgId: string; siteId: string },
  opts: { key: string; role?: string | null; retired?: boolean; nodeId?: string },
): Promise<{ nodeId: string; ifaceId: string }> {
  return asSystem(async () => {
    const nodeId = opts.nodeId ?? crypto.randomUUID();
    if (!opts.nodeId) {
      await db.insert(topologyNodes).values({
        id: nodeId, orgId: t.orgId, siteId: t.siteId, kind: 'endpoint',
        identityKey: canonicalIdentityKey({ orgId: t.orgId, siteId: t.siteId }, 'endpoint', `inventory:${nodeId}`),
        identityMaterial: { version: 1, kind: 'endpoint', sourceKey: `inventory:${nodeId}` },
      });
    }
    const ifaceId = crypto.randomUUID();
    await db.insert(topologyInterfaces).values({
      id: ifaceId, orgId: t.orgId, siteId: t.siteId, ownerNodeId: nodeId,
      interfaceKey: opts.key, epoch: 'gen:1', role: opts.role ?? null,
      retiredAt: opts.retired ? new Date() : null,
    });
    return { nodeId, ifaceId };
  });
}

async function seedCircuit(orgId: string, cid: string): Promise<string> {
  return asSystem(async () => {
    const [row] = await db.insert(circuits).values({ orgId, providerName: 'Acme', cid }).returning({ id: circuits.id });
    return row!.id;
  });
}

async function terminate(orgId: string, circuitId: string, interfaceId: string) {
  await asSystem(() => db.insert(circuitTerminations).values({ circuitId, orgId, interfaceId }));
}

/** Coalesce `from` into `to` through the production apply path, in one transaction. */
async function coalesce(t: { orgId: string; siteId: string }, from: string, to: string, survivorNodeId: string) {
  const plan: MergedInterfacePlan = { reowned: [], coalesced: new Map([[from, to]]) };
  await asSystem(() => db.transaction(tx =>
    applyMergedInterfaces(tx, { orgId: t.orgId, siteId: t.siteId } as never, plan, new Map([[to, survivorNodeId]]))));
}

async function ifaceRow(id: string) {
  const [row] = await asSystem(() => db.select().from(topologyInterfaces).where(eq(topologyInterfaces.id, id)));
  return row;
}

async function termOf(circuitId: string) {
  const [row] = await asSystem(() => db.select().from(circuitTerminations).where(eq(circuitTerminations.circuitId, circuitId)));
  return row;
}

describe('coalescing with a known successor (§6.4)', () => {
  runDb('copies the operator WAN role to a survivor that has none', async () => {
    const t = await seedTenant();
    const survivor = await seedInterface(t, { key: 'name:Gi0/1', role: null });
    const loser = await seedInterface(t, { key: 'name:Gi0/1-old', role: 'wan' });

    await coalesce(t, loser.ifaceId, survivor.ifaceId, survivor.nodeId);

    expect((await ifaceRow(survivor.ifaceId))?.role).toBe('wan');
    expect(await ifaceRow(loser.ifaceId)).toBeUndefined();
  });

  runDb('never overwrites an operator role already set on the survivor', async () => {
    const t = await seedTenant();
    const survivor = await seedInterface(t, { key: 'name:Gi0/1', role: 'lan' });
    const loser = await seedInterface(t, { key: 'name:Gi0/1-old', role: 'wan' });

    await coalesce(t, loser.ifaceId, survivor.ifaceId, survivor.nodeId);

    expect((await ifaceRow(survivor.ifaceId))?.role).toBe('lan');
  });

  runDb('moves a termination that only the loser has to the survivor, keeping the circuit', async () => {
    const t = await seedTenant();
    const survivor = await seedInterface(t, { key: 'name:Gi0/1', role: null });
    const loser = await seedInterface(t, { key: 'name:Gi0/1-old', role: 'wan' });
    const circuitId = await seedCircuit(t.orgId, 'CID-MOVE');
    await terminate(t.orgId, circuitId, loser.ifaceId);

    await coalesce(t, loser.ifaceId, survivor.ifaceId, survivor.nodeId);

    const term = await termOf(circuitId);
    expect(term?.interfaceId).toBe(survivor.ifaceId);
    const [circuit] = await asSystem(() => db.select().from(circuits).where(eq(circuits.id, circuitId)));
    expect(circuit?.needsReassociation).toBe(false);
  });

  runDb('a termination moved onto a retired survivor derives needs_reassociation', async () => {
    const t = await seedTenant();
    const survivor = await seedInterface(t, { key: 'name:Gi0/1', role: null, retired: true });
    const loser = await seedInterface(t, { key: 'name:Gi0/1-old', role: 'wan' });
    const circuitId = await seedCircuit(t.orgId, 'CID-RETIRED');
    await terminate(t.orgId, circuitId, loser.ifaceId);

    await coalesce(t, loser.ifaceId, survivor.ifaceId, survivor.nodeId);

    expect((await termOf(circuitId))?.interfaceId).toBe(survivor.ifaceId);
    const dto = await asSystem(() => getCircuitDto(circuitId));
    expect(dto?.terminationState).toBe('needs_reassociation');
  });

  runDb('keeps the survivor termination when both sides are terminated, and flags the loser circuit', async () => {
    const t = await seedTenant();
    const survivor = await seedInterface(t, { key: 'name:Gi0/1', role: 'wan' });
    const loser = await seedInterface(t, { key: 'name:Gi0/1-old', role: 'wan' });
    const survivorCircuit = await seedCircuit(t.orgId, 'CID-SURVIVOR');
    const loserCircuit = await seedCircuit(t.orgId, 'CID-LOSER');
    await terminate(t.orgId, survivorCircuit, survivor.ifaceId);
    await terminate(t.orgId, loserCircuit, loser.ifaceId);

    await coalesce(t, loser.ifaceId, survivor.ifaceId, survivor.nodeId);

    expect((await termOf(survivorCircuit))?.interfaceId).toBe(survivor.ifaceId);
    expect(await termOf(loserCircuit)).toBeUndefined();
    const [survivorC] = await asSystem(() => db.select().from(circuits).where(eq(circuits.id, survivorCircuit)));
    const [loserC] = await asSystem(() => db.select().from(circuits).where(eq(circuits.id, loserCircuit)));
    expect(survivorC?.needsReassociation).toBe(false);
    expect(loserC?.needsReassociation).toBe(true);
  });

  runDb('leaves the survivor untouched when the loser has no termination and no role', async () => {
    const t = await seedTenant();
    const survivor = await seedInterface(t, { key: 'name:Gi0/1', role: null });
    const loser = await seedInterface(t, { key: 'name:Gi0/1-old', role: null });

    await coalesce(t, loser.ifaceId, survivor.ifaceId, survivor.nodeId);

    expect((await ifaceRow(survivor.ifaceId))?.role).toBeNull();
  });
});

describe('generation roll proves no successor (§6.4)', () => {
  runDb('the retired row keeps its termination and the new row starts without a role', async () => {
    const t = await seedTenant();
    const current = await seedInterface(t, { key: 'name:Gi0/2', role: 'wan' });
    const circuitId = await seedCircuit(t.orgId, 'CID-ROLL');
    await terminate(t.orgId, circuitId, current.ifaceId);

    // Mirrors planInterfaceGeneration(retireCurrent = true): old row retired, new row created with no role.
    const successorId = crypto.randomUUID();
    await asSystem(async () => {
      await db.update(topologyInterfaces).set({ retiredAt: new Date() }).where(eq(topologyInterfaces.id, current.ifaceId));
      await db.insert(topologyInterfaces).values({
        id: successorId, orgId: t.orgId, siteId: t.siteId, ownerNodeId: current.nodeId,
        interfaceKey: 'name:Gi0/2', epoch: 'gen:2', role: null,
      });
    });

    expect((await termOf(circuitId))?.interfaceId).toBe(current.ifaceId);
    expect((await ifaceRow(successorId))?.role).toBeNull();
    const dto = await asSystem(() => getCircuitDto(circuitId));
    expect(dto?.terminationState).toBe('needs_reassociation');
    expect(dto?.termination).toBeNull();
  });
});
