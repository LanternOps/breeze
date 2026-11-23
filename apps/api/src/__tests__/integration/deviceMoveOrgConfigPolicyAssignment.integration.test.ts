/**
 * Integration test: a device org-move with a device-level configuration
 * policy assignment (#12491).
 *
 * `config_policy_assignments_target_owner_fk` refuses a device-level
 * assignment of an org-owned policy whose device sits in another org, and it
 * checks at the end of the `UPDATE devices SET org_id` statement. The move
 * engine therefore removes the device's assignments of the source org's
 * policies before that statement, and records them on both audit rows.
 * Assignments of partner-owned policies stay when the move stays inside the
 * partner.
 *
 * Harness mirrors deviceMoveOrgAlertChildren.integration.test.ts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { auditLogs, configPolicyAssignments, devices, users } from '../../db/schema';
import { createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';
import { awaitAuditRows } from './auditWait';

async function seed(policyOwner: 'sourceOrg' | 'partner', crossPartner = false) {
  const adminDb = getTestDb() as any;
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // A cross-partner move needs system scope (moveOrg.ts refuses it otherwise).
  const scope = crossPartner ? 'system' : 'partner';
  const { partner, organization: orgA, site: siteA, user, role } = await setupTestEnvironment({ scope });
  const orgB = await createOrganization({ partnerId: crossPartner ? (await createPartner()).id : partner.id });
  // auth.ts accepts a system token only from a platform admin.
  if (crossPartner) await adminDb.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
  const siteB = await createSite({ orgId: orgB.id });

  const [device] = await adminDb.insert(devices).values({
    orgId: orgA.id,
    siteId: siteA.id,
    agentId: `cpa-agent-${unique}`,
    hostname: `cpa-host-${unique}`,
    osType: 'linux',
    osVersion: '22.04',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'offline',
  }).returning();

  // Todd's B1/B2 fixture rows from the issue.
  const policyId = randomUUID();
  const assignmentId = randomUUID();
  if (policyOwner === 'sourceOrg') {
    await adminDb.execute(sql`
      INSERT INTO configuration_policies (id, org_id, name)
      VALUES (${policyId}::uuid, ${orgA.id}::uuid, 'OrgOwned')`);
  } else {
    await adminDb.execute(sql`
      INSERT INTO configuration_policies (id, partner_id, name)
      VALUES (${policyId}::uuid, ${partner.id}::uuid, 'PartnerOwned')`);
  }
  await adminDb.execute(sql`
    INSERT INTO config_policy_assignments (id, config_policy_id, level, target_id)
    VALUES (${assignmentId}::uuid, ${policyId}::uuid, 'device', ${device.id}::uuid)`);

  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: crossPartner ? null : partner.id,
    scope,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });
  const app = new Hono();
  app.route('/devices', moveOrgRoutes);
  const move = async () =>
    app.request(`/devices/${device.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(await withMoveOrgStepUpGrant(token, device.id, { orgId: orgB.id, siteId: siteB.id })),
    });

  const deviceOrg = async () =>
    (await adminDb.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, device.id)))[0]?.orgId;
  const assignment = async () =>
    (await adminDb.select().from(configPolicyAssignments).where(eq(configPolicyAssignments.id, assignmentId)))[0];

  return { adminDb, orgA, orgB, device, policyId, assignmentId, move, deviceOrg, assignment };
}

describe('POST /devices/:id/move-org with a device-level config policy assignment (#12491)', () => {
  it('B1: removes the assignment of a source-org policy, moves the device and audits the removal', async () => {
    const f = await seed('sourceOrg');

    const res = await f.move();
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(200);

    expect(await f.deviceOrg()).toBe(f.orgB.id);
    expect(await f.assignment()).toBeUndefined();

    const audits = await awaitAuditRows<{ action: string; details: unknown }>(() => f.adminDb
      .select({ action: auditLogs.action, details: auditLogs.details })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, f.device.id)), 2);
    expect(audits.map((a) => a.action).sort()).toEqual(['device.move_org.source', 'device.move_org.target']);
    for (const row of audits) {
      expect(row.details).toMatchObject({
        removedConfigPolicyAssignments: [
          { assignmentId: f.assignmentId, policyId: f.policyId, policyName: 'OrgOwned' },
        ],
      });
    }
  });

  it('B2: keeps the assignment of a partner-owned policy when both orgs are under that partner', async () => {
    const f = await seed('partner');

    const res = await f.move();
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(200);

    expect(await f.deviceOrg()).toBe(f.orgB.id);
    expect(await f.assignment()).toMatchObject({ id: f.assignmentId, configPolicyId: f.policyId, level: 'device' });

    const audits = await awaitAuditRows<{ details: unknown }>(() => f.adminDb
      .select({ details: auditLogs.details })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, f.device.id)), 2);
    for (const row of audits) {
      expect(row.details).not.toHaveProperty('removedConfigPolicyAssignments');
    }
  });

  it('B3: removes the assignment of the old partner\'s policy on a system-scope move to another partner', async () => {
    const f = await seed('partner', true);

    const res = await f.move();
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(200);

    expect(await f.deviceOrg()).toBe(f.orgB.id);
    expect(await f.assignment()).toBeUndefined();

    const audits = await awaitAuditRows<{ details: unknown }>(() => f.adminDb
      .select({ details: auditLogs.details })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, f.device.id)), 2);
    for (const row of audits) {
      expect(row.details).toMatchObject({
        removedConfigPolicyAssignments: [
          { assignmentId: f.assignmentId, policyId: f.policyId, policyName: 'PartnerOwned' },
        ],
      });
    }
  });
});
