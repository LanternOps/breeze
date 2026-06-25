import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    status: 'devices.status',
    hostname: 'devices.hostname',
  },
  securityThreats: {
    id: 'securityThreats.id',
    deviceId: 'securityThreats.deviceId',
    provider: 'securityThreats.provider',
    threatName: 'securityThreats.threatName',
    threatType: 'securityThreats.threatType',
    severity: 'securityThreats.severity',
    filePath: 'securityThreats.filePath',
    status: 'securityThreats.status',
    resolvedAt: 'securityThreats.resolvedAt',
    resolvedBy: 'securityThreats.resolvedBy',
  },
  securityStatus: {},
  auditLogs: {},
}));

// Use the real requirePermission so RBAC is actually enforced; only stub
// requireScope (tenancy check) to a passthrough for unit-test simplicity.
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

const { queueCommandMock, getUserPermissionsMock } = vi.hoisted(() => ({
  queueCommandMock: vi.fn(async () => undefined),
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {
    SECURITY_THREAT_QUARANTINE: 'security_threat_quarantine',
    SECURITY_THREAT_REMOVE: 'security_threat_remove',
    SECURITY_THREAT_RESTORE: 'security_threat_restore',
  },
  queueCommand: queueCommandMock,
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return {
    ...actual,
    getUserPermissions: getUserPermissionsMock,
  };
});

import { db } from '../../db';
import { threatsRoutes } from './threats';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const THREAT_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ALLOWED = '44444444-4444-4444-8444-444444444444';
const SITE_FORBIDDEN = '55555555-5555-4555-8555-555555555555';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-1',
      accessibleOrgIds: [ORG_ID],
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as any);
    await next();
  });
  app.route('/security', threatsRoutes);
  return app;
}

function mockThreatSelect(siteId: string | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: THREAT_ID,
            deviceId: DEVICE_ID,
            deviceSiteId: siteId,
            provider: 'defender',
            threatName: 'EICAR',
            threatType: 'malware',
            severity: 'high',
            filePath: '/tmp/x',
            status: 'detected',
          }]),
        }),
      }),
    }),
  } as any);
}

describe('security threats action routes (site-scope enforcement)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Provide devices:execute so real requirePermission passes the POST routes.
    // Tests that need site-scope restrictions override allowedSiteIds below.
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'execute' }],
      allowedSiteIds: [SITE_ALLOWED],
    });
  });

  it('rejects quarantine when the threat device is outside the caller site allowlist', async () => {
    // getUserPermissions returns a site-restricted list that excludes SITE_FORBIDDEN.
    // requirePermission stores these permissions in context; queueThreatAction
    // enforces the site allowlist and rejects SITE_FORBIDDEN.
    mockThreatSelect(SITE_FORBIDDEN);
    const app = buildApp();

    const res = await app.request(`/security/threats/${THREAT_ID}/quarantine`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Access to this site denied');
    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('allows quarantine when the threat device is inside the caller site allowlist', async () => {
    mockThreatSelect(SITE_ALLOWED);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
    const app = buildApp();

    const res = await app.request(`/security/threats/${THREAT_ID}/quarantine`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(THREAT_ID);
    expect(body.data.status).toBe('quarantined');
    expect(queueCommandMock).toHaveBeenCalledTimes(1);
  });

  it('rejects remove for an out-of-site device', async () => {
    mockThreatSelect(SITE_FORBIDDEN);
    // permissions restrict to SITE_ALLOWED only; SITE_FORBIDDEN is denied.
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'execute' }],
      allowedSiteIds: [SITE_ALLOWED],
    });
    const app = buildApp();

    const res = await app.request(`/security/threats/${THREAT_ID}/remove`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('allows restore when the caller has no site restriction', async () => {
    mockThreatSelect(SITE_FORBIDDEN);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
    // No allowedSiteIds → unrestricted; SITE_FORBIDDEN is allowed.
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'execute' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request(`/security/threats/${THREAT_ID}/restore`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(queueCommandMock).toHaveBeenCalledTimes(1);
  });
});

// RBAC tests: verify that GET /threats and GET /threats/:deviceId enforce
// requirePermission('devices', 'read'). The real requirePermission is used
// (via vi.importActual in the auth mock above) so getUserPermissions controls
// the outcome — null → 403, missing devices:read → 403, present → pass.
describe('security threats GET routes — requirePermission(devices, read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue(null);
  });

  it('GET /threats returns 403 when the caller has no permissions', async () => {
    // getUserPermissions returns null → real requirePermission → 403
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request('/security/threats', { method: 'GET' });

    expect(res.status).toBe(403);
    // DB must not have been reached
    expect(db.select).not.toHaveBeenCalled();
  });

  it('GET /threats returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/threats', { method: 'GET' });

    expect(res.status).toBe(403);
    // DB must not have been reached
    expect(db.select).not.toHaveBeenCalled();
  });

  it('GET /threats returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request('/security/threats', { method: 'GET' });

    // Permission check passed; any status other than 403 is acceptable here.
    expect(res.status).not.toBe(403);
  });

  it('GET /threats/:deviceId returns 403 when the caller has no permissions', async () => {
    // getUserPermissions returns null → real requirePermission → 403
    getUserPermissionsMock.mockResolvedValue(null);
    const app = buildApp();

    const res = await app.request(`/security/threats/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
    // DB must not have been reached
    expect(db.select).not.toHaveBeenCalled();
  });

  it('GET /threats/:deviceId returns 403 when the caller lacks devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'scripts', action: 'read' }],
      allowedSiteIds: undefined,
    });
    const app = buildApp();

    const res = await app.request(`/security/threats/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
    // DB must not have been reached
    expect(db.select).not.toHaveBeenCalled();
  });

  it('GET /threats/:deviceId returns non-403 when the caller has devices:read', async () => {
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
    // listStatusRows will return empty → device not found → 404, which is not 403.
    const app = buildApp();

    const res = await app.request(`/security/threats/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Site-scope gate tests for GET /threats/:deviceId
//
// threats.ts calls listStatusRows(auth) first to confirm the device is visible,
// then — when userPerms.allowedSiteIds is set — fetches { siteId } from devices
// and calls canAccessSite. The mocks here use the real canAccessSite (from
// vi.importActual) so the allowedSiteIds check behaves exactly as in production.
//
// db.select call order for the 403 path:
//   1. listStatusRows  → .from().leftJoin().where()        → row with deviceId
//   2. site gate       → .from().where().limit()           → { siteId }
//
// db.select call order for the 200 path (in-site):
//   1. listStatusRows  → .from().leftJoin().where()        → row with deviceId
//   2. site gate       → .from().where().limit()           → { siteId }
//   3. listThreatRows  → .from().innerJoin().where().orderBy() → []
// ---------------------------------------------------------------------------

describe('GET /threats/:deviceId — site-scope gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockListStatusRowsForDevice() {
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

  function mockListThreatRowsEmpty() {
    // Backs listThreatRows: db.select({...}).from(securityThreats).innerJoin(...).where(...).orderBy(...)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as any);
  }

  it('returns 403 with a site error when the caller site allowlist excludes the device site', async () => {
    // Caller has devices:read but is restricted to SITE_ALLOWED; device is in SITE_FORBIDDEN.
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: [SITE_ALLOWED],
    });
    mockListStatusRowsForDevice();
    mockSiteIdLookup(SITE_FORBIDDEN);
    const app = buildApp();

    const res = await app.request(`/security/threats/${DEVICE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
    const body = await res.json();
    // Must be the site gate error, not the RBAC "Permission denied" message
    expect(body.error).toMatch(/site/i);
    // The protected threats data must not be present
    expect(body.data).toBeUndefined();
  });

  it('returns non-403 when the device site is in the caller site allowlist', async () => {
    // Caller has devices:read and is restricted to SITE_ALLOWED; device is also in SITE_ALLOWED.
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: [SITE_ALLOWED],
    });
    mockListStatusRowsForDevice();
    mockSiteIdLookup(SITE_ALLOWED);
    // Back the subsequent listThreatRows call with an empty set so the handler resolves.
    mockListThreatRowsEmpty();
    const app = buildApp();

    const res = await app.request(`/security/threats/${DEVICE_ID}`, { method: 'GET' });

    // Site gate passed — must not be 403
    expect(res.status).not.toBe(403);
  });
});
