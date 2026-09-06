/** RMM-QA-221: mounted summaries under real JWT/RBAC and breeze_app RLS. */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { getAppDb, getTestDb } from './setup';
import { createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions } from './db-utils';
import { createAccessToken } from '../../services/jwt';
import { clearPermissionCache } from '../../services/permissions';
import {
  devices, organizationUsers, partnerUsers, users, s1Agents, s1Threats,
  s1Actions, s1Integrations, s1OrgMappings, softwarePolicies, softwareComplianceStatus,
} from '../../db/schema';
import { softwarePoliciesRoutes } from '../../routes/softwarePolicies';
import { sentinelOneRoutes } from '../../routes/sentinelOne';

const app = new Hono();
app.route('/software-policies', softwarePoliciesRoutes);
app.route('/sentinel-one', sentinelOneRoutes);
const overviewPath = '/software-policies/compliance/overview';
const statusPath = '/sentinel-one/status';
const threatsPath = '/sentinel-one/threats';
const zeroSoftware = { total: 0, compliant: 0, violations: 0, unknown: 0 };
const zeroSecurity = {
  totalAgents: 0, mappedDevices: 0, infectedAgents: 0, activeThreats: 0,
  highOrCriticalThreats: 0, pendingActions: 0, reportedThreatCount: 0,
};

async function request(path: string, token: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

async function read(path: string, token: string) {
  const response = await request(path, token);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function fixture() {
  const partner = await createPartner();
  const foreignPartner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
  const siteA = await createSite({ orgId: org.id });
  const siteB = await createSite({ orgId: org.id });
  const otherSite = await createSite({ orgId: otherOrg.id });
  const foreignSite = await createSite({ orgId: foreignOrg.id });
  const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(role.id, [{ resource: 'devices', action: 'read' }]);
  const noRead = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id, name: 'Partner Admin' });
  await grantRolePermissions(partnerRole.id, [{ resource: '*', action: '*' }]);
  const partnerNoRead = await createRole({ scope: 'partner', partnerId: partner.id });
  const partnerReader = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerReader.id, [{ resource: 'devices', action: 'read' }]);

  async function principal(scope: 'organization' | 'partner' | 'system', siteIds: string[] | null, canRead = true, readOnly = false) {
    const user = await createUser({ partnerId: partner.id, email: `${randomUUID()}@example.com` });
    const roleId = scope === 'organization'
      ? (canRead ? role.id : noRead.id)
      : (canRead ? (readOnly ? partnerReader.id : partnerRole.id) : partnerNoRead.id);
    if (scope === 'organization') {
      await getTestDb().insert(organizationUsers).values({ userId: user.id, orgId: org.id, roleId, siteIds });
    } else {
      await getTestDb().insert(partnerUsers).values({ userId: user.id, partnerId: partner.id, roleId, orgAccess: 'all' });
      if (scope === 'system') await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
    }
    const token = await createAccessToken({
      sub: user.id, email: user.email, roleId, orgId: scope === 'organization' ? org.id : null,
      partnerId: partner.id, scope, mfa: false, aep: 1, mep: 1, sid: randomUUID(),
    });
    return { token, id: user.id };
  }

  async function device(orgId: string, siteId: string) {
    const [row] = await getTestDb().insert(devices).values({
      orgId, siteId, agentId: randomUUID(), hostname: `host-${randomUUID()}`,
      osType: 'windows', osVersion: '11', architecture: 'x86_64', status: 'online', agentVersion: '0.0.0-test',
    }).returning();
    return row!;
  }
  const allowed = await device(org.id, siteA.id);
  const denied = await device(org.id, siteB.id);
  const other = await device(otherOrg.id, otherSite.id);
  const foreign = await device(foreignOrg.id, foreignSite.id);
  const [policy] = await getTestDb().insert(softwarePolicies).values({
    orgId: org.id, name: 'Site aggregate fixture', mode: 'audit', rules: { software: [] },
  }).returning();
  const [integration] = await getTestDb().insert(s1Integrations).values({
    partnerId: partner.id, name: 'Fixture integration', apiTokenEncrypted: 'unused-fixture',
    managementUrl: 'https://fixture.sentinelone.net', isActive: true,
  }).returning();
  await getTestDb().insert(s1OrgMappings).values([org, otherOrg].map((o) => ({
    partnerId: partner.id, integrationId: integration!.id, orgId: o.id, s1SiteId: randomUUID(),
  })));

  async function facts(deviceId: string | null, orgId = org.id, threatCount = 2) {
    if (deviceId) await getTestDb().insert(softwareComplianceStatus).values({
      deviceId, policyId: policy!.id, status: 'violation', lastChecked: new Date(),
    });
    await getTestDb().insert(s1Agents).values({
      integrationId: integration!.id, orgId, deviceId, s1AgentId: randomUUID(), infected: true, threatCount,
    });
    await getTestDb().insert(s1Threats).values({
      integrationId: integration!.id, orgId, deviceId, s1ThreatId: randomUUID(), status: 'active', severity: 'high',
    });
    await getTestDb().insert(s1Actions).values({ orgId, deviceId, action: 'isolate', status: 'queued' });
  }
  await facts(allowed.id);
  const restricted = await principal('organization', [siteA.id]);
  return { partner, foreignPartner, org, otherOrg, foreignOrg, siteA, siteB, allowed, denied, other, foreign,
    role, policy: policy!, integration: integration!, restricted, principal, facts, device };
}

describe('RMM-QA-221 site-scoped aggregate acceptance', () => {
  beforeEach(() => clearPermissionCache());

  it('uses an unprivileged application connection', async () => {
    const rows = await getAppDb().execute(sql`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(rows[0]).toMatchObject({ name: 'breeze_app', rolsuper: false, rolbypassrls: false });
  });

  it('denied-site and unmapped facts cannot change any summary or sibling list', async () => {
    const f = await fixture();
    const beforeSoftware = await read(overviewPath, f.restricted.token);
    const beforeSecurity = (await read(statusPath, f.restricted.token)).summary;
    expect(beforeSoftware).toEqual({ total: 1, compliant: 0, violations: 1, unknown: 0 });
    expect(beforeSecurity).toEqual({ totalAgents: 1, mappedDevices: 1, infectedAgents: 1, activeThreats: 1,
      highOrCriticalThreats: 1, pendingActions: 1, reportedThreatCount: 2 });
    await f.facts(f.denied.id, f.org.id, 100);
    await f.facts(null, f.org.id, 200);
    await f.facts(f.other.id, f.otherOrg.id, 300);
    expect(await read(overviewPath, f.restricted.token)).toEqual(beforeSoftware);
    expect((await read(statusPath, f.restricted.token)).summary).toEqual(beforeSecurity);
    const violations = await read('/software-policies/violations', f.restricted.token);
    expect(violations.data.map((row: { device: { id: string } }) => row.device.id)).toEqual([f.allowed.id]);
    const threats = await read(threatsPath, f.restricted.token);
    expect(threats.pagination.total).toBe(beforeSecurity.activeThreats);
    expect(threats.data.map((row: { deviceId: string }) => row.deviceId)).toEqual([f.allowed.id]);
    // Positive control: all hidden facts really exist and unrestricted org reads see them.
    const unrestricted = await f.principal('organization', null);
    expect((await read(overviewPath, unrestricted.token)).total).toBe(2);
    expect((await read(statusPath, unrestricted.token)).summary).toEqual({
      totalAgents: 3, mappedDevices: 2, infectedAgents: 3, activeThreats: 3,
      highOrCriticalThreats: 3, pendingActions: 3, reportedThreatCount: 302,
    });
  });

  it('empty live allowlists return zero summaries and no unmapped threats', async () => {
    const f = await fixture();
    await f.facts(f.denied.id);
    await f.facts(null);
    const empty = await f.principal('organization', []);
    expect(await read(overviewPath, empty.token)).toEqual(zeroSoftware);
    expect((await read(statusPath, empty.token)).summary).toEqual(zeroSecurity);
    expect((await read(threatsPath, empty.token)).data).toEqual([]);
    expect((await read('/software-policies/violations', empty.token)).total).toBe(0);
  });

  it('software overview keeps distinct-device worst status semantics within allowed sites', async () => {
    const f = await fixture();
    const [secondPolicy] = await getTestDb().insert(softwarePolicies).values({
      orgId: f.org.id, name: 'Second policy', mode: 'audit', rules: { software: [] },
    }).returning();
    const compliant = await f.device(f.org.id, f.siteA.id);
    const unknown = await f.device(f.org.id, f.siteA.id);
    await getTestDb().insert(softwareComplianceStatus).values([
      { deviceId: f.allowed.id, policyId: secondPolicy!.id, status: 'violation', lastChecked: new Date() },
      { deviceId: compliant.id, policyId: f.policy.id, status: 'compliant', lastChecked: new Date() },
      { deviceId: unknown.id, policyId: f.policy.id, status: 'unknown', lastChecked: new Date() },
      { deviceId: unknown.id, policyId: secondPolicy!.id, status: 'compliant', lastChecked: new Date() },
    ]);
    await f.facts(f.denied.id);
    expect(await read(overviewPath, f.restricted.token)).toEqual({ total: 3, compliant: 1, violations: 1, unknown: 1 });
    const violations = await read('/software-policies/violations', f.restricted.token);
    expect(violations.total).toBe(2);
    expect(new Set(violations.data.map((row: { device: { id: string } }) => row.device.id))).toEqual(new Set([f.allowed.id]));
  });

  it.each([overviewPath, statusPath, threatsPath])('requires authentication and devices:read on %s', async (path) => {
    const f = await fixture();
    expect((await app.request(path)).status).toBe(401);
    const denied = await f.principal('organization', null, false);
    expect((await request(path, denied.token)).status).toBe(403);
  });

  it('fresh membership scope changes affect subsequent reads using the same token', async () => {
    const f = await fixture();
    await f.facts(f.denied.id, f.org.id, 19);
    expect((await read(statusPath, f.restricted.token)).summary.reportedThreatCount).toBe(2);
    await getTestDb().update(organizationUsers).set({ siteIds: [f.siteB.id] }).where(eq(organizationUsers.userId, f.restricted.id));
    await clearPermissionCache(f.restricted.id);
    expect((await read(statusPath, f.restricted.token)).summary.reportedThreatCount).toBe(19);
    expect((await read(threatsPath, f.restricted.token)).data[0].deviceId).toBe(f.denied.id);
    await getTestDb().update(organizationUsers).set({ siteIds: [] }).where(eq(organizationUsers.userId, f.restricted.id));
    await clearPermissionCache(f.restricted.id);
    expect(await read(overviewPath, f.restricted.token)).toEqual(zeroSoftware);
    expect((await read(statusPath, f.restricted.token)).summary).toEqual(zeroSecurity);
  });

  it.each(['partner', 'system'] as const)('preserves unrestricted %s roles with devices:read via wildcard grant', async (scope) => {
    const f = await fixture();
    await f.facts(f.denied.id);
    await f.facts(null);
    await f.facts(f.other.id, f.otherOrg.id);
    // A selected partner status must not absorb another partner's actions,
    // even when a system reader is entitled to see both partners separately.
    await getTestDb().insert(s1Actions).values({ orgId: f.foreignOrg.id, deviceId: f.foreign.id, action: 'isolate', status: 'queued' });
    const principal = await f.principal(scope, null);
    const query = `?partnerId=${f.partner.id}`;
    const status = await read(statusPath + query, principal.token);
    expect(status.summary.totalAgents).toBe(4);
    expect(status.summary.pendingActions).toBe(4);
    expect((await read(threatsPath + query, principal.token)).pagination.total).toBe(4);
    expect((await read(overviewPath, principal.token)).total).toBe(3);
    expect((await read(statusPath + query + `&orgId=${f.org.id}`, principal.token)).summary.totalAgents).toBe(3);
  });

  it('partner members using organization context inherit the live restricted membership', async () => {
    const f = await fixture();
    await f.facts(f.denied.id);
    const partner = await f.principal('partner', null);
    await getTestDb().insert(organizationUsers).values({
      userId: partner.id, orgId: f.org.id, roleId: f.role.id, siteIds: [f.siteA.id],
    });
    const token = await createAccessToken({
      sub: partner.id, email: 'partner@example.com', roleId: f.role.id,
      orgId: f.org.id, partnerId: f.partner.id, scope: 'organization',
      mfa: false, aep: 1, mep: 1, sid: randomUUID(),
    });
    expect((await read(statusPath, token)).summary.totalAgents).toBe(1);
    expect((await read(overviewPath, token)).total).toBe(1);
    expect((await read(threatsPath, token)).pagination.total).toBe(1);
  });

  it.each(['partner', 'system'] as const)('requires a real devices:read grant for %s status', async (scope) => {
    const f = await fixture();
    const denied = await f.principal(scope, null, false);
    expect((await request(`${statusPath}?partnerId=${f.partner.id}`, denied.token)).status).toBe(403);
  });

  it('a partner custom role with only devices:read can read summaries without an org grant', async () => {
    const f = await fixture();
    const reader = await f.principal('partner', null, true, true);
    expect((await read(statusPath, reader.token)).summary.totalAgents).toBe(1);
    expect((await read(overviewPath, reader.token)).total).toBe(1);
    expect((await read(threatsPath, reader.token)).pagination.total).toBe(1);
  });

  it('moving a device to a denied site immediately removes its existing facts', async () => {
    const f = await fixture();
    expect((await read(statusPath, f.restricted.token)).summary.totalAgents).toBe(1);
    await getTestDb().update(devices).set({ siteId: f.siteB.id }).where(eq(devices.id, f.allowed.id));
    expect((await read(statusPath, f.restricted.token)).summary).toEqual(zeroSecurity);
    expect(await read(overviewPath, f.restricted.token)).toEqual(zeroSoftware);
    expect((await read(threatsPath, f.restricted.token)).data).toEqual([]);
  });

  it('unmapped organization status does not expose partner integration metadata', async () => {
    const f = await fixture();
    await getTestDb().delete(s1OrgMappings).where(eq(s1OrgMappings.orgId, f.org.id));
    const status = await read(statusPath, f.restricted.token);
    expect(status.integration).toBeNull();
    expect(status.summary).toEqual(zeroSecurity);
  });

  it('rejects foreign org/partner and denied explicit device selectors', async () => {
    const f = await fixture();
    for (const path of [statusPath, threatsPath]) {
      expect((await request(`${path}?orgId=${f.foreignOrg.id}`, f.restricted.token)).status).toBe(403);
    }
    expect((await request(`${statusPath}?partnerId=${f.foreignPartner.id}`, f.restricted.token)).status).toBe(403);
    expect((await request(`${threatsPath}?deviceId=${f.denied.id}`, f.restricted.token)).status).toBe(403);
    expect((await request(`${threatsPath}?deviceId=${f.allowed.id}`, f.restricted.token)).status).toBe(200);
    const partner = await f.principal('partner', null);
    expect((await request(`${statusPath}?orgId=${f.foreignOrg.id}`, partner.token)).status).toBe(403);
  });
});
