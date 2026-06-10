import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    execute: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
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
      orgCondition: () => undefined,
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
    // request opts into site restrictions, narrow to a specific siteId. A
    // comma-separated `x-restrict-site-list` allows multi-site allowlists.
    const allowedSiteIds = c.req.header('x-restrict-site-list')
      ? (c.req.header('x-restrict-site-list') as string).split(',')
      : c.req.header('x-restrict-site')
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

import { coreRoutes, DEVICE_SITE_DENORMALIZED_TABLES } from './core';
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

function rigDeviceThenSiteLookup(device: unknown, targetSite: unknown) {
  // PATCH /devices/:id issues TWO sequential `db.select()...limit(1)` calls:
  //   1. getDeviceWithOrgAndSiteCheck → fixture device
  //   2. target-site same-org validation → target site row
  // Return the device on the first call, the site on the second.
  const deviceLimit = vi.fn().mockResolvedValue(device ? [device] : []);
  const deviceWhere = vi.fn().mockReturnValue({ limit: deviceLimit });
  const deviceFrom = vi.fn().mockReturnValue({ where: deviceWhere });

  const siteLimit = vi.fn().mockResolvedValue(targetSite ? [targetSite] : []);
  const siteWhere = vi.fn().mockReturnValue({ limit: siteLimit });
  const siteFrom = vi.fn().mockReturnValue({ where: siteWhere });

  const updateReturning = vi.fn().mockResolvedValue([{ ...(device as object), siteId: undefined }]);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });

  vi.mocked(db.select)
    .mockReturnValueOnce({ from: deviceFrom } as never)
    .mockReturnValueOnce({ from: siteFrom } as never);
  vi.mocked(db.update).mockReturnValue({ set: updateSet } as never);
}

function rigPlainUpdate(updatedRow: unknown) {
  // Non-site-changing PATCHes run a plain db.update (no transaction).
  const returning = vi.fn().mockResolvedValue([updatedRow]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set };
}

function rigPatchTransaction(updatedRow: unknown) {
  // A siteId-changing PATCH runs the devices UPDATE plus the
  // DEVICE_SITE_DENORMALIZED_TABLES propagation loop inside db.transaction.
  // Each tx.execute() call is `UPDATE ${sql.identifier(table)} SET site_id =
  // ${siteId}::uuid WHERE device_id = ...` — Drizzle exposes the identifier
  // as queryChunks[1].value and the bound siteId Param as queryChunks[3].value
  // (same extraction as moveOrg.test.ts).
  const txExecuted: Array<{ table: unknown; siteId: unknown }> = [];
  const txUpdateSets: Array<Record<string, unknown>> = [];

  vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          txUpdateSets.push(vals);
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updatedRow]),
            }),
          };
        }),
      }),
      execute: vi.fn().mockImplementation(async (sqlVal: any) => {
        const chunks = sqlVal?.queryChunks ?? [];
        // chunks[3] is the bound siteId — pushed raw by the sql template
        // (only wrapped into a Param at query-build time), so unwrap both shapes.
        const rawSite = chunks[3];
        const boundSiteId =
          rawSite !== null && typeof rawSite === 'object' && 'value' in rawSite
            ? (rawSite as { value: unknown }).value
            : rawSite;
        txExecuted.push({ table: chunks[1]?.value, siteId: boundSiteId });
        return [];
      }),
    };
    await cb(tx);
  });
  return { txExecuted, txUpdateSets };
}

function rigDeviceListRows(rows: unknown[]) {
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ offset });
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ leftJoin });
  vi.mocked(db.select).mockReturnValue({ from } as never);
  vi.mocked(db.execute).mockResolvedValue([] as never);
  return { where };
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
  const allowedListSiteId = '55555555-5555-4555-8555-555555555555';
  const deniedListSiteId = '66666666-6666-4666-8666-666666666666';

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

  describe('GET /devices list site filtering', () => {
    it('lists only rows from allowed sites for a site-restricted caller', async () => {
      rigDeviceListRows([
        {
          ...ACCESSIBLE_DEVICE,
          id: '22222222-2222-4222-8222-222222222222',
          siteId: allowedListSiteId,
          agentId: 'agent-1',
          displayName: null,
          osType: 'linux',
          deviceRole: 'workstation',
          deviceRoleSource: 'manual',
          osVersion: null,
          osBuild: null,
          architecture: null,
          agentVersion: null,
          watchdogStatus: null,
          mainAgentSilentSince: null,
          lastSeenAt: null,
          enrolledAt: null,
          tags: [],
          customFields: null,
          desktopAccess: null,
          lastUser: null,
          uptimeSeconds: null,
          isHeadless: false,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          cpuModel: null,
          cpuCores: null,
          ramTotalMb: null,
          diskTotalGb: null,
        },
      ]);

      const res = await app.request('/devices?limit=50', {
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': allowedListSiteId },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((device: { siteId: string }) => device.siteId)).toEqual([allowedListSiteId]);
    });

    it('rejects an explicit siteId outside the caller allowlist', async () => {
      const res = await app.request(`/devices?siteId=${deniedListSiteId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t', 'x-restrict-site': allowedListSiteId },
      });

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('does not apply a site allowlist for unrestricted callers', async () => {
      rigDeviceListRows([
        {
          ...ACCESSIBLE_DEVICE,
          id: '33333333-3333-4333-8333-333333333333',
          siteId: allowedListSiteId,
          agentId: 'agent-1',
          displayName: null,
          osType: 'linux',
          deviceRole: 'workstation',
          deviceRoleSource: 'manual',
          osVersion: null,
          osBuild: null,
          architecture: null,
          agentVersion: null,
          watchdogStatus: null,
          mainAgentSilentSince: null,
          lastSeenAt: null,
          enrolledAt: null,
          tags: [],
          customFields: null,
          desktopAccess: null,
          lastUser: null,
          uptimeSeconds: null,
          isHeadless: false,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          cpuModel: null,
          cpuCores: null,
          ramTotalMb: null,
          diskTotalGb: null,
        },
        {
          ...ACCESSIBLE_DEVICE,
          id: '44444444-4444-4444-8444-444444444444',
          siteId: deniedListSiteId,
          agentId: 'agent-2',
          displayName: null,
          osType: 'linux',
          deviceRole: 'workstation',
          deviceRoleSource: 'manual',
          osVersion: null,
          osBuild: null,
          architecture: null,
          agentVersion: null,
          watchdogStatus: null,
          mainAgentSilentSince: null,
          lastSeenAt: null,
          enrolledAt: null,
          tags: [],
          customFields: null,
          desktopAccess: null,
          lastUser: null,
          uptimeSeconds: null,
          isHeadless: false,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          cpuModel: null,
          cpuCores: null,
          ramTotalMb: null,
          diskTotalGb: null,
        },
      ]);

      const res = await app.request('/devices?limit=50', {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((device: { siteId: string }) => device.siteId)).toEqual([allowedListSiteId, deniedListSiteId]);
    });
  });

  describe('PATCH /devices/:id — TARGET site-scope enforcement on move', () => {
    // SR: a site-restricted caller could move a device they legitimately own
    // (source site in their allowlist) into a TARGET site outside their
    // allowlist. The source is gated by getDeviceWithOrgAndSiteCheck; the
    // target must also be gated via canAccessSite, mirroring provision.ts.
    // updateDeviceSchema validates siteId as a UUID, so use real UUIDs. The
    // device's current site is also a UUID; the caller's allowlist contains it.
    const siteAllowed = '77777777-7777-4777-8777-777777777777';
    const siteB = '88888888-8888-4888-8888-888888888888'; // outside allowlist
    const deviceInSiteAllowed = { ...ACCESSIBLE_DEVICE, siteId: siteAllowed };
    const targetSiteRow = { id: siteB, orgId: 'org-123' };

    it('returns 403 when a site-restricted caller moves a device to a TARGET site outside their allowlist', async () => {
      rigDeviceThenSiteLookup(deviceInSiteAllowed, targetSiteRow);
      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          // Caller is restricted to site-1 (the device's current site) only.
          'x-restrict-site': siteAllowed,
        },
        body: JSON.stringify({ siteId: siteB }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site denied/i);
      // The 403 must fire BEFORE any write runs (plain or transactional).
      expect(db.update).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('allows an UNRESTRICTED caller to set the siteId (no regression)', async () => {
      rigDeviceThenSiteLookup(deviceInSiteAllowed, targetSiteRow);
      rigPatchTransaction({ ...deviceInSiteAllowed, siteId: siteB });
      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          // No x-restrict-site → allowedSiteIds undefined → unrestricted.
        },
        body: JSON.stringify({ siteId: siteB }),
      });
      expect(res.status).toBe(200);
      // Site changes run inside db.transaction (device flip + site_id propagation).
      expect(db.transaction).toHaveBeenCalled();
    });

    it('allows a site-restricted caller to move WITHIN their allowlist (siteA → siteA2 both allowed)', async () => {
      const siteA2 = '99999999-9999-4999-8999-999999999999';
      const siteA2Row = { id: siteA2, orgId: 'org-123' };
      // Caller's allowlist includes both the device's current site (siteAllowed)
      // and the destination (siteA2). The mock middleware narrows to a single
      // site per `x-restrict-site`, so widen it here for this case.
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([deviceInSiteAllowed]) }),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([siteA2Row]) }),
          }),
        } as never);
      rigPatchTransaction({ ...deviceInSiteAllowed, siteId: siteA2 });

      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
          'x-restrict-site-list': `${siteAllowed},${siteA2}`,
        },
        body: JSON.stringify({ siteId: siteA2 }),
      });
      expect(res.status).toBe(200);
      expect(db.transaction).toHaveBeenCalled();
    });
  });

  describe('PATCH /devices/:id — denormalized site_id propagation', () => {
    // elevation_requests (and any future DEVICE_SITE_DENORMALIZED_TABLES
    // entry) denormalizes site_id off the parent device. A PATCH that moves
    // the device to another site MUST rewrite those rows in the same
    // transaction — otherwise they strand under the OLD site_id and drift
    // out of site-visibility scoping (the same hazard moveOrg.ts guards).
    const siteAllowed = '77777777-7777-4777-8777-777777777777';
    const siteB = '88888888-8888-4888-8888-888888888888';
    const deviceInSiteAllowed = { ...ACCESSIBLE_DEVICE, siteId: siteAllowed };
    const targetSiteRow = { id: siteB, orgId: 'org-123' };

    it('rewrites site_id on every DEVICE_SITE_DENORMALIZED_TABLES table when the PATCH changes siteId', async () => {
      rigDeviceThenSiteLookup(deviceInSiteAllowed, targetSiteRow);
      const { txExecuted, txUpdateSets } = rigPatchTransaction({ ...deviceInSiteAllowed, siteId: siteB });

      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: siteB }),
      });

      expect(res.status).toBe(200);
      // Sanity: the list this test guards is non-empty (elevation_requests).
      expect(DEVICE_SITE_DENORMALIZED_TABLES.length).toBeGreaterThan(0);
      // The devices row flip carries the new siteId…
      expect(txUpdateSets[0]).toMatchObject({ siteId: siteB });
      // …and every denormalized table got an UPDATE with the NEW siteId
      // inside the same transaction.
      expect(txExecuted.map((e) => e.table)).toEqual([...DEVICE_SITE_DENORMALIZED_TABLES]);
      for (const e of txExecuted) {
        expect(e.siteId).toBe(siteB);
      }
      // The plain (non-transactional) update path must NOT have been used.
      expect(db.update).not.toHaveBeenCalled();
    });

    it('does NOT propagate when the PATCH siteId equals the current site', async () => {
      rigDeviceLookup(deviceInSiteAllowed);
      rigPlainUpdate(deviceInSiteAllowed);

      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: siteAllowed }),
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('does NOT propagate on a PATCH that does not touch siteId', async () => {
      rigDeviceLookup(deviceInSiteAllowed);
      rigPlainUpdate({ ...deviceInSiteAllowed, displayName: 'renamed' });

      const res = await app.request(`/devices/${ACCESSIBLE_DEVICE.id}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'renamed' }),
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
    });
  });
});
