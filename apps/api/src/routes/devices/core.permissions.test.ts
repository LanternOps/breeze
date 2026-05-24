import { beforeEach, describe, expect, it, test, vi } from 'vitest';
import { Hono } from 'hono';

// Authorization gate tests for the device routes hardened in
// docs/security-reports/customer_launch_readiness_2026-05-24.md
//
// These tests exercise the new permission + site-scope + MFA gates added on
// top of org-scope. The route handlers below the gates still use the existing
// `getDeviceWithOrgCheck`/`getDeviceWithOrgAndSiteCheck` chokepoints, so we
// mock those at the helper boundary instead of standing up real Drizzle
// mocks for every downstream query.

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
      token: { mfa: false },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (c.req.header(`x-deny-${resource}-${action}`) === 'true') {
      return c.json({ error: 'Permission denied' }, 403);
    }
    // Mark permissions so getDeviceWithOrgAndSiteCheck can read them; if the
    // request opts into site restrictions, narrow to a specific siteId.
    const allowedSiteIds = c.req.header('x-restrict-site')
      ? [c.req.header('x-restrict-site') as string]
      : undefined;
    c.set('permissions', {
      permissions: [{ resource, action }],
      partnerId: null,
      orgId: 'org-123',
      roleId: 'role-123',
      scope: 'organization',
      ...(allowedSiteIds ? { allowedSiteIds } : {}),
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (c.req.header('x-deny-mfa') === 'true') {
      return c.json({ error: 'MFA required' }, 403);
    }
    return next();
  }),
}));

// We exercise the REAL `getDeviceWithOrgAndSiteCheck` end-to-end so the
// site-scope branch is hit. The helper does its own `db.select(...).from(devices)
// .where(...).limit(1)` lookup, so each test rigs `db.select` to return the
// fixture device.

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }),
}));

vi.mock('../../services/remoteAccessLauncher', () => ({
  resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }),
}));

vi.mock('../agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SELF_UNINSTALL: 'self_uninstall' },
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null),
}));

import { coreRoutes } from './core';
import { hardwareRoutes } from './hardware';
import { softwareRoutes } from './software';
import { metricsRoutes } from './metrics';
import { eventsRoutes } from './events';
import { eventLogsRoutes } from './eventlogs';
import { sessionsRoutes } from './sessions';
import { patchesRoutes } from './patches';
import { groupsRoutes } from './groups';
import { db } from '../../db';

function rigDeviceLookup(device: unknown) {
  // Both getDeviceWithOrgCheck and getDeviceWithOrgAndSiteCheck issue an
  // identical `db.select().from(devices).where(eq(devices.id,...)).limit(1)`
  // call. The helper consumes the first row, so we return [device] (or []
  // when device is null) and stop there.
  const limit = vi.fn().mockResolvedValue(device ? [device] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

const ACCESSIBLE_DEVICE: Record<string, unknown> = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-123',
  siteId: 'site-1',
  hostname: 'host-1',
  status: 'online' as const,
  customFields: null,
  managementPosture: null,
};

describe('Device routes — permission / site / MFA gates (security-launch-fixes)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
    app.route('/devices', hardwareRoutes);
    app.route('/devices', softwareRoutes);
    app.route('/devices', metricsRoutes);
    app.route('/devices', eventsRoutes);
    app.route('/devices', eventLogsRoutes);
    app.route('/devices', sessionsRoutes);
    app.route('/devices', patchesRoutes);
    app.route('/devices', groupsRoutes);
  });

  describe('GET routes — devices:read enforcement', () => {
    // SR-LAUNCH-2: roles without devices:read MUST NOT read per-device data
    // through any of the per-device GET endpoints. Previously these only
    // checked org-scope which is satisfied for any user in the org regardless
    // of their RBAC role.
    const readPaths = [
      `/devices/${ACCESSIBLE_DEVICE.id}`,
      `/devices/${ACCESSIBLE_DEVICE.id}/hardware`,
      `/devices/${ACCESSIBLE_DEVICE.id}/software`,
      `/devices/${ACCESSIBLE_DEVICE.id}/metrics`,
      `/devices/${ACCESSIBLE_DEVICE.id}/events`,
      `/devices/${ACCESSIBLE_DEVICE.id}/patches`,
      // Section A.2: hardware sub-endpoints newly site- and permission-gated.
      `/devices/${ACCESSIBLE_DEVICE.id}/network`,
      `/devices/${ACCESSIBLE_DEVICE.id}/ip-history`,
      `/devices/${ACCESSIBLE_DEVICE.id}/disks`,
      `/devices/${ACCESSIBLE_DEVICE.id}/connections`,
      // Section A.2: session sub-endpoints newly site- and permission-gated.
      `/devices/${ACCESSIBLE_DEVICE.id}/sessions/history`,
      `/devices/${ACCESSIBLE_DEVICE.id}/sessions/experience`,
      // E.2: pre-existing devices:read gates that this suite did not cover.
      `/devices/${ACCESSIBLE_DEVICE.id}/sessions/active`,
      `/devices/${ACCESSIBLE_DEVICE.id}/eventlogs`,
      `/devices/${ACCESSIBLE_DEVICE.id}/management-posture`,
    ];
    for (const path of readPaths) {
      it(`denies a role without devices:read on GET ${path}`, async () => {
        rigDeviceLookup(ACCESSIBLE_DEVICE);
        const res = await app.request(path, {
          method: 'GET',
          headers: { Authorization: 'Bearer t', 'x-deny-devices-read': 'true' },
        });
        expect(res.status).toBe(403);
      });
    }
  });

  describe('site-scope enforcement at getDeviceWithOrgAndSiteCheck chokepoint', () => {
    // SR-LAUNCH-2: a user whose `allowedSiteIds` excludes the device's site
    // MUST get 403 even if org-scope passes. The site check ONLY runs after
    // requirePermission middleware populates `permissions` in the Hono context.
    it('returns 403 when the caller is site-restricted away from the device site (GET /devices/:id)', async () => {
      rigDeviceLookup(ACCESSIBLE_DEVICE);
      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': 'site-other' },
      });
      expect(res.status).toBe(403);
    });

    it('returns 403 when the caller is site-restricted away from the device site (PATCH /devices/:id)', async () => {
      rigDeviceLookup(ACCESSIBLE_DEVICE);
      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          'x-restrict-site': 'site-other',
        },
        body: JSON.stringify({ displayName: 'new-name' }),
      });
      expect(res.status).toBe(403);
    });

    it('allows the request through when the caller is restricted to the device site (GET management-posture)', async () => {
      // The management-posture route doesn't make downstream DB calls after
      // the chokepoint, so we can deterministically assert a 200 — proving
      // the gate ALLOWED the request through to the handler body rather
      // than just "not-403".
      rigDeviceLookup(ACCESSIBLE_DEVICE);
      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}/management-posture`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': 'site-1' },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /devices/:id — devices:write enforcement', () => {
    it('denies a role without devices:write on PATCH /devices/:id', async () => {
      rigDeviceLookup(ACCESSIBLE_DEVICE);
      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          'x-deny-devices-write': 'true',
        },
        body: JSON.stringify({ displayName: 'new-name' }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /devices/groups — devices:write enforcement', () => {
    it('denies a role without devices:write on POST /devices/groups', async () => {
      const res = await app.request('/devices/groups', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          'x-deny-devices-write': 'true',
        },
        body: JSON.stringify({ orgId: 'org-123', name: 'g1', type: 'static' }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('Destructive lifecycle — devices:delete and MFA enforcement', () => {
    const lifecyclePaths: Array<[string, string]> = [
      ['DELETE', `/devices/${ACCESSIBLE_DEVICE.id}`],
      ['POST', `/devices/${ACCESSIBLE_DEVICE.id}/restore`],
      ['DELETE', `/devices/${ACCESSIBLE_DEVICE.id}/permanent`],
    ];
    for (const [method, path] of lifecyclePaths) {
      it(`denies a caller without devices:delete on ${method} ${path}`, async () => {
        rigDeviceLookup(ACCESSIBLE_DEVICE);
        const res = await app.request(path, {
          method,
          headers: { Authorization: 'Bearer t', 'x-deny-devices-delete': 'true' },
        });
        expect(res.status).toBe(403);
      });

      it(`denies a caller without MFA on ${method} ${path}`, async () => {
        rigDeviceLookup(ACCESSIBLE_DEVICE);
        const res = await app.request(path, {
          method,
          headers: { Authorization: 'Bearer t', 'x-deny-mfa': 'true' },
        });
        expect(res.status).toBe(403);
      });
    }
  });

  describe('helper safety — misuse without requirePermission throws 500', () => {
    // Defense in depth: if a future route calls getDeviceWithOrgAndSiteCheck
    // without first running requirePermission, we want a loud 500, not a
    // silent grant. We exercise that path by reaching into the real helper
    // module and calling it with a Context whose `permissions` is unset.
    it('throws 500 when permissions context is missing (programmer error)', async () => {
      const helpers = await import('./helpers');
      rigDeviceLookup(ACCESSIBLE_DEVICE);
      const fakeCtx = { get: (_k: string) => undefined } as any;
      await expect(
        helpers.getDeviceWithOrgAndSiteCheck(fakeCtx, String(ACCESSIBLE_DEVICE.id), {
          scope: 'organization',
          orgId: 'org-123',
          accessibleOrgIds: ['org-123'],
          canAccessOrg: () => true,
        }),
      ).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/permissions context is missing/) });
    });
  });

  describe('site-scope enforcement on newly site-gated mutations (Section A.1)', () => {
    // E.3: each of these endpoints used to use the org-only chokepoint and
    // therefore silently honored cross-site access for site-restricted users.
    // They now go through getDeviceWithOrgAndSiteCheck and must return 403
    // when allowedSiteIds excludes the device's site.
    const siteRestrictedMutations: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['POST', `/devices/${ACCESSIBLE_DEVICE.id}/agent-token/rotate`, undefined],
      ['POST', `/devices/${ACCESSIBLE_DEVICE.id}/remote-access-launch`, undefined],
      ['POST', `/devices/${ACCESSIBLE_DEVICE.id}/patches/install`, { patchIds: ['22222222-2222-4222-8222-222222222222'] }],
      ['POST', `/devices/${ACCESSIBLE_DEVICE.id}/patches/22222222-2222-4222-8222-222222222222/rollback`, undefined],
    ];
    for (const [method, path, body] of siteRestrictedMutations) {
      it(`returns 403 for site-restricted caller on ${method} ${path}`, async () => {
        rigDeviceLookup(ACCESSIBLE_DEVICE);
        const headers: Record<string, string> = {
          Authorization: 'Bearer t',
          'x-restrict-site': 'site-other',
        };
        if (body) headers['Content-Type'] = 'application/json';
        const res = await app.request(path, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        expect(res.status).toBe(403);
      });
    }
  });

  describe('Group mutation gates (Section E.4)', () => {
    const groupId = '33333333-3333-4333-8333-333333333333';
    const matrix: Array<[string, string, string, Record<string, unknown> | undefined]> = [
      // [method, path, permissionResource:Action denied, body]
      ['PATCH', `/devices/groups/${groupId}`, 'devices-write', { name: 'new-name' }],
      ['DELETE', `/devices/groups/${groupId}`, 'devices-delete', undefined],
      ['POST', `/devices/groups/${groupId}/members`, 'devices-write', { deviceIds: [ACCESSIBLE_DEVICE.id] }],
      ['DELETE', `/devices/groups/${groupId}/members`, 'devices-write', { deviceIds: [ACCESSIBLE_DEVICE.id] }],
    ];
    for (const [method, path, denyHeader, body] of matrix) {
      it(`denies ${method} ${path} without the relevant permission`, async () => {
        const headers: Record<string, string> = {
          Authorization: 'Bearer t',
          [`x-deny-${denyHeader}`]: 'true',
        };
        if (body) headers['Content-Type'] = 'application/json';
        const res = await app.request(path, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        expect(res.status).toBe(403);
      });

      it(`denies ${method} ${path} without MFA`, async () => {
        const headers: Record<string, string> = {
          Authorization: 'Bearer t',
          'x-deny-mfa': 'true',
        };
        if (body) headers['Content-Type'] = 'application/json';
        const res = await app.request(path, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        expect(res.status).toBe(403);
      });
    }
  });

  describe('Patch execute gates (Section E.5)', () => {
    const patchId = '44444444-4444-4444-8444-444444444444';
    it('denies POST /:id/patches/install without devices:execute', async () => {
      rigDeviceLookup(ACCESSIBLE_DEVICE);
      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}/patches/install`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          'x-deny-devices-execute': 'true',
        },
        body: JSON.stringify({ patchIds: [patchId] }),
      });
      expect(res.status).toBe(403);
    });

    it('denies POST /:id/patches/install without MFA', async () => {
      rigDeviceLookup(ACCESSIBLE_DEVICE);
      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}/patches/install`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          'x-deny-mfa': 'true',
        },
        body: JSON.stringify({ patchIds: [patchId] }),
      });
      expect(res.status).toBe(403);
    });

    it('denies POST /:id/patches/:patchId/rollback without devices:execute', async () => {
      rigDeviceLookup(ACCESSIBLE_DEVICE);
      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}/patches/${patchId}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'x-deny-devices-execute': 'true',
        },
      });
      expect(res.status).toBe(403);
    });
  });

  // E.8: this gap is intentionally documented rather than fixed in this PR.
  test.todo(
    'GET /devices does not filter row results by allowedSiteIds — list endpoint shows hostnames cross-site, see open item in PR description',
  );
});
