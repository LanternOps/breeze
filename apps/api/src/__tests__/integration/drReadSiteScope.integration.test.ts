import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, drExecutions, drPlanGroups, drPlans, organizationUsers } from '../../db/schema';
import { drRoutes } from '../../routes/dr';
import { clearPermissionCache } from '../../services/permissions';
import { createSite, setupTestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('DR read site scope', () => {
  runDb('omits mixed/hidden resources and follows current device site moves', async () => {
    const env = await setupTestEnvironment({ scope: 'organization', rolePermissions: [{ resource: 'devices', action: 'read' }] });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'Hidden DR site' });
    const suffix = crypto.randomUUID().slice(0, 8);
    const seeded = await withSystemDbAccessContext(async () => {
      const deviceRows = await db.insert(devices).values([
        { orgId: env.organization.id, siteId: env.site.id, agentId: `dr-visible-${suffix}`, hostname: `visible-${suffix}`, osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: 'test' },
        { orgId: env.organization.id, siteId: hiddenSite.id, agentId: `dr-hidden-${suffix}`, hostname: `hidden-${suffix}`, osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: 'test' },
      ]).returning({ id: devices.id });
      const [visible, hidden] = deviceRows;
      const plans = await db.insert(drPlans).values([
        { orgId: env.organization.id, name: `Visible ${suffix}` },
        { orgId: env.organization.id, name: `Mixed ${suffix}` },
        { orgId: env.organization.id, name: `Empty ${suffix}` },
      ]).returning({ id: drPlans.id, name: drPlans.name });
      await db.insert(drPlanGroups).values([
        { orgId: env.organization.id, planId: plans[0]!.id, name: 'visible', devices: [visible!.id], restoreConfig: { marker: 'visible' } },
        { orgId: env.organization.id, planId: plans[1]!.id, name: 'mixed', devices: [visible!.id, hidden!.id], restoreConfig: { marker: 'hidden-secret' } },
      ]);
      const validResults = (id: string) => ({ plannedGroups: [{ id: 'g', deviceCount: 1 }], groupResults: [{ groupId: 'g', devices: [{ id, status: 'completed' }] }], queuedCommands: [], failedDispatches: [] });
      const executions = await db.insert(drExecutions).values([
        { orgId: env.organization.id, planId: plans[0]!.id, executionType: 'rehearsal', results: validResults(visible!.id), createdAt: new Date('2026-09-06T12:00:00Z'), authorizationPrincipalKind: 'unknown', authorizationState: 'quarantined_authorization_unknown', authorizationDenialCode: 'authorization_subject_unknown' },
        { orgId: env.organization.id, planId: plans[0]!.id, executionType: 'rehearsal', results: validResults(hidden!.id), createdAt: new Date('2026-09-06T12:01:00Z'), authorizationPrincipalKind: 'unknown', authorizationState: 'quarantined_authorization_unknown', authorizationDenialCode: 'authorization_subject_unknown' },
      ]).returning({ id: drExecutions.id });
      return { visible: visible!, hidden: hidden!, plans, executions };
    });
    const app = new Hono(); app.route('/dr', drRoutes);
    const get = async (path: string) => {
      const res = await app.request(`/dr${path}`, { headers: { Authorization: `Bearer ${env.token}` } });
      return { status: res.status, body: await res.json() as any };
    };

    expect((await get('/plans')).body.data).toHaveLength(3);
    expect((await get('/executions?limit=1')).body.data.map((e: any) => e.id)).toEqual([seeded.executions[1]!.id]);
    await withSystemDbAccessContext(() => db.update(organizationUsers).set({ siteIds: [env.site.id] }).where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id))));
    await clearPermissionCache(env.user.id);
    const list = await get('/plans');
    expect(list.body.data.map((p: any) => p.name).sort()).toEqual([`Empty ${suffix}`, `Visible ${suffix}`]);
    const mixed = await get(`/plans/${seeded.plans[1]!.id}`);
    expect(mixed.status).toBe(404);
    expect(JSON.stringify(mixed.body)).not.toContain('hidden-secret');
    const execs = await get('/executions');
    expect(execs.body.data.map((e: any) => e.id)).toEqual([seeded.executions[0]!.id]);
    const limitedExecs = await get('/executions?limit=1');
    expect(limitedExecs.body.data.map((e: any) => e.id)).toEqual([seeded.executions[0]!.id]);
    expect((await get(`/executions/${seeded.executions[1]!.id}`)).status).toBe(404);

    await withSystemDbAccessContext(() => db.update(devices).set({ siteId: hiddenSite.id }).where(eq(devices.id, seeded.visible.id)));
    expect((await get('/plans')).body.data.map((p: any) => p.name)).toEqual([`Empty ${suffix}`]);
    expect((await get(`/plans/${seeded.plans[0]!.id}`)).status).toBe(404);

    await withSystemDbAccessContext(() => db.update(organizationUsers).set({ siteIds: [] }).where(and(eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id))));
    await clearPermissionCache(env.user.id);
    expect((await get('/plans')).body.data).toEqual([]);
    expect((await get('/executions')).body.data).toEqual([]);
  });
});
