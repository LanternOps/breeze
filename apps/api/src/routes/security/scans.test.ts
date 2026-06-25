import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
  },
  securityScans: {
    id: 'securityScans.id',
    deviceId: 'securityScans.deviceId',
    orgId: 'securityScans.orgId',
    scanType: 'securityScans.scanType',
    status: 'securityScans.status',
    startedAt: 'securityScans.startedAt',
    completedAt: 'securityScans.completedAt',
    threatsFound: 'securityScans.threatsFound',
    duration: 'securityScans.duration',
    initiatedBy: 'securityScans.initiatedBy',
  },
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SECURITY_SCAN: 'security_scan' },
  queueCommand: vi.fn(async () => undefined),
}));

const { getUserPermissionsMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return {
    ...actual,
    getUserPermissions: getUserPermissionsMock,
  };
});

// requirePermission calls getUserPermissions internally; use the real
// implementation so permission checks are actually enforced in tests.
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

import { db } from '../../db';
import { scansRoutes } from './scans';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as any);
    await next();
  });
  app.route('/security', scansRoutes);
  return app;
}

function mockDeviceSelect() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{
          id: DEVICE_ID,
          hostname: 'test-host',
          orgId: ORG_ID,
          siteId: null,
        }]),
      }),
    }),
  } as any);
}

function mockScansSelect() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as any);
}

describe('GET /scans/:deviceId — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller lacks devices:read permission', async () => {
    // User has no permissions at all
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request(`/security/scans/${DEVICE_ID}`, {
      method: 'GET',
    });

    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller has permissions but not devices:read', async () => {
    // User has some permissions but devices resource is absent
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request(`/security/scans/${DEVICE_ID}`, {
      method: 'GET',
    });

    expect(res.status).toBe(403);
  });

  it('returns non-403 when the caller has devices:read permission', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    mockDeviceSelect();
    mockScansSelect();
    const app = buildApp();

    const res = await app.request(`/security/scans/${DEVICE_ID}`, {
      method: 'GET',
    });

    // 200 on success, or 404 if device not matched by RLS — either way not 403
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Site-scope gate tests for GET /scans/:deviceId
//
// scans.ts calls canAccessDeviceSite(c, auth, device.siteId) right after the
// device row is fetched (the same row includes siteId). canAccessDeviceSite
// calls getUserPermissions internally then delegates to canAccessSite (the
// real implementation imported via vi.importActual). After the gate passes the
// handler issues a second db.select for the scans list.
// ---------------------------------------------------------------------------

describe('GET /scans/:deviceId — site-scope gate', () => {
  const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockDeviceSelectWithSite(siteId: string | null) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: DEVICE_ID,
            hostname: 'test-host',
            orgId: ORG_ID,
            siteId,
          }]),
        }),
      }),
    } as any);
  }

  it('returns 403 with a site error when the caller site allowlist excludes the device site', async () => {
    // Caller has devices:read but is restricted to SITE_A; device lives in SITE_B.
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: [SITE_A],
    });
    mockDeviceSelectWithSite(SITE_B);
    const app = buildApp();

    const res = await app.request(`/security/scans/${DEVICE_ID}`, {
      method: 'GET',
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    // Must be the site gate error, not the RBAC "Permission denied" message
    expect(body.error).toMatch(/site/i);
    // The protected scan list must not be present
    expect(body.data).toBeUndefined();
  });

  it('returns non-403 when the device site is in the caller site allowlist', async () => {
    // Caller has devices:read and is restricted to SITE_A; device also lives in SITE_A.
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: [SITE_A],
    });
    mockDeviceSelectWithSite(SITE_A);
    // Back the subsequent scans SELECT with an empty list so the handler resolves cleanly.
    mockScansSelect();
    const app = buildApp();

    const res = await app.request(`/security/scans/${DEVICE_ID}`, {
      method: 'GET',
    });

    // Site gate passed — must not be 403
    expect(res.status).not.toBe(403);
  });
});
