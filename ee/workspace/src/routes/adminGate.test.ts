import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { adminGate, type WorkspaceRouteEnv } from './adminGate';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

const ROUTES: Array<{
  method: string;
  path: string;
  grants: string[];
  mutation?: boolean;
}> = [
  { method: 'GET', path: '/sources', grants: ['workspace:read'] },
  { method: 'GET', path: '/sources/source-1', grants: ['workspace:read'] },
  { method: 'GET', path: '/sources/source-1/runs', grants: ['workspace:read'] },
  { method: 'POST', path: '/sources', grants: ['workspace:write', 'workspace:execute', 'devices:execute'], mutation: true },
  { method: 'PATCH', path: '/sources/source-1', grants: ['workspace:write', 'workspace:execute', 'devices:execute'], mutation: true },
  { method: 'DELETE', path: '/sources/source-1', grants: ['workspace:write', 'workspace:execute', 'devices:execute'], mutation: true },
  { method: 'PUT', path: '/sources/source-1/credential', grants: ['workspace:credentials', 'workspace:write', 'workspace:execute', 'devices:execute'], mutation: true },
  { method: 'DELETE', path: '/sources/source-1/credential', grants: ['workspace:credentials', 'workspace:write', 'workspace:execute', 'devices:execute'], mutation: true },
  { method: 'GET', path: '/content/status', grants: ['workspace:read'] },
  { method: 'GET', path: '/content/settings', grants: ['workspace:read'] },
  { method: 'GET', path: '/content/jobs', grants: ['workspace:read'] },
  { method: 'PUT', path: '/content/settings', grants: ['workspace:write'], mutation: true },
  { method: 'POST', path: '/content/ingest-run', grants: ['workspace:execute', 'devices:execute'], mutation: true },
  { method: 'POST', path: '/content/enrich-run', grants: ['workspace:execute', 'devices:execute'], mutation: true },
  { method: 'POST', path: '/content/crosswalk-run', grants: ['workspace:execute', 'devices:execute'], mutation: true },
  { method: 'POST', path: '/content/jobs', grants: ['workspace:execute', 'devices:execute'], mutation: true },
  { method: 'POST', path: '/content/jobs/advance', grants: ['workspace:execute', 'devices:execute'], mutation: true },
  { method: 'GET', path: '/dashboard/summary', grants: ['workspace:read'] },
  { method: 'GET', path: '/dashboard/jobs', grants: ['workspace:read'] },
  { method: 'GET', path: '/devices/device-1/summary', grants: ['workspace:read', 'devices:read'] },
];

function appFor(grants: string[], mfaSatisfied = true, allowedSiteIds?: string[]) {
  const app = new Hono<WorkspaceRouteEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: 'user-1', isPlatformAdmin: false },
      scope: 'partner',
      partnerId: 'partner-1',
      accessibleOrgIds: [ORG_ID],
    });
    c.set('extensionAuthorization', {
      hasPermission: (resource, action) => grants.includes(`${resource}:${action}`),
      mfaSatisfied,
      ...(allowedSiteIds === undefined ? {} : { allowedSiteIds }),
    });
    await next();
  });
  app.use('*', adminGate);
  app.all('*', (c) => c.body(null, 204));
  return app;
}

function request(app: Hono<WorkspaceRouteEnv>, method: string, path: string) {
  return app.request(`${path}?orgId=${ORG_ID}`, { method });
}

describe('Workspace admin authorization matrix', () => {
  for (const route of ROUTES) {
    it(`${route.method} ${route.path} requires every declared grant`, async () => {
      expect((await request(appFor(route.grants), route.method, route.path)).status).toBe(204);
      for (const omitted of route.grants) {
        const remaining = route.grants.filter((grant) => grant !== omitted);
        expect(
          (await request(appFor(remaining), route.method, route.path)).status,
          `omitting ${omitted}`,
        ).toBe(403);
      }
    });

    if (route.mutation) {
      it(`${route.method} ${route.path} requires host-resolved MFA`, async () => {
        const response = await request(appFor(route.grants, false), route.method, route.path);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
      });
    }

    it(`${route.method} ${route.path} fails closed for a site-restricted principal`, async () => {
      const response = await request(
        appFor(route.grants, true, ['site-1']),
        route.method,
        route.path,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Site-restricted Workspace access is not supported',
      });
    });
  }
});
