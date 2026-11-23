/**
 * Policy reach under real forced RLS (#12465, plan W02a R5).
 *
 * `computePolicyReach` runs every statement on the ambient `db`, so its counts
 * are only as tenant-safe as the request context it runs in. The unit suite
 * fakes the driver and cannot see RLS; this file runs the function inside
 * `withDbAccessContext` on the unprivileged `breeze_app` connection, with
 * contexts built by the real `buildDbAccessContext`.
 *
 * The fixtures are chosen so a leak would show: the policies are partner-owned
 * (no `devices.org_id` clamp) and reach devices in two organizations, so only
 * RLS and the child access condition keep a limited caller's counts to its own
 * organization. Each limited case carries a full-access control.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
} from '../../db/schema';
import { computePolicyReach, readablePolicyIds, type ConfigPolicyReach } from '../../services/configPolicyReach';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return buildDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId, userId: null });
}

function partnerCtx(partnerId: string, orgIds: string[]): DbAccessContext {
  return buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, partnerId, userId: null });
}

function orgAuth(orgId: string, partnerId: string): AuthContext {
  return {
    user: { id: randomUUID(), email: 'org@example.com', name: 'Org User', isPlatformAdmin: false },
    token: {} as never,
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (col: unknown) => eq(col as never, orgId),
    canAccessOrg: (id: string) => id === orgId,
  } as unknown as AuthContext;
}

function partnerAuth(partnerId: string, orgIds: string[]): AuthContext {
  return {
    user: { id: randomUUID(), email: 'msp@example.com', name: 'MSP User', isPlatformAdmin: false },
    token: {} as never,
    partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: orgIds,
    orgCondition: (col: unknown) => inArray(col as never, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
  } as unknown as AuthContext;
}

const createdPolicies: string[] = [];
const createdGroups: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdPolicies.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.parentPolicyId, createdPolicies));
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, createdPolicies));
    }
    if (createdGroups.length > 0) {
      await db.delete(deviceGroupMemberships).where(inArray(deviceGroupMemberships.groupId, createdGroups));
      await db.delete(deviceGroups).where(inArray(deviceGroups.id, createdGroups));
    }
  });
  createdPolicies.length = 0;
  createdGroups.length = 0;
});

async function seedPolicy(owner: { orgId: string | null; partnerId: string | null }, parentPolicyId: string | null = null) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: `reach ${randomUUID().slice(0, 8)}`,
        // Reach describes targets, not enforcement: an inactive policy counts.
        status: 'inactive',
        parentPolicyId,
      })
      .returning();
    createdPolicies.push(policy!.id);
    return policy!.id;
  });
}

async function assign(
  configPolicyId: string,
  level: 'partner' | 'organization' | 'site' | 'device_group' | 'device',
  targetId: string,
  filters: { roleFilter?: string[] | null; osFilter?: string[] | null } = {},
) {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(configPolicyAssignments).values({
      configPolicyId,
      level,
      targetId,
      priority: 0,
      roleFilter: filters.roleFilter ?? null,
      osFilter: filters.osFilter ?? null,
    });
  });
}

async function seedDevice(orgId: string, siteId: string, deviceRole: 'workstation' | 'server' = 'workstation') {
  const { id } = await createDevice({ orgId, siteId });
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.update(devices).set({ deviceRole }).where(eq(devices.id, id));
  });
  return id;
}

async function seedGroup(owner: { orgId: string | null; partnerId: string | null }, name: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [group] = await db
      .insert(deviceGroups)
      .values({ orgId: owner.orgId, partnerId: owner.partnerId, name })
      .returning();
    createdGroups.push(group!.id);
    return group!.id;
  });
}

async function addMembers(groupId: string, members: Array<{ deviceId: string; orgId: string }>) {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(deviceGroupMemberships).values(members.map((m) => ({ groupId, orgId: m.orgId, deviceId: m.deviceId })));
  });
}

async function reachAs(ctx: DbAccessContext, auth: AuthContext, ids: string[]): Promise<Map<string, ConfigPolicyReach>> {
  return withDbAccessContext(ctx, () => computePolicyReach(auth, ids));
}

/** Two organizations under one partner, each with one site. */
async function twoOrgs() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'Birch' });
  const siteA = await createSite({ orgId: orgA!.id, name: 'Acme HQ' });
  const siteB = await createSite({ orgId: orgB!.id, name: 'Birch HQ' });
  return { partner, orgA: orgA!, orgB: orgB!, siteA: siteA!, siteB: siteB! };
}

describe('computePolicyReach under forced RLS', () => {
  it('group membership and the role filter decide the count', async () => {
    const { partner, orgA, siteA } = await twoOrgs();
    const ws1 = await seedDevice(orgA.id, siteA.id, 'workstation');
    const ws2 = await seedDevice(orgA.id, siteA.id, 'workstation');
    const srv = await seedDevice(orgA.id, siteA.id, 'server');
    await seedDevice(orgA.id, siteA.id, 'workstation'); // in the site, not in the group
    const groupId = await seedGroup({ orgId: orgA.id, partnerId: null }, 'Laptops');
    await addMembers(groupId, [ws1, ws2, srv].map((deviceId) => ({ deviceId, orgId: orgA.id })));

    const grouped = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(grouped, 'device_group', groupId);
    const workstationsOnly = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(workstationsOnly, 'device_group', groupId, { roleFilter: ['workstation'] });
    const wholeSite = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(wholeSite, 'site', siteA.id, { roleFilter: ['workstation'] });

    const reach = await reachAs(partnerCtx(partner.id, [orgA.id]), partnerAuth(partner.id, [orgA.id]), [
      grouped,
      workstationsOnly,
      wholeSite,
    ]);

    expect(reach.get(grouped)).toEqual({ direct: 3, throughChildren: 0, organizations: 1 });
    expect(reach.get(workstationsOnly)).toEqual({ direct: 2, throughChildren: 0, organizations: 1 });
    expect(reach.get(wholeSite)).toEqual({ direct: 3, throughChildren: 0, organizations: 1 });
  });

  it('a partner-owned group counts its members in every organization the caller can read', async () => {
    const { partner, orgA, orgB, siteA, siteB } = await twoOrgs();
    const a1 = await seedDevice(orgA.id, siteA.id);
    const b1 = await seedDevice(orgB.id, siteB.id);
    const groupId = await seedGroup({ orgId: null, partnerId: partner.id }, 'MSP ring');
    await addMembers(groupId, [{ deviceId: a1, orgId: orgA.id }, { deviceId: b1, orgId: orgB.id }]);
    const policy = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(policy, 'device_group', groupId);

    const both = [orgA.id, orgB.id];
    const full = await reachAs(partnerCtx(partner.id, both), partnerAuth(partner.id, both), [policy]);
    expect(full.get(policy)).toEqual({ direct: 2, throughChildren: 0, organizations: 2 });

    const limited = await reachAs(partnerCtx(partner.id, [orgA.id]), partnerAuth(partner.id, [orgA.id]), [policy]);
    expect(limited.get(policy)).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });
  });

  it("an org-scope caller's throughChildren counts only its own organization's devices", async () => {
    // A partner-owned parent with one child in each organization. The parent
    // row is SELECT-legible to an org caller (partner-wide read branch), so
    // only RLS and the child access condition keep org B out.
    const { partner, orgA, orgB, siteA, siteB } = await twoOrgs();
    await seedDevice(orgA.id, siteA.id);
    await seedDevice(orgA.id, siteA.id);
    await seedDevice(orgB.id, siteB.id);
    await seedDevice(orgB.id, siteB.id);
    await seedDevice(orgB.id, siteB.id);
    const parent = await seedPolicy({ orgId: null, partnerId: partner.id });
    const childA = await seedPolicy({ orgId: orgA.id, partnerId: null }, parent);
    const childB = await seedPolicy({ orgId: orgB.id, partnerId: null }, parent);
    await assign(childA, 'site', siteA.id);
    await assign(childB, 'site', siteB.id);

    // Control: the partner with both organizations sees all five.
    const both = [orgA.id, orgB.id];
    const full = await reachAs(partnerCtx(partner.id, both), partnerAuth(partner.id, both), [parent]);
    expect(full.get(parent)).toEqual({ direct: 0, throughChildren: 5, organizations: 2 });

    const asOrgA = await reachAs(orgCtx(orgA.id, partner.id), orgAuth(orgA.id, partner.id), [parent]);
    expect(asOrgA.get(parent)).toEqual({ direct: 0, throughChildren: 2, organizations: 1 });
  });

  it("an org-scope caller's direct count on a partner-level row stays in its organization", async () => {
    // Nothing but RLS confines this one: the policy is partner-owned (no org
    // clamp) and its partner-level row spans both organizations.
    const { partner, orgA, orgB, siteA, siteB } = await twoOrgs();
    await seedDevice(orgA.id, siteA.id);
    await seedDevice(orgB.id, siteB.id);
    await seedDevice(orgB.id, siteB.id);
    const policy = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(policy, 'partner', partner.id);

    const both = [orgA.id, orgB.id];
    const full = await reachAs(partnerCtx(partner.id, both), partnerAuth(partner.id, both), [policy]);
    expect(full.get(policy)).toEqual({ direct: 3, throughChildren: 0, organizations: 2 });

    const asOrgA = await reachAs(orgCtx(orgA.id, partner.id), orgAuth(orgA.id, partner.id), [policy]);
    expect(asOrgA.get(policy)).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });
  });

  it('a partner-scope caller counts devices across its organizations', async () => {
    const { partner, orgA, orgB, siteA, siteB } = await twoOrgs();
    const a1 = await seedDevice(orgA.id, siteA.id);
    await seedDevice(orgA.id, siteA.id);
    await seedDevice(orgB.id, siteB.id);
    const parent = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(parent, 'partner', partner.id);
    // A child that re-targets a device the parent already reaches adds nothing.
    const child = await seedPolicy({ orgId: orgA.id, partnerId: null }, parent);
    await assign(child, 'device', a1);

    const both = [orgA.id, orgB.id];
    const full = await reachAs(partnerCtx(partner.id, both), partnerAuth(partner.id, both), [parent, child]);
    expect(full.get(parent)).toEqual({ direct: 3, throughChildren: 0, organizations: 2 });
    expect(full.get(child)).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });

    // A partner user limited to org A: the partner-level row reaches only org A.
    const limited = await reachAs(partnerCtx(partner.id, [orgA.id]), partnerAuth(partner.id, [orgA.id]), [parent]);
    expect(limited.get(parent)).toEqual({ direct: 2, throughChildren: 0, organizations: 1 });
  });

  it("the count runs in the caller's context", async () => {
    const { partner, orgA, siteA } = await twoOrgs();
    await seedDevice(orgA.id, siteA.id);
    const policy = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(policy, 'partner', partner.id);
    const orgPolicy = await seedPolicy({ orgId: orgA.id, partnerId: null });
    await assign(orgPolicy, 'organization', orgA.id);

    // Positive control: the owner sees the policy and its device.
    const own = await reachAs(partnerCtx(partner.id, [orgA.id]), partnerAuth(partner.id, [orgA.id]), [policy, orgPolicy]);
    expect(own.get(policy)).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });
    expect(own.get(orgPolicy)).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });

    // Another partner's context reads neither policy, so neither is counted.
    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    const foreign = await reachAs(partnerCtx(other.id, [otherOrg!.id]), partnerAuth(other.id, [otherOrg!.id]), [policy, orgPolicy]);
    expect(foreign.size).toBe(0);

    // And the batch route's id filter drops them before any count.
    const readable = await withDbAccessContext(partnerCtx(other.id, [otherOrg!.id]), () =>
      readablePolicyIds(partnerAuth(other.id, [otherOrg!.id]), [policy, orgPolicy]));
    expect(readable).toEqual([]);
  });
});

describe('site-restricted caller', () => {
  it('counts only the devices in the caller\'s sites, though RLS admits the whole organization', async () => {
    const { partner, orgA, siteA } = await twoOrgs();
    const siteA2 = await createSite({ orgId: orgA.id, name: 'Acme Branch' });
    await seedDevice(orgA.id, siteA.id);
    await seedDevice(orgA.id, siteA2!.id);
    await seedDevice(orgA.id, siteA2!.id);
    const policy = await seedPolicy({ orgId: orgA.id, partnerId: null });
    await assign(policy, 'organization', orgA.id);

    const ctx = orgCtx(orgA.id, partner.id);
    const full = await reachAs(ctx, orgAuth(orgA.id, partner.id), [policy]);
    expect(full.get(policy)).toEqual({ direct: 3, throughChildren: 0, organizations: 1 });

    const siteOnly = {
      ...orgAuth(orgA.id, partner.id),
      allowedSiteIds: [siteA.id],
      canAccessSite: (id: string | null | undefined) => id === siteA.id,
    } as unknown as AuthContext;
    const limited = await reachAs(ctx, siteOnly, [policy]);
    expect(limited.get(policy)).toEqual({ direct: 1, throughChildren: 0, organizations: 1 });
  });
});

describe('work bound (#12465 round two)', () => {
  it('past the statement budget the count is a lower bound marked partial; under it, exact', async () => {
    const { partner, orgA, siteA } = await twoOrgs();
    const siteA2 = await createSite({ orgId: orgA.id, name: 'Acme Branch' });
    const siteA3 = await createSite({ orgId: orgA.id, name: 'Acme Depot' });
    await seedDevice(orgA.id, siteA.id);
    await seedDevice(orgA.id, siteA2!.id);
    await seedDevice(orgA.id, siteA3!.id);
    const policy = await seedPolicy({ orgId: orgA.id, partnerId: null });
    await assign(policy, 'site', siteA.id);
    await assign(policy, 'site', siteA2!.id);
    await assign(policy, 'site', siteA3!.id);

    const ctx = orgCtx(orgA.id, partner.id);
    const auth = orgAuth(orgA.id, partner.id);
    const exact = await reachAs(ctx, auth, [policy]);
    expect(exact.get(policy)).toEqual({ direct: 3, throughChildren: 0, organizations: 1 });

    // 4 fixed reads + 2 site expansions: the third site row is not expanded.
    const bounded = await withDbAccessContext(ctx, () =>
      computePolicyReach(auth, [policy], { statementBudget: 6, childPolicyLimit: 500 }));
    expect(bounded.get(policy)).toEqual({ direct: 2, throughChildren: 0, organizations: 1, partial: true });
  });

  it('the child cap cuts in Postgres uuid order: only the parent sorting after the cut is partial', async () => {
    const { partner, orgA, siteA } = await twoOrgs();
    const d1 = await seedDevice(orgA.id, siteA.id);
    const d2 = await seedDevice(orgA.id, siteA.id);
    const owner = { orgId: null, partnerId: partner.id };
    const [first, second] = [await seedPolicy(owner), await seedPolicy(owner)].sort();
    await assign(await seedPolicy(owner, first!), 'device', d1);
    await assign(await seedPolicy(owner, second!), 'device', d2);

    const ctx = partnerCtx(partner.id, [orgA.id]);
    const auth = partnerAuth(partner.id, [orgA.id]);
    // A cap of 1 reads two child rows (one past the cap): first's, then second's.
    // If ORDER BY disagreed with the string order, `first` would be flagged too.
    const reach = await withDbAccessContext(ctx, () =>
      computePolicyReach(auth, [first!, second!], { statementBudget: 200, childPolicyLimit: 1 }));
    expect(reach.get(first!)).toEqual({ direct: 0, throughChildren: 1, organizations: 1 });
    expect(reach.get(second!)).toEqual({ direct: 0, throughChildren: 0, organizations: 0, partial: true });
  });
});

describe('readablePolicyIds under forced RLS', () => {
  it('hides a partner-owned policy from an org-scope caller, as the list does', async () => {
    const { partner, orgA } = await twoOrgs();
    const partnerPolicy = await seedPolicy({ orgId: null, partnerId: partner.id });
    const orgPolicy = await seedPolicy({ orgId: orgA.id, partnerId: null });

    const asOrg = await withDbAccessContext(orgCtx(orgA.id, partner.id), () =>
      readablePolicyIds(orgAuth(orgA.id, partner.id), [partnerPolicy, orgPolicy]));
    expect(asOrg).toEqual([orgPolicy]);

    const asPartner = await withDbAccessContext(partnerCtx(partner.id, [orgA.id]), () =>
      readablePolicyIds(partnerAuth(partner.id, [orgA.id]), [partnerPolicy, orgPolicy]));
    expect(asPartner.sort()).toEqual([partnerPolicy, orgPolicy].sort());
  });
});
