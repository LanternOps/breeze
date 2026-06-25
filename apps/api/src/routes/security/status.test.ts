import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
  },
  securityStatus: {},
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {},
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

// Keep requireScope as a passthrough; use real requirePermission so RBAC
// is actually enforced in tests.
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

import { statusRoutes } from './status';

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
  app.route('/security', statusRoutes);
  return app;
}

describe('GET /status — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller has no permissions', async () => {
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request('/security/status', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/status', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/status', { method: 'GET' });

    expect(res.status).not.toBe(403);
  });
});

describe('GET /status/:deviceId — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller has no permissions', async () => {
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request(`/security/status/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request(`/security/status/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    // Device won't be found in the mocked helpers — expect 404 (not 403)
    const res = await app.request(`/security/status/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Site-scope gate tests for GET /status/:deviceId
//
// The gate fires when userPerms.allowedSiteIds is set. It fetches the device's
// siteId from DB and calls canAccessSite (real implementation from actual
// permissions module). listStatusRows uses db.select().from().leftJoin().where()
// while the site-id lookup uses db.select().from().where().limit().
// ---------------------------------------------------------------------------

import { db } from '../../db';

describe('GET /status/:deviceId — site-scope gate', () => {
  const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockListStatusRows(deviceSiteId: string | null) {
    // Backs listStatusRows: db.select({...}).from(devices).leftJoin(...).where(...)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            deviceId: DEVICE_ID,
            orgId: ORG_ID,
            deviceName: 'test-host',
            os: 'windows',
            deviceState: 'online',
            provider: 'defender',
            providerVersion: '1.0',
            definitionsVersion: '1.0',
            definitionsDate: null,
            realTimeProtection: true,
            threatCount: 0,
            firewallEnabled: true,
            encryptionStatus: 'encrypted',
            encryptionDetails: null,
            localAdminSummary: null,
            passwordPolicySummary: null,
            gatekeeperEnabled: null,
            lastScan: null,
            lastScanType: null,
            siteId: deviceSiteId,
          }]),
        }),
      }),
    } as any);
  }

  function mockSiteIdLookup(siteId: string | null) {
    // Backs db.select({ siteId }).from(devices).where(...).limit(1)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(siteId !== null ? [{ siteId }] : [{ siteId: null }]),
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
    mockListStatusRows(SITE_B);
    mockSiteIdLookup(SITE_B);
    const app = buildApp();

    const res = await app.request(`/security/status/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
    const body = await res.json();
    // Must be the site gate error, not the RBAC "Permission denied" message
    expect(body.error).toMatch(/site/i);
    // The protected status data must not be present
    expect(body.data).toBeUndefined();
  });

  it('returns non-403 when the device site is in the caller site allowlist', async () => {
    // Caller has devices:read and is restricted to SITE_A; device also lives in SITE_A.
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: [SITE_A],
    });
    mockListStatusRows(SITE_A);
    mockSiteIdLookup(SITE_A);
    const app = buildApp();

    const res = await app.request(`/security/status/${DEVICE_ID}`, { method: 'GET' });

    // Site gate passed — must not be 403 (will be 200 with the status data)
    expect(res.status).not.toBe(403);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.deviceId).toBe(DEVICE_ID);
  });
});
