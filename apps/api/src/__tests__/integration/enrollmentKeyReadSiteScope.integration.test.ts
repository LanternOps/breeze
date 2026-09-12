/**
 * Real bearer/PostgreSQL coverage for enrollment-key read site visibility.
 * Requests use the production auth middleware and `breeze_app`; fixture writes
 * use the privileged integration connection. No public possession code is
 * redeemed by this suite.
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
import {
  enrollmentKeys,
  installerBootstrapTokens,
  organizationUsers,
} from '../../db/schema';
import { enrollmentKeyRoutes } from '../../routes/enrollmentKeys';
import { clearPermissionCache } from '../../services/permissions';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app(): Hono {
  const instance = new Hono();
  instance.route('/enrollment-keys', enrollmentKeyRoutes);
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

describe('GET /enrollment-keys site scope — real bearer/PostgreSQL', () => {
  runDb('filters rows, totals, pagination, capacity and detail by the stored current site', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'organizations', action: 'read' }],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'Hidden key site' });
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id, name: 'Foreign key site' });
    const suffix = randomUUID();
    const database = getTestDb();
    const [allowed, nullSite, hidden, foreign] = await database.insert(enrollmentKeys).values([
      {
        orgId: env.organization.id,
        siteId: env.site.id,
        name: `allowed-${suffix}`,
        key: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        keySecretHash: 'a'.repeat(64),
        maxUsage: 7,
        createdAt: new Date('2026-09-06T12:00:00Z'),
      },
      {
        orgId: env.organization.id,
        siteId: null,
        name: `null-${suffix}`,
        key: randomUUID().replaceAll('-', '').padEnd(64, '1'),
        maxUsage: 3,
        createdAt: new Date('2026-09-06T12:01:00Z'),
      },
      {
        orgId: env.organization.id,
        siteId: hiddenSite.id,
        name: `hidden-newest-${suffix}`,
        key: randomUUID().replaceAll('-', '').padEnd(64, '2'),
        maxUsage: 9,
        createdAt: new Date('2026-09-06T12:02:00Z'),
      },
      {
        orgId: foreignOrg.id,
        siteId: foreignSite.id,
        name: `foreign-${suffix}`,
        key: randomUUID().replaceAll('-', '').padEnd(64, '3'),
        maxUsage: 11,
        createdAt: new Date('2026-09-06T12:03:00Z'),
      },
    ]).returning({ id: enrollmentKeys.id });

    await database.insert(installerBootstrapTokens).values([
      {
        token: `allowed-capacity-${suffix}`,
        orgId: env.organization.id,
        parentEnrollmentKeyId: allowed!.id,
        siteId: env.site.id,
        maxUsage: 5,
        consumedCount: 2,
        expiresAt: new Date(Date.now() + 60_000),
        usageKind: 'capacity',
      },
      {
        token: `hidden-capacity-${suffix}`,
        orgId: env.organization.id,
        parentEnrollmentKeyId: hidden!.id,
        siteId: hiddenSite.id,
        maxUsage: 50,
        consumedCount: 40,
        expiresAt: new Date(Date.now() + 60_000),
        usageKind: 'capacity',
      },
    ]);

    const get = (path: string) => app().request(`/enrollment-keys${path}`, {
      headers: { Authorization: `Bearer ${env.token}` },
    });

    await setSiteCeiling(env, [env.site.id]);
    const selectedResponse = await get('?limit=1');
    expect(selectedResponse.status).toBe(200);
    const selected = await selectedResponse.json() as any;
    expect(selected.pagination.total).toBe(1);
    expect(selected.data.map((row: any) => row.id)).toEqual([allowed!.id]);
    expect(selected.data[0].installerTokens).toEqual({
      consumed: 2,
      max: 5,
      liveConsumed: 2,
      liveMax: 5,
    });
    expect(selected.data[0].key).toBeUndefined();
    expect(selected.data[0].keySecretHash).toBeUndefined();

    const allowedDetail = await get(`/${allowed!.id}`);
    expect(allowedDetail.status).toBe(200);
    expect((await allowedDetail.json() as any).installerTokens.max).toBe(5);
    for (const id of [hidden!.id, nullSite!.id, foreign!.id, randomUUID()]) {
      const denied = await get(`/${id}`);
      expect(denied.status).toBe(404);
      await expect(denied.json()).resolves.toEqual({ error: 'Enrollment key not found' });
    }

    await setSiteCeiling(env, []);
    const empty = await get('');
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({
      data: [],
      pagination: { total: 0 },
    });

    await setSiteCeiling(env, null);
    const unrestricted = await get('');
    expect(unrestricted.status).toBe(200);
    expect((await unrestricted.json() as any).pagination.total).toBe(3);

    await setSiteCeiling(env, [env.site.id]);
    await database.update(enrollmentKeys).set({ siteId: hiddenSite.id }).where(eq(enrollmentKeys.id, allowed!.id));
    expect((await get(`/${allowed!.id}`)).status).toBe(404);
    await expect((await get('')).json()).resolves.toMatchObject({ data: [], pagination: { total: 0 } });
  });
});
