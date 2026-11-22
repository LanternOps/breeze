/**
 * Applies-to summary under real forced RLS (#12306, plan W01a A4).
 *
 * `loadAppliesToSummaries` runs every statement on the ambient `db`, so it is
 * only as tenant-safe as the request context it runs in. The unit suite mocks
 * the driver and cannot see RLS at all; this file runs the same function inside
 * `withDbAccessContext` on the unprivileged `breeze_app` connection, where an
 * assignment row is legible only through its policy and a target name only
 * through the caller's own org/partner axis.
 *
 * The cross-partner case is the control: under a BYPASSRLS connection it would
 * return the other partner's rows and fail.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  deviceGroups,
} from '../../db/schema';
import { loadAppliesToSummaries } from '../../services/configPolicyAppliesTo';
import { loadPolicyOwners } from '../../routes/configurationPolicies/resolution';
import type { EffectiveConfiguration } from '../../services/configurationPolicy';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgDbContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

function partnerDbContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null };
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
      // Children first: parent_policy_id is a plain FK.
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.parentPolicyId, createdPolicies));
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, createdPolicies));
    }
    if (createdGroups.length > 0) {
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
        name: `applies-to ${randomUUID().slice(0, 8)}`,
        status: 'active',
        parentPolicyId,
      })
      .returning();
    createdPolicies.push(policy!.id);
    return policy!.id;
  });
}

async function seedGroup(orgId: string, name: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [group] = await db.insert(deviceGroups).values({ orgId, name }).returning();
    createdGroups.push(group!.id);
    return group!.id;
  });
}

async function assign(
  configPolicyId: string,
  level: 'partner' | 'organization' | 'site' | 'device_group' | 'device',
  targetId: string,
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = await db
      .insert(configPolicyAssignments)
      .values({ configPolicyId, level, targetId, priority: 0 })
      .returning();
    return row!.id;
  });
}

describe('loadAppliesToSummaries under forced RLS', () => {
  it('a partner-scope context names targets in two of its organizations', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme' });
    const orgB = await createOrganization({ partnerId: partner.id, name: 'Birch' });
    const policyId = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(policyId, 'organization', orgA!.id);
    await assign(policyId, 'organization', orgB!.id);

    const orgIds = [orgA!.id, orgB!.id];
    const summary = await withDbAccessContext(partnerDbContext(partner.id, orgIds), async () =>
      (await loadAppliesToSummaries(partnerAuth(partner.id, orgIds), [policyId])).get(policyId));

    expect(summary).toBeDefined();
    expect(summary!.assignmentCount).toBe(2);
    expect(summary!.allOrganizations).toBe(false);
    expect(summary!.targets.map((t) => [t.level, t.name]).sort()).toEqual([
      ['organization', orgA!.name],
      ['organization', orgB!.name],
    ].sort());
  });

  it('counts a row whose target the caller cannot name, but leaves it out of targets', async () => {
    // A partner user with access to only one of the two organizations: the
    // partner-owned policy and both of its rows are legible, but the other
    // organization's name is not (D2).
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme' });
    const orgB = await createOrganization({ partnerId: partner.id, name: 'Birch' });
    const policyId = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(policyId, 'organization', orgA!.id);
    await assign(policyId, 'organization', orgB!.id);

    const summary = await withDbAccessContext(partnerDbContext(partner.id, [orgA!.id]), async () =>
      (await loadAppliesToSummaries(partnerAuth(partner.id, [orgA!.id]), [policyId])).get(policyId));

    expect(summary!.assignmentCount).toBe(2);
    expect(summary!.targets.map((t) => t.targetId)).toEqual([orgA!.id]);
  });

  it('an org-scope context names the site and device group targets of its own policy', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id, name: 'Main office' });
    const groupId = await seedGroup(org!.id, 'Laptops');
    const policyId = await seedPolicy({ orgId: org!.id, partnerId: null });
    await assign(policyId, 'device_group', groupId);
    await assign(policyId, 'site', site!.id);

    const summary = await withDbAccessContext(orgDbContext(org!.id), async () =>
      (await loadAppliesToSummaries(orgAuth(org!.id, partner.id), [policyId])).get(policyId));

    expect(summary!.assignmentCount).toBe(2);
    // Site before device group, whatever order the rows were written in.
    expect(summary!.targets.map((t) => [t.level, t.name])).toEqual([
      ['site', site!.name],
      ['device_group', 'Laptops'],
    ]);
  });

  it('a parent with an assigned child reports childPolicyCount 1 and assignmentCount 0', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const parentId = await seedPolicy({ orgId: org!.id, partnerId: null });
    const childId = await seedPolicy({ orgId: org!.id, partnerId: null }, parentId);
    await assign(childId, 'site', site!.id);

    const summaries = await withDbAccessContext(orgDbContext(org!.id), () =>
      loadAppliesToSummaries(orgAuth(org!.id, partner.id), [parentId, childId]));

    expect(summaries.get(parentId)).toMatchObject({ assignmentCount: 0, childPolicyCount: 1, targets: [] });
    expect(summaries.get(childId)).toMatchObject({ assignmentCount: 1, childPolicyCount: 0 });
  });

  it("the summary query runs in the caller's context", async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const policyId = await seedPolicy({ orgId: null, partnerId: partner.id });
    await assign(policyId, 'partner', partner.id);
    await assign(policyId, 'organization', org!.id);
    await seedPolicy({ orgId: org!.id, partnerId: null }, policyId);
    await assign(policyId, 'site', site!.id);

    // Positive control: the owning partner sees all of it, so the zeros below
    // are RLS at work and not an empty fixture.
    const own = await withDbAccessContext(partnerDbContext(partner.id, [org!.id]), async () =>
      (await loadAppliesToSummaries(partnerAuth(partner.id, [org!.id]), [policyId])).get(policyId));
    expect(own).toMatchObject({ assignmentCount: 3, allOrganizations: true, childPolicyCount: 1 });

    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    const foreign = await withDbAccessContext(partnerDbContext(other.id, [otherOrg!.id]), async () =>
      (await loadAppliesToSummaries(partnerAuth(other.id, [otherOrg!.id]), [policyId])).get(policyId));

    expect(foreign).toEqual({ assignmentCount: 0, allOrganizations: false, targets: [], childPolicyCount: 0 });
  });
});

describe('childPolicyCount under forced RLS', () => {
  it('counts only the children the caller can see', async () => {
    // A partner-owned parent with one child in each of two organizations. A
    // partner user limited to one organization sees one child.
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme' });
    const orgB = await createOrganization({ partnerId: partner.id, name: 'Birch' });
    const parentId = await seedPolicy({ orgId: null, partnerId: partner.id });
    await seedPolicy({ orgId: orgA!.id, partnerId: null }, parentId);
    await seedPolicy({ orgId: orgB!.id, partnerId: null }, parentId);

    const limited = await withDbAccessContext(partnerDbContext(partner.id, [orgA!.id]), async () =>
      (await loadAppliesToSummaries(partnerAuth(partner.id, [orgA!.id]), [parentId])).get(parentId));
    expect(limited!.childPolicyCount).toBe(1);

    const both = [orgA!.id, orgB!.id];
    const full = await withDbAccessContext(partnerDbContext(partner.id, both), async () =>
      (await loadAppliesToSummaries(partnerAuth(partner.id, both), [parentId])).get(parentId));
    expect(full!.childPolicyCount).toBe(2);
  });
});

describe('loadPolicyOwners under forced RLS', () => {
  function effective(policyIds: string[]): EffectiveConfiguration {
    return {
      deviceId: randomUUID(),
      features: {},
      inheritanceChain: [
        ...policyIds.map((policyId) => ({
          level: 'organization' as const,
          targetId: randomUUID(),
          policyId,
          policyName: 'P',
          priority: 0,
          featureTypes: [],
        })),
        // The synthesized defaults layer must never reach the uuid IN list.
        { level: 'default' as const, targetId: 'breeze-defaults', policyId: 'breeze-defaults', policyName: 'Breeze Defaults', priority: 0, featureTypes: [] },
      ],
    };
  }

  it('names owners for a partner caller, its own partner policies for an org caller, nothing for another tenant', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const orgPolicy = await seedPolicy({ orgId: org!.id, partnerId: null });
    const partnerPolicy = await seedPolicy({ orgId: null, partnerId: partner.id });
    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    const foreignPolicy = await seedPolicy({ orgId: null, partnerId: other.id });
    const ids = [orgPolicy, partnerPolicy, foreignPolicy];

    const asPartner = await withDbAccessContext(
      buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [org!.id], partnerId: partner.id, userId: null }),
      () => loadPolicyOwners(effective(ids)),
    );
    expect(asPartner).toEqual({ [orgPolicy]: 'organization', [partnerPolicy]: 'partner' });

    // A real org request context carries its partner as currentPartnerId, which
    // the SELECT-only partner-wide policy reads: the MSP policy is legible and
    // named 'partner' (the web shows "Managed by your MSP" without a link).
    const asOrg = await withDbAccessContext(
      buildDbAccessContext({ scope: 'organization', orgId: org!.id, accessibleOrgIds: [org!.id], partnerId: partner.id, userId: null }),
      () => loadPolicyOwners(effective(ids)),
    );
    expect(asOrg).toEqual({ [orgPolicy]: 'organization', [partnerPolicy]: 'partner' });

    const asOtherOrg = await withDbAccessContext(
      buildDbAccessContext({ scope: 'organization', orgId: otherOrg!.id, accessibleOrgIds: [otherOrg!.id], partnerId: other.id, userId: null }),
      () => loadPolicyOwners(effective([orgPolicy, partnerPolicy])),
    );
    expect(asOtherOrg).toEqual({});
  });
});
