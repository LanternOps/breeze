/**
 * Device aggregates on the analytics dashboard (`GET /analytics/executive-summary`
 * status counts + weekly enrollment trend, `GET /analytics/os-distribution`)
 * follow the caller's current site list under real JWT/RBAC and the
 * unprivileged `breeze_app` connection.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { devices, organizationUsers } from '../../db/schema';
import { analyticsRoutes } from '../../routes/analytics';
import { clearPermissionCache } from '../../services/permissions';

const app = new Hono();
app.route('/analytics', analyticsRoutes);

async function get(env: TestEnvironment, path: string) {
  const response = await app.request(`/analytics${path}`, {
    headers: { Authorization: `Bearer ${env.token}` },
  });
  const body = (await response.json()) as any;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

const trendTotal = (body: any): number =>
  body.data.trendData.reduce((sum: number, row: { value: number }) => sum + row.value, 0);

async function setSiteList(env: TestEnvironment, siteIds: string[] | null) {
  await getTestDb()
    .update(organizationUsers)
    .set({ siteIds })
    .where(and(
      eq(organizationUsers.userId, env.user.id),
      eq(organizationUsers.orgId, env.organization.id),
    ));
  await clearPermissionCache(env.user.id);
}

describe('analytics device aggregates follow the caller\'s site list', () => {
  it('filters by each device\'s current site before counting or grouping', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'read' }],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'hidden-site' });
    const suffix = randomUUID().slice(0, 8);
    const enrolledAt = new Date();
    const base = {
      orgId: env.organization.id,
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      enrolledAt,
    };

    const inserted = await getTestDb()
      .insert(devices)
      .values([
        {
          ...base, siteId: env.site.id, agentId: `visible-${suffix}`, hostname: `visible-${suffix}`,
          osType: 'windows', osVersion: '11', status: 'online',
        },
        {
          ...base, siteId: hiddenSite.id, agentId: `hidden-${suffix}`, hostname: `hidden-${suffix}`,
          osType: 'linux', osVersion: 'Ubuntu', status: 'offline',
        },
        {
          ...base, siteId: env.site.id, agentId: `retired-${suffix}`, hostname: `retired-${suffix}`,
          osType: 'macos', osVersion: '15', status: 'decommissioned',
        },
        {
          ...base, siteId: env.site.id, agentId: `ephemeral-${suffix}`, hostname: `ephemeral-${suffix}`,
          osType: 'linux', osVersion: 'Alpine', status: 'online', isEphemeral: true,
        },
      ])
      .returning({ id: devices.id, agentId: devices.agentId });
    const visibleId = inserted.find((row) => row.agentId.startsWith('visible-'))!.id;

    // Unrestricted: every live, non-ephemeral device in the org. Enrollment
    // history also counts the decommissioned device.
    const unrestricted = await get(env, '/executive-summary?periodType=monthly');
    expect(unrestricted.data.devices).toEqual({ total: 2, online: 1, offline: 1, pending: 0 });
    expect(trendTotal(unrestricted)).toBe(3);
    expect((await get(env, '/os-distribution')).map((row: any) => row.name).sort())
      .toEqual(['linux Ubuntu', 'windows 11']);

    // Restricted to the fixture's own site: the hidden-site device is gone
    // from every count and group.
    await setSiteList(env, [env.site.id]);
    const restricted = await get(env, '/executive-summary');
    expect(restricted.data.devices).toEqual({ total: 1, online: 1, offline: 0, pending: 0 });
    expect(trendTotal(restricted)).toBe(2);
    expect(await get(env, '/os-distribution')).toEqual([{ name: 'windows 11', value: 1 }]);

    // Visibility follows the device's CURRENT site: moving it out hides it.
    await getTestDb().update(devices).set({ siteId: hiddenSite.id }).where(eq(devices.id, visibleId));
    const afterMove = await get(env, '/executive-summary');
    expect(afterMove.data.devices.total).toBe(0);
    expect(trendTotal(afterMove)).toBe(1);
    expect(await get(env, '/os-distribution')).toEqual([]);

    // An empty site list sees nothing at all.
    await setSiteList(env, []);
    const empty = await get(env, '/executive-summary');
    expect(empty.data.devices).toEqual({ total: 0, online: 0, offline: 0, pending: 0 });
    expect(empty.data.trendData).toEqual([]);
    expect(await get(env, '/os-distribution')).toEqual([]);

    // Clearing the restriction restores the org-wide view.
    await setSiteList(env, null);
    const cleared = await get(env, '/executive-summary');
    expect(cleared.data.devices.total).toBe(2);
    expect(trendTotal(cleared)).toBe(3);
  });
});
