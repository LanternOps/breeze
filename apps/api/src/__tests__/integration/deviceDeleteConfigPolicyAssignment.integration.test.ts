/**
 * Real-Postgres coverage for the device hard-delete cascade against a
 * DEVICE-level configuration policy assignment (#12293).
 *
 * THE DEFECT: permanently deleting a device that a configuration policy was
 * assigned to directly (`config_policy_assignments.level = 'device'`) returned
 * 409 "Cannot delete: device still has related records". The assignment's
 * target is polymorphic (`level` + `target_id`, no FK), so nothing removed it,
 * and the `ab_config_policy_assignment_device_owner_delete` statement trigger
 * on `devices` found the assignment pointing at a missing device and raised
 * 23503 `config_policy_assignments_target_owner_fk`.
 *
 * Why a real database is required: that trigger exists only in SQL. The mocked
 * suites resolve every statement, so only this suite proves Postgres accepts
 * the cascade.
 *
 * Coverage:
 *   1. The control: deleting the device row while its device-level assignment
 *      still exists really is refused with that constraint. Without it the
 *      regression test could pass on a database missing the trigger.
 *   2. The regression: the cascade deletes the device and its own device-level
 *      assignment, and leaves every other assignment of the same policy alone
 *      (another device's, the site's and the organization's).
 *   3. The route and bulk-purge path (`purgeRemovedDevice`) with the shapes
 *      that take partner-export locks: a partner-owned policy and an org-owned
 *      policy both assigned to the device, and a group membership deleted
 *      earlier in the same cascade. The group's own assignment survives.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  groupMembershipLog,
  sites,
} from '../../db/schema';
import {
  deleteDeviceCascade,
  type DeviceDeletionTx,
} from '../../services/deviceDeletion';
import { purgeRemovedDevice } from '../../services/deviceLifecycle';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createSite } from './db-utils';

/** Postgres foreign_key_violation, raised by the owner trigger. */
const FOREIGN_KEY_VIOLATION = '23503';

const createdOrgs: string[] = [];
const createdPolicies: string[] = [];

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

afterEach(async () => {
  if (createdOrgs.length === 0) return;
  await asSystem(async () => {
    if (createdPolicies.length > 0) {
      await db.delete(configPolicyAssignments)
        .where(inArray(configPolicyAssignments.configPolicyId, createdPolicies));
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, createdPolicies));
    }
    for (const orgId of createdOrgs) {
      await db.delete(groupMembershipLog).where(eq(groupMembershipLog.orgId, orgId));
      await db.delete(deviceGroupMemberships).where(eq(deviceGroupMemberships.orgId, orgId));
      await db.delete(deviceGroups).where(eq(deviceGroups.orgId, orgId));
      await db.delete(devices).where(eq(devices.orgId, orgId));
      await db.delete(sites).where(eq(sites.orgId, orgId));
    }
  });
  createdOrgs.length = 0;
  createdPolicies.length = 0;
});

async function seedTenant(): Promise<{ partnerId: string; orgId: string; siteId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  createdOrgs.push(org.id);
  const site = await createSite({ orgId: org.id });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id };
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  return asSystem(async () => {
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'decommissioned',
      })
      .returning({ id: devices.id });
    return row!.id;
  });
}

/** An org-owned policy, or a partner-owned one (org_id NULL) with `{ partnerId }`. */
async function seedPolicy(owner: string | { partnerId: string }): Promise<string> {
  const ownerColumns = typeof owner === 'string' ? { orgId: owner } : { partnerId: owner.partnerId };
  return asSystem(async () => {
    const [row] = await db
      .insert(configurationPolicies)
      .values({ ...ownerColumns, name: `device delete policy ${randomUUID()}`, status: 'active' })
      .returning({ id: configurationPolicies.id });
    createdPolicies.push(row!.id);
    return row!.id;
  });
}

/** An org-owned static group with `deviceId` as its one member. */
async function seedGroupWithMember(orgId: string, deviceId: string): Promise<string> {
  return asSystem(async () => {
    const [group] = await db
      .insert(deviceGroups)
      .values({ orgId, name: `device delete group ${randomUUID()}` })
      .returning({ id: deviceGroups.id });
    await db.insert(deviceGroupMemberships).values({ deviceId, groupId: group!.id, orgId });
    return group!.id;
  });
}

async function assign(
  configPolicyId: string,
  level: 'organization' | 'site' | 'device_group' | 'device',
  targetId: string,
): Promise<string> {
  return asSystem(async () => {
    const [row] = await db
      .insert(configPolicyAssignments)
      .values({ configPolicyId, level, targetId })
      .returning({ id: configPolicyAssignments.id });
    return row!.id;
  });
}

function assignmentIdsOf(policyId: string): Promise<string[]> {
  return asSystem(async () => (await db
    .select({ id: configPolicyAssignments.id })
    .from(configPolicyAssignments)
    .where(eq(configPolicyAssignments.configPolicyId, policyId))).map((row) => row.id));
}

function runCascade(deviceId: string): Promise<void> {
  return asSystem(() =>
    db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, deviceId);
    }),
  );
}

describe('device hard-delete vs device-level config policy assignment (#12293)', () => {
  it('CONTROL: deleting a device row its device-level assignment still names is refused', async () => {
    const { orgId, siteId } = await seedTenant();
    const deviceId = await seedDevice(orgId, siteId);
    const policyId = await seedPolicy(orgId);
    await assign(policyId, 'device', deviceId);

    // Catch outside asSystem: the context helper runs the callback in a
    // transaction, and the trigger error resurfaces when it ends.
    let err: unknown = null;
    try {
      await asSystem(() => db.delete(devices).where(eq(devices.id, deviceId)));
    } catch (e: unknown) {
      err = e;
    }

    expect(err, 'the device owner-delete trigger is missing from this database').not.toBeNull();
    expect(pgErrorCode(err)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('deletes the device and its own device-level assignment, keeping every other assignment', async () => {
    const { orgId, siteId } = await seedTenant();
    const deviceId = await seedDevice(orgId, siteId);
    const otherDeviceId = await seedDevice(orgId, siteId);
    const policyId = await seedPolicy(orgId);

    const ownAssignment = await assign(policyId, 'device', deviceId);
    const otherDeviceAssignment = await assign(policyId, 'device', otherDeviceId);
    const siteAssignment = await assign(policyId, 'site', siteId);
    const orgAssignment = await assign(policyId, 'organization', orgId);

    // Before the fix this rejected with 23503 from the owner trigger, which
    // the permanent-delete route reports as the 409.
    await expect(runCascade(deviceId)).resolves.toBeUndefined();

    const device = await asSystem(async () => {
      const [row] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
      return row ?? null;
    });
    expect(device, 'the device row must actually be gone').toBeNull();

    const remaining = await assignmentIdsOf(policyId);
    expect(remaining).not.toContain(ownAssignment);
    expect(remaining.sort()).toEqual(
      [otherDeviceAssignment, siteAssignment, orgAssignment].sort(),
    );

    const otherDevice = await asSystem(async () => {
      const [row] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.id, otherDeviceId), eq(devices.orgId, orgId)));
      return row ?? null;
    });
    expect(otherDevice).not.toBeNull();
  });

  it('purgeRemovedDevice deletes a grouped device assigned both a partner-owned and an org-owned policy', async () => {
    const { partnerId, orgId, siteId } = await seedTenant();
    const deviceId = await seedDevice(orgId, siteId);
    const groupId = await seedGroupWithMember(orgId, deviceId);
    const partnerPolicyId = await seedPolicy({ partnerId });
    const orgPolicyId = await seedPolicy(orgId);

    await assign(partnerPolicyId, 'device', deviceId);
    await assign(orgPolicyId, 'device', deviceId);
    const groupAssignment = await assign(orgPolicyId, 'device_group', groupId);

    // force: the seeded device has no confirmed uninstall, which is the
    // operator's "delete anyway" on the single-device route.
    await expect(asSystem(() =>
      db.transaction(async (tx) => {
        await purgeRemovedDevice(tx as never, deviceId, undefined, { force: true });
      }),
    )).resolves.toBeUndefined();

    const device = await asSystem(async () => {
      const [row] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
      return row ?? null;
    });
    expect(device, 'the device row must actually be gone').toBeNull();
    expect(await assignmentIdsOf(partnerPolicyId)).toEqual([]);
    expect(await assignmentIdsOf(orgPolicyId)).toEqual([groupAssignment]);
  });
});
