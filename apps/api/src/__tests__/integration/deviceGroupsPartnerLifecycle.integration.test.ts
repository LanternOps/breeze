/** #10521 W1: partner-owned group definitions survive org lifecycle operations. */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql, type SQL } from 'drizzle-orm';
import JSZip from 'jszip';
import { db, withSystemDbAccessContext } from '../../db';
import { cascadeDeleteOrg, cascadeDeletePartner } from '../../services/tenantCascade';
import { executeOrgMerge } from '../../services/orgMerge';
import { buildOrgExportZip } from '../../services/tenantExport';
import { createOrganization, createPartner, createSite } from './db-utils';

const ACTOR = '00000000-0000-0000-0000-000000000000';
const ACTOR_EMAIL = 'lifecycle@example.com';
const initialDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
afterEach(() => {
  if (initialDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
  else process.env.ORG_MERGE_FENCE_DRAIN_MS = initialDrain;
});

async function query<T = Record<string, unknown>>(statement: SQL): Promise<T[]> {
  return withSystemDbAccessContext(async () => await db.execute(statement) as unknown as T[]);
}

async function seedOrg(partnerId: string) {
  const org = await createOrganization({ partnerId });
  const site = await createSite({ orgId: org.id });
  const [device] = await query<{ id: string }>(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${org.id}, ${site.id}, ${randomUUID()}, 'lifecycle-fixture', 'linux', '1', 'amd64', '1')
    RETURNING id
  `);
  return { orgId: org.id as string, deviceId: device!.id };
}

async function seedFixture() {
  const partner = await createPartner();
  const a = await seedOrg(partner.id);
  const b = await seedOrg(partner.id);
  // Raw SQL: the Drizzle orgId type deliberately stays NOT NULL until W2a.
  const [group] = await query<{ id: string }>(sql`
    INSERT INTO device_groups (partner_id, name, type)
    VALUES (${partner.id}, 'Partner lifecycle group', 'dynamic') RETURNING id
  `);
  for (const member of [a, b]) {
    await query(sql`INSERT INTO device_group_memberships (device_id, group_id, org_id)
      VALUES (${member.deviceId}, ${group!.id}, ${member.orgId})`);
    await query(sql`INSERT INTO group_membership_log (device_id, group_id, org_id, action, reason)
      VALUES (${member.deviceId}, ${group!.id}, ${member.orgId}, 'added', 'filter_match')`);
  }
  return { partnerId: partner.id as string, groupId: group!.id, a, b };
}

describe('partner-owned device groups lifecycle (#10521 W1)', () => {
  it("erasing one org keeps the partner group and other orgs' memberships", async () => {
    const f = await seedFixture();
    await cascadeDeleteOrg(f.a.orgId, ACTOR);
    expect(await query(sql`SELECT id FROM device_groups WHERE id = ${f.groupId}`)).toHaveLength(1);
    expect(await query(sql`SELECT device_id, org_id FROM device_group_memberships WHERE group_id = ${f.groupId}`))
      .toEqual([{ device_id: f.b.deviceId, org_id: f.b.orgId }]);
    expect(await query(sql`SELECT org_id FROM group_membership_log WHERE group_id = ${f.groupId}`))
      .toEqual([{ org_id: f.b.orgId }]);
  });

  it('full partner purge succeeds and a second run is an idempotent no-op', async () => {
    const f = await seedFixture();
    const control = await createPartner();
    const departed = await seedOrg(f.partnerId);
    await query(sql`INSERT INTO device_group_memberships (device_id, group_id, org_id)
      VALUES (${departed.deviceId}, ${f.groupId}, ${departed.orgId})`);
    await query(sql`INSERT INTO group_membership_log (device_id, group_id, org_id, action, reason)
      VALUES (${departed.deviceId}, ${f.groupId}, ${departed.orgId}, 'added', 'filter_match')`);
    // Historical logs remain after reparent, while B1 detaches current membership.
    await query(sql`UPDATE organizations SET partner_id = ${control.id} WHERE id = ${departed.orgId}`);
    expect(await query(sql`SELECT id FROM group_membership_log WHERE group_id = ${f.groupId} AND org_id = ${departed.orgId}`))
      .toHaveLength(1);
    const [policy] = await query<{ id: string }>(sql`
      INSERT INTO configuration_policies (partner_id, name, status)
      VALUES (${f.partnerId}, 'Partner lifecycle policy', 'active') RETURNING id
    `);
    await query(sql`INSERT INTO config_policy_assignments (config_policy_id, level, target_id)
      VALUES (${policy!.id}, 'device_group', ${f.groupId})`);
    expect(await query(sql`SELECT org_id FROM device_group_memberships WHERE group_id = ${f.groupId}`)).toHaveLength(2);

    // The membership pre-clear deletes rows of two orgs in one statement; its
    // statement-level touch trigger must not abort on partner-export lock
    // ordering. This only proves the statement succeeds (it does not observe
    // lock order). Roll back so the real purge below starts with both rows.
    const rollbackProbe = new Error('rollback multi-org membership pre-clear probe');
    await expect(withSystemDbAccessContext(async () => {
      await db.execute(sql`DELETE FROM device_group_memberships
        WHERE group_id IN (SELECT id FROM device_groups WHERE partner_id = ${f.partnerId})`);
      const rows = await db.execute(sql`SELECT device_id FROM device_group_memberships WHERE group_id = ${f.groupId}`);
      expect(rows).toHaveLength(0);
      throw rollbackProbe;
    })).rejects.toBe(rollbackProbe);
    expect(await query(sql`SELECT org_id FROM device_group_memberships WHERE group_id = ${f.groupId}`)).toHaveLength(2);

    await cascadeDeletePartner(f.partnerId, ACTOR);
    const retry = await cascadeDeletePartner(f.partnerId, ACTOR);
    expect(retry.totalRowsDeleted).toBe(0);
    for (const table of ['device_group_memberships', 'group_membership_log']) {
      expect(await query(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE group_id = ${f.groupId}`)).toEqual([]);
    }
    expect(await query(sql`SELECT id FROM config_policy_assignments WHERE target_id = ${f.groupId}`)).toEqual([]);
    expect(await query(sql`SELECT id FROM device_groups WHERE id = ${f.groupId}`)).toEqual([]);
    expect(await query(sql`SELECT id FROM partners WHERE id = ${f.partnerId}`)).toEqual([]);
    expect(await query(sql`SELECT id FROM organizations WHERE id = ${departed.orgId} AND partner_id = ${control.id}`)).toHaveLength(1);
    expect(await query(sql`SELECT id FROM devices WHERE id = ${departed.deviceId}`)).toHaveLength(1);
  });

  it('merge with a partner-group member keeps a valid membership', async () => {
    const f = await seedFixture();
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    await executeOrgMerge({
      loserOrgId: f.a.orgId, survivorOrgId: f.b.orgId, partnerId: f.partnerId,
      performedBy: ACTOR, performedByEmail: ACTOR_EMAIL,
    });
    expect(await query(sql`SELECT org_id FROM device_group_memberships
      WHERE device_id = ${f.a.deviceId} AND group_id = ${f.groupId}`))
      .toEqual([{ org_id: f.b.orgId }]);
    expect(await query(sql`SELECT partner_id FROM device_groups WHERE id = ${f.groupId}`))
      .toEqual([{ partner_id: f.partnerId }]);
  });

  it('org export: own memberships and logs are in, partner group definitions are out', async () => {
    const f = await seedFixture();
    const { zipBuffer } = await buildOrgExportZip(f.a.orgId, ACTOR, ACTOR_EMAIL);
    const archive = await JSZip.loadAsync(zipBuffer);
    const rows = async (table: string): Promise<Array<Record<string, unknown>>> => {
      const file = archive.file(`${table}.json`);
      expect(file).toBeTruthy();
      return JSON.parse(await file!.async('string'));
    };
    const memberships = await rows('device_group_memberships');
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ group_id: f.groupId, device_id: f.a.deviceId, org_id: f.a.orgId });
    const logs = await rows('group_membership_log');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ group_id: f.groupId, org_id: f.a.orgId });
    expect(await rows('device_groups')).toEqual([]);
  });
});
