/** #10521 W2a: partner-group assignment expansion against real PostgreSQL. */
import { getTestDb } from './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { resolveAssignmentDevices } from '../../services/configPolicyAssignmentDevices';
import { resolvePatchConfigPolicyForDevice } from '../../services/featureConfigResolver';
import { resolveDeviceIdsForAssignment } from '../../jobs/automationWorker';
import { findPartnerOwnedGroupIds } from '../../services/deviceGroupOwnership';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const options = { refusedGroups: 'resolve' as const, auditAction: 'test.partner_group_fanout' };

async function query<T = Record<string, unknown>>(statement: SQL): Promise<T[]> {
  return withSystemDbAccessContext(async () => await db.execute(statement) as unknown as T[]);
}

async function seedOrg(partnerId: string) {
  const org = await createOrganization({ partnerId });
  const site = await createSite({ orgId: org.id });
  const [device] = await query<{ id: string }>(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version,
      architecture, agent_version, is_ephemeral)
    VALUES (${org.id}, ${site.id}, ${randomUUID()}, 'partner-fanout', 'linux', '1', 'amd64', '1', false)
    RETURNING id
  `);
  if (!device) throw new Error('device fixture missing');
  return { orgId: org.id, deviceId: device.id };
}

async function seedPolicy(partnerId: string, orgId: string | null, level: 'device_group' | 'organization', targetId: string) {
  const [ring] = await query<{ id: string }>(sql`
    INSERT INTO patch_policies (partner_id, kind, name)
    VALUES (${partnerId}, 'ring', 'Partner fanout ring') RETURNING id
  `);
  if (!ring) throw new Error('ring fixture missing');
  const [policy] = await query<{ id: string }>(sql`
    INSERT INTO configuration_policies (org_id, partner_id, name, status)
    VALUES (${orgId}, ${orgId === null ? partnerId : null}, 'Partner fanout policy', 'active') RETURNING id
  `);
  if (!policy) throw new Error('policy fixture missing');
  const [link] = await query<{ id: string }>(sql`
    INSERT INTO config_policy_feature_links (config_policy_id, feature_type, feature_policy_id, inline_settings)
    VALUES (${policy.id}, 'patch', ${ring.id}, '{}'::jsonb) RETURNING id
  `);
  if (!link) throw new Error('link fixture missing');
  await query(sql`INSERT INTO config_policy_patch_settings (feature_link_id, sources, schedule_frequency, schedule_time)
    VALUES (${link.id}, ARRAY['os']::text[], 'daily', '04:41')`);
  await query(sql`INSERT INTO config_policy_assignments (config_policy_id, level, target_id, priority)
    VALUES (${policy.id}, ${level}, ${targetId}, 0)`);
  return policy.id;
}

async function fixture() {
  const p = await createPartner();
  const q = await createPartner();
  const a = await seedOrg(p.id);
  const b = await seedOrg(p.id);
  const c = await seedOrg(q.id);
  const [group] = await query<{ id: string }>(sql`
    INSERT INTO device_groups (org_id, partner_id, name, type, site_id, parent_id)
    VALUES (NULL, ${p.id}, 'Partner fanout group', 'dynamic', NULL, NULL) RETURNING id
  `);
  if (!group) throw new Error('group fixture missing');
  // Each write uses its device's org. A foreign-partner membership would be
  // rejected by the W1 ownership trigger; c is the non-member control.
  for (const member of [a, b]) {
    await query(sql`INSERT INTO device_group_memberships (device_id, group_id, org_id)
      VALUES (${member.deviceId}, ${group.id}, ${member.orgId})`);
  }
  const policyId = await seedPolicy(p.id, null, 'device_group', group.id);
  return { partnerId: p.id, otherPartnerId: q.id, groupId: group.id, policyId, a, b, c };
}

function expand(f: Awaited<ReturnType<typeof fixture>>) {
  return withSystemDbAccessContext(() => resolveAssignmentDevices(
    { level: 'device_group', targetId: f.groupId, roleFilter: null, osFilter: null },
    { policyOrgId: null, policyPartnerId: f.partnerId }, options,
  ));
}

/** Exercise the normal agent read context, including SELECT-only partner visibility. */
function effective(member: { orgId: string; deviceId: string }, partnerId: string) {
  return withDbAccessContext({
    scope: 'organization', orgId: member.orgId, accessibleOrgIds: [member.orgId],
    accessiblePartnerIds: [], currentPartnerId: partnerId, userId: null,
  }, () => resolvePatchConfigPolicyForDevice(member.deviceId));
}

describe('partner device group fanout (#10521 W2a)', () => {
  runDb('partner-group assignment expands to members in every org of the partner', async () => {
    const f = await fixture();
    expect((await expand(f)).deviceIds.sort()).toEqual([f.a.deviceId, f.b.deviceId].sort());
  });

  runDb('effective config resolves the partner-group assignment on devices in both orgs', async () => {
    const f = await fixture();
    for (const member of [f.a, f.b]) {
      expect(await effective(member, f.partnerId)).toMatchObject({
        configPolicyId: f.policyId, assignmentLevel: 'device_group', assignmentTargetId: f.groupId,
      });
    }
  });

  runDb('precedence: the partner-group assignment (device_group, priority 4) beats an org-level assignment of another policy', async () => {
    const f = await fixture();
    // Hierarchy priority 4 (device_group) outranks 2 (organization), regardless
    // of assignment.priority (the same-level tie breaker).
    await seedPolicy(f.partnerId, f.a.orgId, 'organization', f.a.orgId);
    expect(await effective(f.a, f.partnerId)).toMatchObject({
      configPolicyId: f.policyId, assignmentLevel: 'device_group',
    });
  });

  runDb('automation schedule on a partner-owned policy resolves both orgs\' members', async () => {
    const f = await fixture();
    const ids = await withSystemDbAccessContext(() =>
      resolveDeviceIdsForAssignment('device_group', f.groupId, null, f.partnerId));
    expect(ids.sort()).toEqual([f.a.deviceId, f.b.deviceId].sort());
  });

  runDb('a device in another partner\'s org is never resolved', async () => {
    const f = await fixture();
    expect((await expand(f)).deviceIds).not.toContain(f.c.deviceId);
    const scheduled = await withSystemDbAccessContext(() =>
      resolveDeviceIdsForAssignment('device_group', f.groupId, null, f.partnerId));
    expect(scheduled).not.toContain(f.c.deviceId);
    expect(await effective(f.c, f.otherPartnerId)).toBeNull();
    // Even a stale/forged policy owner cannot widen the system-scoped resolver.
    expect(await withSystemDbAccessContext(() =>
      resolveDeviceIdsForAssignment('device_group', f.groupId, null, f.otherPartnerId))).toEqual([]);
    expect((await withSystemDbAccessContext(() => resolveAssignmentDevices(
      { level: 'device_group', targetId: f.groupId, roleFilter: null, osFilter: null },
      { policyOrgId: null, policyPartnerId: f.otherPartnerId }, options,
    ))).deviceIds).toEqual([]);
  });

  runDb('groupOwnerMatchesMembershipOrg ignores a forged foreign-partner membership', async () => {
    const f = await fixture();
    // The owner test connection can disable this ordinary trigger. All DDL
    // and the forged insert share a transaction: a failure rolls the trigger
    // state back, and successful setup re-enables it before commit.
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      await tx.execute(sql`ALTER TABLE device_group_memberships DISABLE TRIGGER device_group_memberships_group_owner_check`);
      await tx.execute(sql`INSERT INTO device_group_memberships (device_id, group_id, org_id)
        VALUES (${f.c.deviceId}, ${f.groupId}, ${f.c.orgId})`);
      // Flush the deferred device/org FK events before ALTER TABLE.
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      await tx.execute(sql`ALTER TABLE device_group_memberships ENABLE TRIGGER device_group_memberships_group_owner_check`);
    });
    try {
      const forged = await query(sql`SELECT device_id FROM device_group_memberships
        WHERE group_id = ${f.groupId} AND device_id = ${f.c.deviceId}`);
      expect(forged).toHaveLength(1);
      expect((await expand(f)).deviceIds.sort()).toEqual([f.a.deviceId, f.b.deviceId].sort());
      expect(await withSystemDbAccessContext(() =>
        resolveDeviceIdsForAssignment('device_group', f.groupId, null, f.partnerId)))
        .not.toContain(f.c.deviceId);
    } finally {
      await query(sql`DELETE FROM device_group_memberships
        WHERE group_id = ${f.groupId} AND device_id = ${f.c.deviceId} AND org_id = ${f.c.orgId}`);
    }
  });

  runDb('write refusals detect a partner group for an org-session caller (no partner id in the DB context)', async () => {
    const f = await fixture();
    // The real org-JWT request context: middleware/auth.ts keeps partnerId null,
    // so RLS hides the partner group from this caller. The refusal must still fire.
    const found = await withDbAccessContext({
      scope: 'organization', orgId: f.a.orgId, accessibleOrgIds: [f.a.orgId],
      accessiblePartnerIds: [], currentPartnerId: null, userId: null,
    }, () => findPartnerOwnedGroupIds([f.groupId, f.a.deviceId]));
    expect(found).toEqual([f.groupId]);
  });

  runDb('another partner\'s group is indistinguishable from an unknown id (no cross-tenant existence oracle)', async () => {
    const f = await fixture();
    const [foreign] = await query<{ id: string }>(sql`
      INSERT INTO device_groups (org_id, partner_id, name, type)
      VALUES (NULL, ${f.otherPartnerId}, 'Other partner group', 'dynamic') RETURNING id
    `);
    if (!foreign) throw new Error('foreign group fixture missing');
    const orgSession = {
      scope: 'organization' as const, orgId: f.a.orgId, accessibleOrgIds: [f.a.orgId],
      accessiblePartnerIds: [], currentPartnerId: null, userId: null,
    };
    const partnerSession = {
      scope: 'partner' as const, orgId: null, accessibleOrgIds: [f.a.orgId, f.b.orgId],
      accessiblePartnerIds: [f.partnerId], currentPartnerId: f.partnerId, userId: null,
    };
    for (const ctx of [orgSession, partnerSession]) {
      const foreignResult = await withDbAccessContext(ctx, () => findPartnerOwnedGroupIds([foreign.id]));
      const unknownResult = await withDbAccessContext(ctx, () => findPartnerOwnedGroupIds([randomUUID()]));
      expect(foreignResult).toEqual([]);
      expect(foreignResult).toEqual(unknownResult);
      // Own partner's group is still detected in the same call.
      expect(await withDbAccessContext(ctx, () => findPartnerOwnedGroupIds([foreign.id, f.groupId])))
        .toEqual([f.groupId]);
    }
  });
});
