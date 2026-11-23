/**
 * Organization erasure vs. configuration-policy assignments that target rows
 * INSIDE the org being erased, against real Postgres.
 *
 * `config_policy_assignments` has no `org_id` (it is keyed by a polymorphic
 * level/target_id pair), so the org cascade list never reaches it directly. An
 * org-owned policy's assignments go with the policy (`config_policy_id` is ON
 * DELETE CASCADE), but a PARTNER-owned policy outlives the org. Its assignments
 * that target one of the org's devices, sites or device groups, or the org
 * itself, must be cleared before those targets are deleted: the owner-delete
 * statement trigger (`ab_config_policy_assignment_*_owner_delete`) re-validates
 * every surviving assignment that names a deleted target and raises
 * `config_policy_assignments_target_owner_fk` when the target is gone.
 *
 * Mocked unit tests cannot see this: the failure is a database trigger.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyAssignments,
  deviceGroups,
  organizations,
} from '../../db/schema';
import { cascadeDeleteOrg, cascadeDeletePartner } from '../../services/tenantCascade';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

type Level = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

interface Fixture {
  partnerId: string;
  orgId: string;
  otherOrgId: string;
  siteId: string;
  otherSiteId: string;
  groupId: string;
  otherGroupId: string;
  /** A partner-owned group (org_id NULL): not inside the erased org. */
  partnerGroupId: string;
  deviceId: string;
  otherDeviceId: string;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const otherSite = await createSite({ orgId: otherOrg.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  const otherDevice = await createDevice({ orgId: otherOrg.id, siteId: otherSite.id });
  const [group, otherGroup, partnerGroup] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(deviceGroups).values([
      { orgId: org.id, name: 'Erasure group', type: 'static' },
      { orgId: otherOrg.id, name: 'Other org group', type: 'static' },
      { orgId: null, partnerId: partner.id, name: 'Partner group', type: 'static' },
    ]).returning());
  return {
    partnerId: partner.id,
    orgId: org.id,
    otherOrgId: otherOrg.id,
    siteId: site.id,
    otherSiteId: otherSite.id,
    groupId: group!.id,
    otherGroupId: otherGroup!.id,
    partnerGroupId: partnerGroup!.id,
    deviceId: device.id,
    otherDeviceId: otherDevice.id,
  };
}

async function seedPolicy(owner: { orgId?: string; partnerId?: string }, name: string): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(configurationPolicies)
      .values({ orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null, name })
      .returning({ id: configurationPolicies.id }));
  return row!.id;
}

async function assign(configPolicyId: string, level: Level, targetId: string): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(configPolicyAssignments)
      .values({ configPolicyId, level, targetId })
      .returning({ id: configPolicyAssignments.id }));
  return row!.id;
}

async function assignmentIds(ids: string[]): Promise<string[]> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: configPolicyAssignments.id }).from(configPolicyAssignments)
      .where(inArray(configPolicyAssignments.id, ids)));
  return rows.map((r) => r.id).sort();
}

async function orgExists(orgId: string): Promise<boolean> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)));
  return rows.length > 0;
}

async function policyExists(policyId: string): Promise<boolean> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: configurationPolicies.id }).from(configurationPolicies)
      .where(eq(configurationPolicies.id, policyId)));
  return rows.length > 0;
}

function erase(orgId: string) {
  return cascadeDeleteOrg(orgId, randomUUID(), 'org-erasure-assignments@test.invalid');
}

describe('org erasure clears config-policy assignments that target the erased org (live DB)', () => {
  it('(a) device-level assignment of a PARTNER-owned policy', async () => {
    const f = await seedFixture();
    const policy = await seedPolicy({ partnerId: f.partnerId }, 'MSP device baseline');
    const doomed = await assign(policy, 'device', f.deviceId);
    const survivor = await assign(policy, 'device', f.otherDeviceId);

    await expect(erase(f.orgId)).resolves.toBeDefined();

    expect(await orgExists(f.orgId)).toBe(false);
    expect(await policyExists(policy)).toBe(true);
    expect(await assignmentIds([doomed, survivor])).toEqual([survivor]);
  });

  it('(b) device-level assignment of an ORG-owned policy', async () => {
    const f = await seedFixture();
    const policy = await seedPolicy({ orgId: f.orgId }, 'Org device policy');
    const doomed = await assign(policy, 'device', f.deviceId);

    await expect(erase(f.orgId)).resolves.toBeDefined();

    expect(await orgExists(f.orgId)).toBe(false);
    expect(await policyExists(policy)).toBe(false);
    expect(await assignmentIds([doomed])).toEqual([]);
  });

  it('(c) site-level assignment of a PARTNER-owned policy', async () => {
    const f = await seedFixture();
    const policy = await seedPolicy({ partnerId: f.partnerId }, 'MSP site baseline');
    const doomed = await assign(policy, 'site', f.siteId);
    const survivor = await assign(policy, 'site', f.otherSiteId);

    await expect(erase(f.orgId)).resolves.toBeDefined();

    expect(await orgExists(f.orgId)).toBe(false);
    expect(await policyExists(policy)).toBe(true);
    expect(await assignmentIds([doomed, survivor])).toEqual([survivor]);
  });

  it('(d) device_group-level assignment of a PARTNER-owned policy', async () => {
    const f = await seedFixture();
    const policy = await seedPolicy({ partnerId: f.partnerId }, 'MSP group baseline');
    const doomed = await assign(policy, 'device_group', f.groupId);
    const otherOrgGroup = await assign(policy, 'device_group', f.otherGroupId);
    const partnerGroup = await assign(policy, 'device_group', f.partnerGroupId);

    await expect(erase(f.orgId)).resolves.toBeDefined();

    expect(await orgExists(f.orgId)).toBe(false);
    expect(await policyExists(policy)).toBe(true);
    expect(await assignmentIds([doomed, otherOrgGroup, partnerGroup]))
      .toEqual([otherOrgGroup, partnerGroup].sort());
  });

  it('(e) organization-level assignment of a PARTNER-owned policy; partner-level survives', async () => {
    const f = await seedFixture();
    const policy = await seedPolicy({ partnerId: f.partnerId }, 'MSP org baseline');
    const doomed = await assign(policy, 'organization', f.orgId);
    const survivor = await assign(policy, 'organization', f.otherOrgId);
    const partnerLevel = await assign(policy, 'partner', f.partnerId);

    await expect(erase(f.orgId)).resolves.toBeDefined();

    expect(await orgExists(f.orgId)).toBe(false);
    expect(await policyExists(policy)).toBe(true);
    expect(await assignmentIds([doomed, survivor, partnerLevel]))
      .toEqual([survivor, partnerLevel].sort());
  });

  it('(f) every level at once, partner-owned and org-owned policies together', async () => {
    const f = await seedFixture();
    const partnerPolicy = await seedPolicy({ partnerId: f.partnerId }, 'MSP baseline');
    const orgPolicy = await seedPolicy({ orgId: f.orgId }, 'Org policy');
    const doomed = [
      await assign(partnerPolicy, 'organization', f.orgId),
      await assign(partnerPolicy, 'site', f.siteId),
      await assign(partnerPolicy, 'device_group', f.groupId),
      await assign(partnerPolicy, 'device', f.deviceId),
      await assign(orgPolicy, 'organization', f.orgId),
      await assign(orgPolicy, 'device', f.deviceId),
    ];

    await expect(erase(f.orgId)).resolves.toBeDefined();

    expect(await orgExists(f.orgId)).toBe(false);
    expect(await policyExists(partnerPolicy)).toBe(true);
    expect(await assignmentIds(doomed)).toEqual([]);
  });

  it('(g) the partner purge erases a child org carrying partner-policy assignments', async () => {
    const f = await seedFixture();
    const policy = await seedPolicy({ partnerId: f.partnerId }, 'MSP baseline');
    await assign(policy, 'organization', f.orgId);
    await assign(policy, 'device', f.deviceId);
    await assign(policy, 'site', f.otherSiteId);

    await expect(cascadeDeletePartner(f.partnerId, randomUUID())).resolves.toBeDefined();

    expect(await orgExists(f.orgId)).toBe(false);
    expect(await orgExists(f.otherOrgId)).toBe(false);
    expect(await policyExists(policy)).toBe(false);
  });
});
