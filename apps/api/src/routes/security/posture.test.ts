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
  },
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {},
  queueCommand: vi.fn(async () => undefined),
}));

vi.mock('../../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(async () => []),
  getLatestSecurityPostureForDevice: vi.fn(async () => null),
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

import { db } from '../../db';
import { postureRoutes } from './posture';

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
  app.route('/security', postureRoutes);
  return app;
}

describe('GET /posture — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller has no permissions', async () => {
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request('/security/posture', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/posture', { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/posture', { method: 'GET' });

    expect(res.status).not.toBe(403);
  });
});

describe('GET /posture/:deviceId — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when the caller has no permissions', async () => {
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request(`/security/posture/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request(`/security/posture/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
  });

  it('returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    // db.select for device lookup will return empty — device not found → 404
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);
    const app = buildApp();

    const res = await app.request(`/security/posture/${DEVICE_ID}`, { method: 'GET' });

    // 404 (device not found) or 200 — either way the permission check passed
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Site-scope gate tests for GET /posture/:deviceId
//
// posture.ts fetches the device row (including siteId) in the SAME db.select
// call as the org/device lookup. The gate checks userPerms.allowedSiteIds
// against device.siteId immediately after the device row is loaded — there is
// no separate siteId lookup. getLatestSecurityPostureForDevice is already
// mocked to return null (→ 404) in the module-level mock above, which is
// enough for the IN-SITE success case to resolve without 403.
// ---------------------------------------------------------------------------

describe('GET /posture/:deviceId — site-scope gate', () => {
  const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockDeviceLookup(siteId: string | null) {
    // Backs db.select({ id, orgId, siteId }).from(devices).where(...).limit(1)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: DEVICE_ID,
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
    mockDeviceLookup(SITE_B);
    const app = buildApp();

    const res = await app.request(`/security/posture/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
    const body = await res.json();
    // Must be the site gate error, not the RBAC "Permission denied" message
    expect(body.error).toMatch(/site/i);
    // The protected posture data must not be present
    expect(body.data).toBeUndefined();
  });

  it('returns non-403 when the device site is in the caller site allowlist', async () => {
    // Caller has devices:read and is restricted to SITE_A; device also lives in SITE_A.
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: [SITE_A],
    });
    mockDeviceLookup(SITE_A);
    const app = buildApp();

    const res = await app.request(`/security/posture/${DEVICE_ID}`, { method: 'GET' });

    // Site gate passed — must not be 403. getLatestSecurityPostureForDevice is
    // mocked to return null so the handler returns 404 ("No security posture
    // available"), which is the expected non-403 outcome.
    expect(res.status).not.toBe(403);
  });
});
