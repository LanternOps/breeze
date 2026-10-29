/** W3: real request-role RLS, JWT authorization, assignment and delete-lock regressions. */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import {
  configurationPolicies, configPolicyAssignments, deviceGroups, deviceGroupMemberships,
  groupMembershipLog, organizations, partnerUsers,
} from '../../db/schema';
import { groupRoutes } from '../../routes/groups';
import { configPolicyRoutes } from '../../routes/configurationPolicies';
import { createAccessToken } from '../../services/jwt';
import { shutdownPartnerGroupEvaluationJobs } from '../../jobs/partnerGroupEvaluationJobs';
import { shutdownPeripheralJobs } from '../../jobs/peripheralJobs';
import { closeRedis } from '../../services/redis';
import { evaluatePartnerGroupForOrg } from '../../services/partnerGroupEvaluation';
import { resolveAssignmentDevices } from '../../services/configPolicyAssignmentDevices';
import type { FilterConditionGroup } from '../../services/filterEngine';
import {
  assignUserToOrganization, assignUserToPartner, createOrganization, createRole,
  createSite, createUser, grantRolePermissions, setupTestEnvironment,
} from './db-utils';
import { seedDevice, seedGroup } from './partnerDeviceGroupEvaluation.helpers';

const runDb = it.runIf(!!process.env.DATABASE_URL);
afterAll(async () => {
  await shutdownPartnerGroupEvaluationJobs();
  await shutdownPeripheralJobs();
  await closeRedis();
});
const FILTER: FilterConditionGroup = {
  operator: 'AND', conditions: [{ field: 'architecture', operator: 'equals', value: 'x64' }],
};

function makeApp() {
  const app = new Hono();
  app.route('/groups', groupRoutes);
  app.route('/configuration-policies', configPolicyRoutes);
  return app;
}

function request(app: Hono, token: string, path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function tokenFor(
  partnerId: string,
  options: { orgId?: string; orgAccess?: 'all' | 'selected' | 'none'; orgIds?: string[]; readOnly?: boolean } = {},
) {
  const scope = options.orgId ? 'organization' : 'partner';
  const user = await createUser({ partnerId, orgId: options.orgId, email: `${randomUUID()}@example.com` });
  const role = await createRole({ scope, partnerId, orgId: options.orgId });
  await grantRolePermissions(role.id, options.readOnly
    ? [{ resource: 'devices', action: 'read' }]
    : [{ resource: '*', action: '*' }]);
  if (options.orgId) {
    await assignUserToOrganization(user.id, options.orgId, role.id);
  } else {
    const membership = await assignUserToPartner(user.id, partnerId, role.id, options.orgAccess ?? 'all');
    if (options.orgIds) {
      await withSystemDbAccessContext(() => db.update(partnerUsers)
        .set({ orgIds: options.orgIds }).where(eq(partnerUsers.id, membership.id)));
    }
  }
  // Match a web organization session: partnerId is deliberately NULL in the JWT.
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, scope,
    orgId: options.orgId ?? null, partnerId: options.orgId ? null : partnerId,
    mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

async function populatedFixture() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const otherOrg = await createOrganization({ partnerId: env.partner.id });
  const otherSite = await createSite({ orgId: otherOrg.id });
  const ownDeviceId = await seedDevice(env.organization.id, env.site.id);
  const otherDeviceId = await seedDevice(otherOrg.id, otherSite.id);
  const group = await seedGroup(env.partner.id, FILTER);
  for (const orgId of [env.organization.id, otherOrg.id]) {
    const result = await evaluatePartnerGroupForOrg(group.id, orgId);
    expect(result.ok).toBe(true);
    expect(result.added).toBe(1);
  }
  return { env, group, otherOrg, ownDeviceId, otherDeviceId };
}

async function assertStatus(response: Response, status: number) {
  const raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw);
}

function assertNoFilter(raw: string) {
  expect(raw).not.toContain('architecture');
  expect(raw).not.toContain('x64');
}

async function seedPolicy(owner: { orgId: string } | { partnerId: string }) {
  return withSystemDbAccessContext(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      ...owner, name: `W3 assignment ${randomUUID()}`, status: 'active',
    }).returning();
    if (!policy) throw new Error('missing configuration policy fixture');
    return policy;
  });
}

describe('partner-owned device group REST API (#10521 W3)', () => {
  runDb('P-all creates with token ownership; P-sel and org admins are denied; filter PATCH increments exactly once', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const app = makeApp();
    const all = await tokenFor(env.partner.id);
    const selected = await tokenFor(env.partner.id, { orgAccess: 'selected', orgIds: [env.organization.id] });
    const orgAdmin = await tokenFor(env.partner.id, { orgId: env.organization.id });
    const payload = { ownerScope: 'partner', name: 'All x64 devices', type: 'dynamic', filterConditions: FILTER };
    await assertStatus(await request(app, selected, '/groups', 'POST', payload), 403);
    await assertStatus(await request(app, orgAdmin, '/groups', 'POST', payload), 403);
    const created = await assertStatus(await request(app, all, `/groups?orgId=${env.organization.id}`, 'POST', payload), 201);
    expect(created.data).toMatchObject({
      orgId: null, partnerId: env.partner.id, siteId: null, parentId: null,
      ownerScope: 'partner', deviceCount: 0, evaluation: { state: 'pending' },
    });
    const before = await withSystemDbAccessContext(() => db.select().from(deviceGroups)
      .where(eq(deviceGroups.id, created.data.id)));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ orgId: null, partnerId: env.partner.id, filterRevision: 1 });
    const changedFilter: FilterConditionGroup = {
      operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'linux' }],
    };
    await assertStatus(await request(app, all, `/groups/${created.data.id}`, 'PATCH', { filterConditions: changedFilter }), 200);
    const after = await withSystemDbAccessContext(() => db.select().from(deviceGroups)
      .where(eq(deviceGroups.id, created.data.id)));
    expect(after[0]).toMatchObject({ orgId: null, partnerId: env.partner.id, filterRevision: 2, filterConditions: changedFilter });
  });

  runDb('OD5 exposes only name, ownership and own-org membership to web org sessions, with no filter leak', async () => {
    const { env, group, ownDeviceId, otherDeviceId } = await populatedFixture();
    const app = makeApp();
    const reader = await tokenFor(env.partner.id, { orgId: env.organization.id, readOnly: true });
    const orgAdmin = await tokenFor(env.partner.id, { orgId: env.organization.id });
    for (const path of ['/groups?ownerScope=all', `/groups/${group.id}`]) {
      const response = await request(app, reader, path);
      const raw = await response.text();
      expect(response.status, raw).toBe(200);
      assertNoFilter(raw);
      const body = JSON.parse(raw);
      const dto = Array.isArray(body.data) ? body.data.find((row: { id: string }) => row.id === group.id) : body.data;
      expect(dto).toMatchObject({
        id: group.id, name: group.name, ownerScope: 'partner', orgId: null,
        partnerId: env.partner.id, deviceCount: 1, siteId: null, parentId: null,
        filterConditions: null, rules: null, filterFieldsUsed: [], evaluation: null,
      });
      expect(dto).not.toHaveProperty('policy');
    }
    const members = await request(app, reader, `/groups/${group.id}/devices`);
    const rawMembers = await members.text();
    expect(members.status, rawMembers).toBe(200);
    assertNoFilter(rawMembers);
    expect(JSON.parse(rawMembers).data).toEqual([expect.objectContaining({ deviceId: ownDeviceId, orgId: env.organization.id })]);
    expect(rawMembers).not.toContain(otherDeviceId);

    const unknown = await request(app, reader, `/groups/${randomUUID()}`);
    const unknownBody = await unknown.text();
    expect(unknown.status).toBe(404);
    expect(unknownBody).toBe(JSON.stringify({ error: 'Group not found' }));
    for (const [method, suffix, body] of [
      ['PATCH', '', { name: 'forbidden' }], ['DELETE', '', undefined],
      ['POST', '/preview', {}], ['GET', '/membership-log', undefined],
    ] satisfies Array<[string, string, unknown]>) {
      const response = await request(app, orgAdmin, `/groups/${group.id}${suffix}`, method, body);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(unknownBody);
    }
    for (const method of ['PATCH', 'DELETE']) {
      const response = await request(app, reader, `/groups/${group.id}`, method, { name: 'forbidden' });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(unknownBody);
    }
    const foreign = await setupTestEnvironment();
    const foreignReader = await tokenFor(foreign.partner.id, { orgId: foreign.organization.id, readOnly: true });
    const foreignKnown = await request(app, foreignReader, `/groups/${group.id}`);
    const foreignUnknown = await request(app, foreignReader, `/groups/${randomUUID()}`);
    expect(foreignKnown.status).toBe(foreignUnknown.status);
    expect(foreignKnown.status).toBe(404);
    expect(await foreignKnown.text()).toBe(await foreignUnknown.text());
    const foreignList = await assertStatus(await request(app, foreignReader, '/groups?ownerScope=all'), 200);
    expect(foreignList.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: group.id })]));
  });

  runDb('P-sel reads definitions but counts, device rows and membership logs stay within selected orgs', async () => {
    const { env, group, ownDeviceId, otherDeviceId } = await populatedFixture();
    const app = makeApp();
    const selected = await tokenFor(env.partner.id, { orgAccess: 'selected', orgIds: [env.organization.id] });
    const detail = await assertStatus(await request(app, selected, `/groups/${group.id}`), 200);
    expect(detail.data).toMatchObject({ deviceCount: 1, filterConditions: FILTER });
    const list = await assertStatus(await request(app, selected, '/groups?ownerScope=partner'), 200);
    expect(list.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: group.id, deviceCount: 1 })]));
    const members = await assertStatus(await request(app, selected, `/groups/${group.id}/devices`), 200);
    expect(members.data).toEqual([expect.objectContaining({ deviceId: ownDeviceId, orgId: env.organization.id })]);
    const logs = await assertStatus(await request(app, selected, `/groups/${group.id}/membership-log`), 200);
    expect(logs.total).toBe(1);
    expect(logs.data).toEqual([expect.objectContaining({ deviceId: ownDeviceId })]);
    expect(JSON.stringify(logs)).not.toContain(otherDeviceId);
    await assertStatus(await request(app, selected, `/groups/${group.id}`, 'PATCH', { name: 'denied' }), 403);
    await assertStatus(await request(app, selected, `/groups/${group.id}`, 'DELETE'), 403);
  });

  runDb('deletes five member orgs including a suspended org, with a lower UUID non-member org and three assignments, atomically', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const lowOrgId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    await withSystemDbAccessContext(() => db.insert(organizations).values({
      id: lowOrgId, partnerId: env.partner.id, name: 'Lowest UUID non-member org',
      slug: `low-${randomUUID()}`, status: 'active', type: 'customer', currencyCode: 'USD',
    }));
    // Assignment exports touch this low org even though membership deletion does not.
    const orgIds = [env.organization.id];
    await seedDevice(env.organization.id, env.site.id);
    for (let index = 0; index < 4; index++) {
      const org = await createOrganization({ partnerId: env.partner.id });
      const site = await createSite({ orgId: org.id });
      await seedDevice(org.id, site.id);
      orgIds.push(org.id);
    }
    for (const orgId of orgIds) expect(orgId > lowOrgId).toBe(true);
    expect(orgIds).not.toContain(lowOrgId);
    const suspendedOrgId = orgIds[4];
    if (!suspendedOrgId) throw new Error('missing suspended org');
    const group = await seedGroup(env.partner.id, FILTER);
    for (const orgId of orgIds) {
      const result = await evaluatePartnerGroupForOrg(group.id, orgId);
      expect(result.added).toBe(1);
    }
    const policyIds: string[] = [];
    // Separate fixture transactions avoid creating a lock-order failure in the seed itself.
    for (let index = 0; index < 3; index++) {
      const policy = await seedPolicy({ partnerId: env.partner.id });
      policyIds.push(policy.id);
      await withSystemDbAccessContext(() => db.insert(configPolicyAssignments).values({
        configPolicyId: policy.id, level: 'device_group', targetId: group.id, priority: 4,
      }));
    }
    await withSystemDbAccessContext(() => db.update(organizations).set({ status: 'suspended' })
      .where(eq(organizations.id, suspendedOrgId)));
    const before = await withSystemDbAccessContext(async () => ({
      memberships: await db.select().from(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, group.id)),
      logs: await db.select().from(groupMembershipLog).where(eq(groupMembershipLog.groupId, group.id)),
      assignments: await db.select().from(configPolicyAssignments).where(inArray(configPolicyAssignments.configPolicyId, policyIds)),
    }));
    expect(before.memberships).toHaveLength(5);
    expect(before.memberships.map(row => row.orgId).sort()).toEqual([...orgIds].sort());
    expect(before.memberships.some(row => row.orgId === lowOrgId)).toBe(false);
    expect(before.logs).toHaveLength(5);
    expect(before.assignments).toHaveLength(3);
    const all = await tokenFor(env.partner.id);
    // Real route + breeze_app connection: any P0001 ascending-order or 23503 FK abort is a 500 here.
    await assertStatus(await request(makeApp(), all, `/groups/${group.id}`, 'DELETE'), 200);
    await withSystemDbAccessContext(async () => {
      expect(await db.select().from(deviceGroups).where(eq(deviceGroups.id, group.id))).toHaveLength(0);
      expect(await db.select().from(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, group.id))).toHaveLength(0);
      expect(await db.select().from(groupMembershipLog).where(eq(groupMembershipLog.groupId, group.id))).toHaveLength(0);
      expect(await db.select().from(configPolicyAssignments).where(inArray(configPolicyAssignments.configPolicyId, policyIds))).toHaveLength(0);
    });
  });

  runDb('deletes a partner group with members and no assignments despite a lower non-member org', async () => {
    const { env, group, otherOrg } = await populatedFixture();
    const lowOrgId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    await withSystemDbAccessContext(() => db.insert(organizations).values({
      id: lowOrgId, partnerId: env.partner.id, name: 'Non-member org without assignments',
      slug: `low-${randomUUID()}`, status: 'active', type: 'customer', currencyCode: 'USD',
    }));
    for (const orgId of [env.organization.id, otherOrg.id]) expect(orgId > lowOrgId).toBe(true);
    const assignments = await withSystemDbAccessContext(() => db.select().from(configPolicyAssignments)
      .where(eq(configPolicyAssignments.targetId, group.id)));
    expect(assignments).toHaveLength(0);
    const all = await tokenFor(env.partner.id);
    await assertStatus(await request(makeApp(), all, `/groups/${group.id}`, 'DELETE'), 200);
    await withSystemDbAccessContext(async () => {
      expect(await db.select().from(deviceGroups).where(eq(deviceGroups.id, group.id))).toHaveLength(0);
      expect(await db.select().from(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, group.id))).toHaveLength(0);
      expect(await db.select().from(groupMembershipLog).where(eq(groupMembershipLog.groupId, group.id))).toHaveLength(0);
    });
  });

  runDb('partner policy assignment reaches two orgs; an org policy cannot target the partner group', async () => {
    const { env, group, ownDeviceId, otherDeviceId } = await populatedFixture();
    const all = await tokenFor(env.partner.id);
    const partnerPolicy = await seedPolicy({ partnerId: env.partner.id });
    const app = makeApp();
    const assignment = await assertStatus(await request(app, all,
      `/configuration-policies/${partnerPolicy.id}/assignments`, 'POST',
      { level: 'device_group', targetId: group.id }), 201);
    expect(assignment).toMatchObject({ configPolicyId: partnerPolicy.id, level: 'device_group', targetId: group.id });
    const expanded = await withSystemDbAccessContext(() => resolveAssignmentDevices(
      { level: 'device_group', targetId: group.id, roleFilter: null, osFilter: null },
      { policyOrgId: null, policyPartnerId: env.partner.id },
      { refusedGroups: 'resolve', auditAction: 'test.partner_group_expansion' },
    ));
    expect(expanded.deviceIds.sort()).toEqual([ownDeviceId, otherDeviceId].sort());
    const orgPolicy = await seedPolicy({ orgId: env.organization.id });
    const refused = await assertStatus(await request(app, all,
      `/configuration-policies/${orgPolicy.id}/assignments`, 'POST',
      { level: 'device_group', targetId: group.id }), 400);
    expect(refused).toEqual({ error: 'Partner-wide device groups can only be targeted by partner-wide policies' });
  });

  runDb('org-group PATCH refuses filter references to a partner group', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const group = await seedGroup(env.partner.id, FILTER);
    const all = await tokenFor(env.partner.id);
    const app = makeApp();
    const orgGroup = await assertStatus(await request(app, all, `/groups?orgId=${env.organization.id}`, 'POST', {
      name: 'Organization group', type: 'dynamic', filterConditions: FILTER,
    }), 201);
    const refused = await assertStatus(await request(app, all, `/groups/${orgGroup.data.id}`, 'PATCH', {
      filterConditions: { operator: 'AND', conditions: [{ field: 'groupId', operator: 'equals', value: group.id }] },
    }), 400);
    expect(refused.code).toBe('PARTNER_GROUP_FILTER_UNSUPPORTED');
  });
});
