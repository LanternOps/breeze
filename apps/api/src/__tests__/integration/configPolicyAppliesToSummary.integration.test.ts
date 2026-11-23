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
  deviceGroupMemberships,
  deviceGroups,
} from '../../db/schema';
import { loadAppliesToSummaries } from '../../services/configPolicyAppliesTo';
import {
  assignmentTargetKey,
  authorizeAssignmentTarget,
  authorizeAssignmentTargets,
} from '../../services/configurationPolicy';
import { loadPolicyOwners } from '../../routes/configurationPolicies/resolution';
import type { EffectiveConfiguration } from '../../services/configurationPolicy';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

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

/** An org user limited to `siteIds`, optionally also to exact devices. */
function restrictedOrgAuth(orgId: string, partnerId: string, siteIds: string[], deviceIds?: string[]): AuthContext {
  return {
    ...orgAuth(orgId, partnerId),
    allowedSiteIds: siteIds,
    canAccessSite: (siteId: string | null | undefined) => !!siteId && siteIds.includes(siteId),
    ...(deviceIds ? { allowedDeviceIds: deviceIds } : {}),
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
        name: `applies-to ${randomUUID().slice(0, 8)}`,
        status: 'active',
        parentPolicyId,
      })
      .returning();
    createdPolicies.push(policy!.id);
    return policy!.id;
  });
}

async function seedGroup(orgId: string, name: string, siteId: string | null = null) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [group] = await db.insert(deviceGroups).values({ orgId, name, siteId }).returning();
    createdGroups.push(group!.id);
    return group!.id;
  });
}

async function addMembers(groupId: string, orgId: string, deviceIds: string[]) {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(deviceGroupMemberships).values(deviceIds.map((deviceId) => ({ groupId, orgId, deviceId })));
  });
}

async function assign(
  configPolicyId: string,
  level: 'partner' | 'organization' | 'site' | 'device_group' | 'device',
  targetId: string,
  priority = 0,
) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = await db
      .insert(configPolicyAssignments)
      .values({ configPolicyId, level, targetId, priority })
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

describe('display order and window under real SQL (Strix, PR #12512)', () => {
  it('orders targets by level, then priority, then age, whatever order they were written in', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, name: 'Acme' });
    const site = await createSite({ orgId: org!.id, name: 'Main office' });
    const late = await createDevice({ orgId: org!.id, siteId: site!.id, hostname: 'late' });
    const early = await createDevice({ orgId: org!.id, siteId: site!.id, hostname: 'early' });
    const first = await createDevice({ orgId: org!.id, siteId: site!.id, hostname: 'first' });
    const policyId = await seedPolicy({ orgId: org!.id, partnerId: null });
    // Written device-first; within devices, priority beats age ('late' is
    // written before 'early', so it is older).
    await assign(policyId, 'device', late.id, 5);
    await assign(policyId, 'device', early.id, 5);
    await assign(policyId, 'device', first.id, 1);
    const ctx = orgDbContext(org!.id);
    const auth = orgAuth(org!.id, partner.id);

    const devicesOnly = await withDbAccessContext(ctx, async () =>
      (await loadAppliesToSummaries(auth, [policyId])).get(policyId));
    expect(devicesOnly!.targets.map((t) => t.name)).toEqual(['first', 'late', 'early']);

    // A later organization row outranks every device row.
    await assign(policyId, 'organization', org!.id, 9);
    const withOrg = await withDbAccessContext(ctx, async () =>
      (await loadAppliesToSummaries(auth, [policyId])).get(policyId));
    expect(withOrg!.assignmentCount).toBe(4);
    expect(withOrg!.targets.map((t) => t.name)).toEqual(['Acme', 'first', 'late']);
  });

  it('reads at most 50 rows per policy but counts them all', async () => {
    // A site-restricted caller: the 50 leading rows (priority 0) target a
    // device outside their sites, the trailing ones a device inside. The window
    // never reaches the listable rows, so targets stay empty while the count
    // covers every row.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const allowedSite = await createSite({ orgId: org!.id, name: 'Allowed' });
    const otherSite = await createSite({ orgId: org!.id, name: 'Other' });
    const hidden: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      hidden.push((await createDevice({ orgId: org!.id, siteId: otherSite!.id })).id);
    }
    const visible: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      visible.push((await createDevice({ orgId: org!.id, siteId: allowedSite!.id, hostname: `visible-${i}` })).id);
    }
    const policyId = await seedPolicy({ orgId: org!.id, partnerId: null });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.insert(configPolicyAssignments).values([
        ...hidden.map((targetId) => ({ configPolicyId: policyId, level: 'device' as const, targetId, priority: 0 })),
        ...visible.map((targetId, i) => ({ configPolicyId: policyId, level: 'device' as const, targetId, priority: 1 + i })),
      ]);
    });
    const ctx = orgDbContext(org!.id);
    const limited = restrictedOrgAuth(org!.id, partner.id, [allowedSite!.id]);

    const summary = await withDbAccessContext(ctx, async () =>
      (await loadAppliesToSummaries(limited, [policyId])).get(policyId));
    expect(summary!.assignmentCount).toBe(55);
    expect(summary!.targets).toEqual([]);

    // Control: drop one leading row and the 50-row window reaches a listable row.
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.delete(configPolicyAssignments).where(eq(configPolicyAssignments.targetId, hidden[0]!));
    });
    const after = await withDbAccessContext(ctx, async () =>
      (await loadAppliesToSummaries(limited, [policyId])).get(policyId));
    expect(after!.assignmentCount).toBe(54);
    expect(after!.targets.map((t) => t.name)).toEqual(['visible-0']);
  });
});

describe('site-restricted caller under forced RLS (Strix, PR #12512)', () => {
  async function fixture() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, name: 'Acme' });
    const sibling = await createOrganization({ partnerId: partner.id, name: 'Sibling Co' });
    const siteA = await createSite({ orgId: org!.id, name: 'Site A' });
    const siteB = await createSite({ orgId: org!.id, name: 'Site B' });
    const siblingSite = await createSite({ orgId: sibling!.id, name: 'Sibling site' });
    const devA = await createDevice({ orgId: org!.id, siteId: siteA!.id, hostname: 'dev-a' });
    const devA2 = await createDevice({ orgId: org!.id, siteId: siteA!.id, hostname: 'dev-a2' });
    const devB = await createDevice({ orgId: org!.id, siteId: siteB!.id, hostname: 'dev-b' });
    const devS = await createDevice({ orgId: sibling!.id, siteId: siblingSite!.id, hostname: 'sibling-device' });
    const groupA = await seedGroup(org!.id, 'Group A', siteA!.id);
    const groupMixed = await seedGroup(org!.id, 'Group mixed', siteA!.id);
    const groupEmpty = await seedGroup(org!.id, 'Group empty', siteA!.id);
    const groupB = await seedGroup(org!.id, 'Group B', siteB!.id);
    const groupOrgWide = await seedGroup(org!.id, 'Group org-wide', null);
    const groupS = await seedGroup(sibling!.id, 'Sibling group', siblingSite!.id);
    await addMembers(groupA, org!.id, [devA.id]);
    await addMembers(groupMixed, org!.id, [devA.id, devA2.id]);
    await addMembers(groupB, org!.id, [devB.id]);
    await addMembers(groupS, sibling!.id, [devS.id]);
    return {
      partner, org: org!, sibling: sibling!, siteA: siteA!, siteB: siteB!, siblingSite: siblingSite!,
      devA, devA2, devB, devS, groupA, groupMixed, groupEmpty, groupB, groupOrgWide, groupS,
    };
  }

  it("never shows a sibling org's or another site's target, and still counts it", async () => {
    const f = await fixture();
    // Partner-owned, so it may target the sibling org (the owner trigger
    // refuses that on an org policy); an org request context reads it through
    // the SELECT-only partner-wide policy.
    const policyId = await seedPolicy({ orgId: null, partnerId: f.partner.id });
    // Refused rows lead in display order, so they would take the slots if
    // authorization were skipped.
    await assign(policyId, 'organization', f.org.id);
    await assign(policyId, 'site', f.siteB.id);
    await assign(policyId, 'site', f.siblingSite.id);
    await assign(policyId, 'device_group', f.groupB);
    await assign(policyId, 'device_group', f.groupS);
    await assign(policyId, 'device_group', f.groupOrgWide);
    await assign(policyId, 'device', f.devB.id);
    await assign(policyId, 'device', f.devS.id);
    await assign(policyId, 'device_group', f.groupA, 5);
    await assign(policyId, 'device', f.devA.id, 5);

    const limited = restrictedOrgAuth(f.org.id, f.partner.id, [f.siteA.id]);
    const orgRequestCtx = buildDbAccessContext({
      scope: 'organization', orgId: f.org.id, accessibleOrgIds: [f.org.id], partnerId: f.partner.id, userId: null,
    });
    const summary = await withDbAccessContext(orgRequestCtx, async () =>
      (await loadAppliesToSummaries(limited, [policyId])).get(policyId));

    expect(summary!.assignmentCount).toBe(10);
    expect(summary!.targets.map((t) => [t.level, t.name])).toEqual([
      ['device_group', 'Group A'],
      ['device', 'dev-a'],
    ]);
    const shown = JSON.stringify(summary);
    for (const hiddenId of [f.sibling.id, f.siblingSite.id, f.groupS, f.devS.id, f.siteB.id, f.groupB, f.devB.id]) {
      expect(shown).not.toContain(hiddenId);
    }
    expect(shown).not.toContain('Sibling');
  });

  it('the batch authorizer agrees with the single-target one on real rows', async () => {
    const f = await fixture();
    const targets = [
      { level: 'partner' as const, targetId: f.partner.id },
      { level: 'organization' as const, targetId: f.org.id },
      { level: 'site' as const, targetId: f.siteA.id },
      { level: 'site' as const, targetId: f.siteB.id },
      { level: 'site' as const, targetId: f.siblingSite.id },
      { level: 'device_group' as const, targetId: f.groupA },
      { level: 'device_group' as const, targetId: f.groupMixed },
      { level: 'device_group' as const, targetId: f.groupEmpty },
      { level: 'device_group' as const, targetId: f.groupB },
      { level: 'device_group' as const, targetId: f.groupOrgWide },
      { level: 'device_group' as const, targetId: f.groupS },
      { level: 'device_group' as const, targetId: randomUUID() },
      { level: 'device' as const, targetId: f.devA.id },
      { level: 'device' as const, targetId: f.devA2.id },
      { level: 'device' as const, targetId: f.devB.id },
      { level: 'device' as const, targetId: f.devS.id },
      { level: 'device' as const, targetId: randomUUID() },
    ];
    const callers: Array<[string, AuthContext]> = [
      ['unrestricted', orgAuth(f.org.id, f.partner.id)],
      ['site-restricted', restrictedOrgAuth(f.org.id, f.partner.id, [f.siteA.id])],
      ['site+device-restricted', restrictedOrgAuth(f.org.id, f.partner.id, [f.siteA.id], [f.devA.id])],
      ['device-restricted, no site list', { ...orgAuth(f.org.id, f.partner.id), allowedDeviceIds: [f.devA.id] } as unknown as AuthContext],
      ['empty device list', restrictedOrgAuth(f.org.id, f.partner.id, [f.siteA.id], [])],
    ];

    for (const [label, caller] of callers) {
      const { batch, single } = await withDbAccessContext(orgDbContext(f.org.id), async () => {
        const batchResult = await authorizeAssignmentTargets(caller, targets);
        const singleResult = new Map<string, boolean>();
        for (const t of targets) {
          singleResult.set(
            assignmentTargetKey(t.level, t.targetId),
            (await authorizeAssignmentTarget(caller, t.level, t.targetId)).valid,
          );
        }
        return { batch: batchResult, single: singleResult };
      });
      expect(Object.fromEntries(batch), label).toEqual(Object.fromEntries(single));
    }

    // The fixture must exercise both outcomes on the restricted group path.
    const deviceScoped = await withDbAccessContext(orgDbContext(f.org.id), () =>
      authorizeAssignmentTargets(restrictedOrgAuth(f.org.id, f.partner.id, [f.siteA.id], [f.devA.id]), targets));
    expect(deviceScoped.get(assignmentTargetKey('device_group', f.groupA))).toBe(true);
    expect(deviceScoped.get(assignmentTargetKey('device_group', f.groupMixed))).toBe(false);
    expect(deviceScoped.get(assignmentTargetKey('device_group', f.groupEmpty))).toBe(false);
    expect(deviceScoped.get(assignmentTargetKey('device', f.devA.id))).toBe(true);
  });
});
