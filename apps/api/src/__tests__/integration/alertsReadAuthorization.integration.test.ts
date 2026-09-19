import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { alertRoutes } from '../../routes/alerts';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgents, aiAgentRuns, aiAlertVerdicts, alertCorrelationGroups, alertCorrelationMembers, alerts, devices, escalationPolicies, organizationUsers, partnerUsers } from '../../db/schema';
import { clearPermissionCache } from '../../services/permissions';
import { createIntegrationTestClient, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';

const app = new Hono().route('/alerts', alertRoutes);
const read = { resource: 'alerts', action: 'read' };
const ticketRead = { resource: 'tickets', action: 'read' };

async function fixture(scope: 'organization' | 'partner', allowed = true, siteScope?: 'one' | 'empty') {
  const client = await createIntegrationTestClient(app, { scope, rolePermissions: allowed ? [read, ticketRead] : [ticketRead] });
  const { organization: org, site, user, partner } = client.env;
  const testDb = getTestDb();
  const siteB = await createSite({ orgId: org.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const otherSite = await createSite({ orgId: otherOrg.id });
  const rows = await testDb.insert(devices).values([site.id, siteB.id].map((siteId) => ({
    orgId: org.id, siteId, agentId: crypto.randomUUID(), hostname: 'Alert test device',
    osType: 'windows' as const, osVersion: '11', architecture: 'x86_64', agentVersion: 'test',
  }))).returning();
  const [otherDevice] = await testDb.insert(devices).values({ orgId: otherOrg.id, siteId: otherSite.id, agentId: crypto.randomUUID(), hostname: 'Other organization', osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: 'test' }).returning();
  const alertRows = await testDb.insert(alerts).values([
    { orgId: org.id, deviceId: rows[0]!.id, severity: 'critical' as const, status: 'active' as const, title: 'Allowed critical', message: 'Allowed' },
    { orgId: org.id, deviceId: rows[0]!.id, severity: 'high' as const, status: 'acknowledged' as const, title: 'Allowed acknowledged', message: 'Allowed' },
    { orgId: org.id, deviceId: rows[1]!.id, severity: 'critical' as const, status: 'active' as const, title: 'Other site', message: 'Other site' },
    { orgId: otherOrg.id, deviceId: otherDevice!.id, severity: 'critical' as const, status: 'active' as const, title: 'Other organization', message: 'Other organization' },
  ]).returning();
  await testDb.insert(escalationPolicies).values({ orgId: org.id, name: 'Organization policy', steps: [] });
  if (scope === 'organization' && siteScope) {
    await testDb.update(organizationUsers).set({ siteIds: siteScope === 'one' ? [site.id] : [] }).where(eq(organizationUsers.userId, user.id));
  }
  if (scope === 'partner') {
    await testDb.update(partnerUsers).set({ orgAccess: 'selected', orgIds: [org.id] }).where(eq(partnerUsers.userId, user.id));
  }
  await clearPermissionCache(user.id);
  return { client, alertRows, org, otherOrg, site, siteB };
}

function paths(f: Awaited<ReturnType<typeof fixture>>) {
  return ['/alerts', '/alerts/summary', `/alerts/${f.alertRows[0]!.id}`, '/alerts/policies', `/alerts/${f.alertRows[0]!.id}/tickets`];
}

describe('alert read authorization with real JWT, custom roles and breeze_app', () => {
  it('uses the unprivileged application database role', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user`));
    expect(rows[0]).toMatchObject({ name: 'breeze_app', rolsuper: false, rolbypassrls: false });
  });

  it.each(['organization', 'partner'] as const)('%s custom role without alerts:read denies every read with no metadata or mutation', async (scope) => {
    const f = await fixture(scope, false);
    const before = await getTestDb().select().from(alerts);
    for (const path of paths(f)) {
      const response = await f.client.get(`${path}?orgId=${f.org.id}`);
      expect(response.status, path).toBe(403);
      expect(await response.text()).toBe('Permission denied');
    }
    expect(await getTestDb().select().from(alerts)).toEqual(before);
  });

  it.each(['organization', 'partner'] as const)('%s reader can access all read routes, including policies before the detail catch-all', async (scope) => {
    const f = await fixture(scope);
    for (const path of paths(f)) expect((await f.client.get(`${path}?orgId=${f.org.id}`)).status, path).toBe(200);
    for (const resource of ['rules', 'channels']) expect((await f.client.get(`/alerts/${resource}?orgId=${f.org.id}`)).status).toBe(200);
    expect((await f.client.get(`/alerts/${f.alertRows[3]!.id}`)).status).toBe(404);
  });

  it.each(['one', 'empty'] as const)('list, detail and every summary breakdown agree for %s site allowlist', async (siteScope) => {
    const f = await fixture('organization', true, siteScope);
    const expected = siteScope === 'one' ? [f.alertRows[0]!.id, f.alertRows[1]!.id] : [];
    const list = await (await f.client.get('/alerts')).json();
    expect(list.data.map((a: { id: string }) => a.id).sort()).toEqual([...expected].sort());
    expect(list.pagination.total).toBe(expected.length);
    const summary = await (await f.client.get('/alerts/summary')).json();
    expect(summary).toEqual({ total: expected.length,
      bySeverity: { critical: siteScope === 'one' ? 1 : 0, high: 0, medium: 0, low: 0, info: 0 },
      byStatus: { active: siteScope === 'one' ? 1 : 0, acknowledged: siteScope === 'one' ? 1 : 0, resolved: 0, suppressed: 0, dismissed: 0 },
    });
    for (const row of f.alertRows) {
      expect((await f.client.get(`/alerts/${row.id}`)).status).toBe(expected.includes(row.id) ? 200 : 404);
      expect((await f.client.get(`/alerts/${row.id}/tickets`)).status).toBe(expected.includes(row.id) ? 200 : 404);
    }
    const policies = await (await f.client.get('/alerts/policies')).json();
    expect(policies.data.map((p: { name: string }) => p.name)).toEqual(['Organization policy']);
  });

  it('partner fleet summary includes both sites but respects selected organizations', async () => {
    const f = await fixture('partner');
    for (const suffix of ['', `?orgId=${f.org.id}`]) {
      const summary = await (await f.client.get(`/alerts/summary${suffix}`)).json();
      expect(summary.total).toBe(3);
      expect(summary.bySeverity.critical).toBe(2);
    }
    expect((await f.client.get(`/alerts/summary?orgId=${f.otherOrg.id}`)).status).toBe(403);
  });

  it('site revocation takes effect on subsequent reads', async () => {
    const f = await fixture('organization');
    expect((await (await f.client.get('/alerts/summary')).json()).total).toBe(3);
    await getTestDb().update(organizationUsers).set({ siteIds: [] }).where(eq(organizationUsers.userId, f.client.env.user.id));
    await clearPermissionCache(f.client.env.user.id);
    expect((await (await f.client.get('/alerts/summary')).json()).total).toBe(0);
    expect((await f.client.get(`/alerts/${f.alertRows[0]!.id}`)).status).toBe(404);
  });

  it('restricted readers do not receive or filter by mixed-site group metadata or verdict rationale', async () => {
    const f = await fixture('organization', true, 'one');
    const testDb = getTestDb();
    const [group] = await testDb.insert(alertCorrelationGroups).values({
      orgId: f.org.id, groupKey: crypto.randomUUID(), memberCount: 2, noiseReductionPercent: 50,
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    }).returning();
    await testDb.insert(alertCorrelationMembers).values([f.alertRows[0]!, f.alertRows[2]!].map((a) => ({ orgId: f.org.id, groupId: group!.id, alertId: a.id })));
    const [agent] = await testDb.insert(aiAgents).values({ orgId: f.org.id, kind: 'triage', name: 'Read scope fixture', createdBy: f.client.env.user.id }).returning();
    const [run] = await testDb.insert(aiAgentRuns).values({ agentId: agent!.id, orgId: f.org.id, profile: 'verdict', triggerKind: 'manual', dedupeKey: crypto.randomUUID(), modeAtStart: 'shadow', policySnapshot: { schemaVersion: 1 } as never }).returning();
    await testDb.insert(aiAlertVerdicts).values({ orgId: f.org.id, runId: run!.id, correlationGroupId: group!.id, classification: 'duplicate_of_group', confidence: '0.95', rationale: 'Broader group rationale' });
    const list = await (await f.client.get('/alerts?hideAiNoise=true')).json();
    expect(list.pagination.total).toBe(2);
    const visible = list.data.find((a: { id: string }) => a.id === f.alertRows[0]!.id);
    expect(visible).toMatchObject({ aiVerdict: null, correlationGroupId: null, correlationMemberCount: 0 });
    const detail = await (await f.client.get(`/alerts/${f.alertRows[0]!.id}`)).json();
    expect(detail.aiVerdict).toBeNull();
    await testDb.update(organizationUsers).set({ siteIds: null }).where(eq(organizationUsers.userId, f.client.env.user.id));
    await clearPermissionCache(f.client.env.user.id);
    const unrestricted = await (await f.client.get(`/alerts/${f.alertRows[0]!.id}`)).json();
    expect(unrestricted.aiVerdict.rationale).toBe('Broader group rationale');
    expect((await (await f.client.get('/alerts?hideAiNoise=true')).json()).pagination.total).toBe(1);
    await testDb.insert(aiAlertVerdicts).values({ orgId: f.org.id, runId: run!.id, alertId: f.alertRows[0]!.id, classification: 'recurring_pattern', confidence: '0.95', rationale: 'Individual alert rationale' });
    await testDb.update(organizationUsers).set({ siteIds: [f.site.id] }).where(eq(organizationUsers.userId, f.client.env.user.id));
    await clearPermissionCache(f.client.env.user.id);
    const individual = await (await f.client.get(`/alerts/${f.alertRows[0]!.id}`)).json();
    expect(individual.aiVerdict.rationale).toBe('Individual alert rationale');
    expect((await (await f.client.get('/alerts?hideAiNoise=true')).json()).pagination.total).toBe(1);
  });

  it('moving a device out of an allowed site changes list, summary and detail together', async () => {
    const f = await fixture('organization', true, 'one');
    expect((await (await f.client.get('/alerts/summary')).json()).total).toBe(2);
    await getTestDb().update(devices).set({ siteId: f.siteB.id }).where(eq(devices.id, f.alertRows[0]!.deviceId));
    expect((await (await f.client.get('/alerts/summary')).json()).total).toBe(0);
    expect((await (await f.client.get('/alerts')).json()).pagination.total).toBe(0);
    expect((await f.client.get(`/alerts/${f.alertRows[0]!.id}`)).status).toBe(404);
  });
});
