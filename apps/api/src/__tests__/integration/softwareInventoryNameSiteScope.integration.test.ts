/**
 * Real bearer/PostgreSQL coverage for current-site software-name visibility.
 * Requests use the production auth middleware and unprivileged application
 * role; fixture writes use the privileged integration connection.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { getTestDb } from './setup';
import {
  createOrganization,
  createPartner,
  createSite,
  setupTestEnvironment,
  type TestEnvironment,
} from './db-utils';
import { devices, organizationUsers, softwareInventory } from '../../db/schema';
import { softwareInventoryRoutes } from '../../routes/softwareInventory';
import { clearPermissionCache } from '../../services/permissions';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app(): Hono {
  const instance = new Hono();
  instance.route('/software-inventory', softwareInventoryRoutes);
  return instance;
}

async function setSiteCeiling(env: TestEnvironment, siteIds: string[] | null): Promise<void> {
  await getTestDb()
    .update(organizationUsers)
    .set({ siteIds })
    .where(and(
      eq(organizationUsers.userId, env.user.id),
      eq(organizationUsers.orgId, env.organization.id),
    ));
  await clearPermissionCache(env.user.id);
}

describe('GET /software-inventory/names current-site scope — real bearer/PostgreSQL', () => {
  runDb('filters before DISTINCT/LIMIT and follows current device ownership and site', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'read' }],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'Hidden inventory site' });
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id, name: 'Foreign inventory site' });
    const suffix = randomUUID().slice(0, 8);
    const database = getTestDb();

    const inserted = await database.insert(devices).values([
      {
        orgId: env.organization.id, siteId: env.site.id, agentId: `software-visible-a-${suffix}`,
        hostname: `software-visible-a-${suffix}`, osType: 'linux', osVersion: '1',
        architecture: 'x64', agentVersion: '1', status: 'online',
      },
      {
        orgId: env.organization.id, siteId: env.site.id, agentId: `software-visible-b-${suffix}`,
        hostname: `software-visible-b-${suffix}`, osType: 'linux', osVersion: '1',
        architecture: 'x64', agentVersion: '1', status: 'online',
      },
      {
        orgId: env.organization.id, siteId: hiddenSite.id, agentId: `software-hidden-${suffix}`,
        hostname: `software-hidden-${suffix}`, osType: 'linux', osVersion: '1',
        architecture: 'x64', agentVersion: '1', status: 'online',
      },
      {
        orgId: env.organization.id, siteId: env.site.id, agentId: `software-ephemeral-${suffix}`,
        hostname: `software-ephemeral-${suffix}`, osType: 'linux', osVersion: '1',
        architecture: 'x64', agentVersion: '1', status: 'online', isEphemeral: true,
      },
      {
        orgId: foreignOrg.id, siteId: foreignSite.id, agentId: `software-foreign-${suffix}`,
        hostname: `software-foreign-${suffix}`, osType: 'linux', osVersion: '1',
        architecture: 'x64', agentVersion: '1', status: 'online',
      },
    ]).returning({ id: devices.id });
    const [visibleA, visibleB, hidden, ephemeral, foreign] = inserted;
    const hiddenName = `a-hidden-${suffix}`;
    const ephemeralName = `b-ephemeral-${suffix}`;
    const visibleName = `c-visible-${suffix}`;
    const moveOnlyName = `d-move-${suffix}`;
    const foreignName = `e-foreign-${suffix}`;

    await database.insert(softwareInventory).values([
      { orgId: env.organization.id, deviceId: hidden!.id, name: hiddenName },
      { orgId: env.organization.id, deviceId: ephemeral!.id, name: ephemeralName },
      { orgId: env.organization.id, deviceId: visibleA!.id, name: visibleName },
      { orgId: env.organization.id, deviceId: visibleB!.id, name: visibleName },
      { orgId: env.organization.id, deviceId: visibleA!.id, name: moveOnlyName },
      { orgId: foreignOrg.id, deviceId: foreign!.id, name: foreignName },
    ]);

    const get = (query: string) => app().request(`/software-inventory/names?${query}`, {
      headers: { Authorization: `Bearer ${env.token}` },
    });

    await setSiteCeiling(env, [env.site.id]);
    const selected = await get(`q=${suffix}&limit=50`);
    expect(selected.status, await selected.clone().text()).toBe(200);
    await expect(selected.json()).resolves.toEqual({ data: [visibleName, moveOnlyName] });

    // Hidden and ephemeral names sort first, so limit=1 proves the current-site
    // predicate runs before ORDER/LIMIT rather than filtering a fetched page.
    const firstVisible = await get(`q=${suffix}&limit=1`);
    await expect(firstVisible.json()).resolves.toEqual({ data: [visibleName] });

    await setSiteCeiling(env, []);
    await expect((await get(`q=${suffix}`)).json()).resolves.toEqual({ data: [] });

    await setSiteCeiling(env, null);
    const unrestricted = await get(`q=${suffix}&limit=50`);
    await expect(unrestricted.json()).resolves.toEqual({
      data: [hiddenName, visibleName, moveOnlyName],
    });

    await setSiteCeiling(env, [env.site.id]);
    await database.update(devices).set({ siteId: hiddenSite.id }).where(eq(devices.id, visibleA!.id));
    const afterMove = await get(`q=${suffix}&limit=50`);
    await expect(afterMove.json()).resolves.toEqual({ data: [visibleName] });
  });
});
