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
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { getTestDb } from './setup';
import {
  configurationPolicies,
  configPolicyAssignments,
  deviceGroups,
  organizations,
} from '../../db/schema';
import {
  __tenantCascadeTestHooks,
  cascadeDeleteOrg,
  cascadeDeletePartner,
  TenantCascadeRefusalError,
  topologicalCascadeOrder,
} from '../../services/tenantCascade';
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

/**
 * The assignments are the input of the configuration-policy legal-hold check
 * (erasureBackupLegalHold.ts → resolveBackupProtectionForDevice). That check
 * runs at entry AND again inside the walk's `backup_snapshots` step, so the
 * assignments must still be there, untouched, when it does. They may only go
 * with their own target row, in that row's walk transaction, which is after
 * `backup_snapshots`.
 */
describe('org erasure keeps policy assignments until every legal-hold check has run (live DB)', () => {
  async function exec<T = Record<string, unknown>>(statement: ReturnType<typeof sql>): Promise<T[]> {
    return (await getTestDb().execute(statement)) as unknown as T[];
  }

  async function seedSnapshot(f: Fixture): Promise<void> {
    const [config] = await exec<{ id: string }>(sql`
      INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
      VALUES (${f.orgId}, ${`Hold config ${randomUUID()}`}, 'file', 'local', ${JSON.stringify({ path: '/tmp/breeze-hold' })}::jsonb)
      RETURNING id
    `);
    const [job] = await exec<{ id: string }>(sql`
      INSERT INTO backup_jobs (org_id, config_id, device_id, status, snapshot_id)
      VALUES (${f.orgId}, ${config!.id}, ${f.deviceId}, 'completed', 'HOLD-S1') RETURNING id
    `);
    await exec(sql`
      INSERT INTO backup_snapshots (org_id, job_id, device_id, config_id, snapshot_id, storage_identity, size, file_count, backup_type)
      VALUES (${f.orgId}, ${job!.id}, ${f.deviceId}, ${config!.id}, 'HOLD-S1', 'local::/tmp/breeze-hold', 4096, 2, 'file')
    `);
  }

  /** An active policy with backup settings; the settings row is keyed like the policy (org XOR partner). */
  async function seedBackupPolicy(
    owner: { orgId?: string; partnerId?: string },
    legalHold: boolean,
  ): Promise<{ policyId: string; settingsId: string }> {
    const [policy] = await exec<{ id: string }>(sql`
      INSERT INTO configuration_policies (org_id, partner_id, name, status)
      VALUES (${owner.orgId ?? null}, ${owner.partnerId ?? null}, ${`Held backups ${randomUUID()}`}, 'active')
      RETURNING id
    `);
    const [link] = await exec<{ id: string }>(sql`
      INSERT INTO config_policy_feature_links (config_policy_id, feature_type) VALUES (${policy!.id}, 'backup') RETURNING id
    `);
    const [settings] = await exec<{ id: string }>(sql`
      INSERT INTO config_policy_backup_settings (feature_link_id, org_id, partner_id, retention)
      VALUES (${link!.id}, ${owner.orgId ?? null}, ${owner.partnerId ?? null},
              ${JSON.stringify({ legalHold, legalHoldReason: 'regulator request' })}::jsonb)
      RETURNING id
    `);
    return { policyId: policy!.id, settingsId: settings!.id };
  }

  async function setHold(settingsId: string): Promise<void> {
    await exec(sql`
      UPDATE config_policy_backup_settings
         SET retention = ${JSON.stringify({ legalHold: true, legalHoldReason: 'placed mid-erasure' })}::jsonb
       WHERE id = ${settingsId}
    `);
  }

  async function holdIsSet(settingsId: string): Promise<boolean> {
    const [row] = await exec<{ held: boolean }>(sql`
      SELECT (retention -> 'legalHold') = 'true'::jsonb AS held FROM config_policy_backup_settings WHERE id = ${settingsId}
    `);
    return row?.held === true;
  }

  async function snapshotCount(orgId: string): Promise<number> {
    return (await exec(sql`SELECT id FROM backup_snapshots WHERE org_id = ${orgId}`)).length;
  }

  type EveryLevel = Record<'organization' | 'site' | 'device_group' | 'device', string>;

  async function assignEveryLevel(f: Fixture, policyId: string): Promise<EveryLevel> {
    return {
      organization: await assign(policyId, 'organization', f.orgId),
      site: await assign(policyId, 'site', f.siteId),
      device_group: await assign(policyId, 'device_group', f.groupId),
      device: await assign(policyId, 'device', f.deviceId),
    };
  }

  /** A walk table that runs before `backup_snapshots`: after the entry check, before the re-check. */
  async function tableBeforeSnapshots(): Promise<string> {
    const order = await topologicalCascadeOrder();
    const first = order[0]!;
    expect(order.indexOf(first)).toBeLessThan(order.indexOf('backup_snapshots'));
    return first;
  }

  async function expectRefusedWithEverythingKept(
    f: Fixture,
    settingsId: string,
    ids: EveryLevel,
    run: Promise<unknown>,
  ): Promise<void> {
    const err = await run.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TenantCascadeRefusalError);
    expect((err as TenantCascadeRefusalError).code).toBe('LEGAL_HOLD_ACTIVE');
    expect(await orgExists(f.orgId)).toBe(true);
    expect(await snapshotCount(f.orgId)).toBe(1);
    expect(await holdIsSet(settingsId)).toBe(true);
    const all = Object.values(ids);
    expect(await assignmentIds(all)).toEqual([...all].sort());
  }

  afterEach(() => {
    delete __tenantCascadeTestHooks.afterTableStep;
  });

  it('(h) a PARTNER-owned policy hold placed after the entry check refuses at backup_snapshots; snapshots, assignments and hold survive', async () => {
    const f = await seedFixture();
    await seedSnapshot(f);
    const { policyId, settingsId } = await seedBackupPolicy({ partnerId: f.partnerId }, false);
    const ids = await assignEveryLevel(f, policyId);
    const early = await tableBeforeSnapshots();
    __tenantCascadeTestHooks.afterTableStep = async (table) => {
      if (table === early) await setHold(settingsId);
    };

    await expectRefusedWithEverythingKept(f, settingsId, ids, erase(f.orgId));
  });

  it('(i) an ORG-owned policy hold placed after the entry check refuses at backup_snapshots; snapshots, assignments and hold survive', async () => {
    const f = await seedFixture();
    await seedSnapshot(f);
    const { policyId, settingsId } = await seedBackupPolicy({ orgId: f.orgId }, false);
    const ids = await assignEveryLevel(f, policyId);
    const early = await tableBeforeSnapshots();
    __tenantCascadeTestHooks.afterTableStep = async (table) => {
      if (table === early) await setHold(settingsId);
    };

    await expectRefusedWithEverythingKept(f, settingsId, ids, erase(f.orgId));
  });

  it('(j) a PARTNER-owned policy hold already active at entry refuses; everything survives', async () => {
    const f = await seedFixture();
    await seedSnapshot(f);
    const { policyId, settingsId } = await seedBackupPolicy({ partnerId: f.partnerId }, true);
    const ids = await assignEveryLevel(f, policyId);

    await expectRefusedWithEverythingKept(f, settingsId, ids, erase(f.orgId));
  });

  it('(k) a failure right after the backup_snapshots step leaves every assignment in place', async () => {
    const f = await seedFixture();
    await seedSnapshot(f);
    const policy = await seedPolicy({ partnerId: f.partnerId }, 'MSP baseline');
    const ids = await assignEveryLevel(f, policy);
    __tenantCascadeTestHooks.afterTableStep = async (table) => {
      if (table === 'backup_snapshots') throw new Error('injected failure after backup_snapshots');
    };

    await expect(erase(f.orgId)).rejects.toThrow(/injected failure after backup_snapshots/);

    expect(await orgExists(f.orgId)).toBe(true);
    expect(await snapshotCount(f.orgId)).toBe(0);
    const all = Object.values(ids);
    expect(await assignmentIds(all)).toEqual([...all].sort());
  });

  it('(l) an assignment goes only with its own target: a failure after device_groups keeps the device, site and org assignments', async () => {
    const f = await seedFixture();
    const policy = await seedPolicy({ partnerId: f.partnerId }, 'MSP baseline');
    const ids = await assignEveryLevel(f, policy);
    __tenantCascadeTestHooks.afterTableStep = async (table) => {
      if (table === 'device_groups') throw new Error('injected failure after device_groups');
    };

    await expect(erase(f.orgId)).rejects.toThrow(/injected failure after device_groups/);

    expect(await orgExists(f.orgId)).toBe(true);
    expect(await exec(sql`SELECT id FROM device_groups WHERE id = ${f.groupId}`)).toHaveLength(0);
    expect(await assignmentIds(Object.values(ids)))
      .toEqual([ids.organization, ids.site, ids.device].sort());
  });
});
