/**
 * Real request-context coverage for the v2 topology authorization boundary.
 * The private fixture routes exist only in this test; M0 exposes no execution
 * endpoint and grants no topology:execute permission.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { organizationUsers } from '../../db/schema';
import { createTopologyRoutes } from '../../routes/topology';
import { requireTopologySiteCapability } from '../../routes/topology/middleware';
import { clearPermissionCache } from '../../services/permissions';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const READ_GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'devices', action: 'read' },
];

function buildApp(capability: 'read' | 'execute'): Hono {
  const app = new Hono();
  const routes = createTopologyRoutes();
  routes.get(
    '/sites/:siteId/__access-fixture',
    requireTopologySiteCapability(capability),
    (c) => c.json({ scope: c.get('topologyContext').scope }),
  );
  app.route('/topology', routes);
  return app;
}

async function restrictUserToSites(env: TestEnvironment, siteIds: string[]): Promise<void> {
  await getTestDb()
    .update(organizationUsers)
    .set({ siteIds })
    .where(and(
      eq(organizationUsers.userId, env.user.id),
      eq(organizationUsers.orgId, env.organization.id),
    ));
  await clearPermissionCache(env.user.id);
}

describe('topology access boundary — live auth and request RLS', () => {
  runDb('same-org RLS visibility does not override the user site ceiling', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: READ_GRANTS,
    });
    const secondSite = await createSite({ orgId: env.organization.id });
    const app = buildApp('read');
    const path = `/topology/sites/${secondSite.id}/__access-fixture`;

    // Both sites are visible through org-scoped RLS before the application
    // ceiling is narrowed.
    const before = await app.request(path, {
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(before.status).toBe(200);

    await restrictUserToSites(env, [env.site.id]);

    const denied = await app.request(path, {
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({
      error: 'Topology site not found',
      code: 'topology_site_not_found',
    });
  });

  runDb('the M0 role grant set cannot pass the execute matrix', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        ...READ_GRANTS,
        { resource: 'topology', action: 'write' },
        { resource: 'devices', action: 'execute' },
      ],
    });

    const response = await buildApp('execute').request(
      `/topology/sites/${env.site.id}/__access-fixture`,
      { headers: { Authorization: `Bearer ${env.token}` } },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Topology permission denied',
      code: 'topology_permission_denied',
    });
  });
});
