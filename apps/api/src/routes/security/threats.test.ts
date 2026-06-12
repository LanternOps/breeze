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

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

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

function buildApp(permissions?: { allowedSiteIds?: string[] }): Hono {
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
    if (permissions) c.set('permissions', permissions as any);
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
    getUserPermissionsMock.mockResolvedValue(null);
  });

  it('rejects quarantine when the threat device is outside the caller site allowlist', async () => {
    mockThreatSelect(SITE_FORBIDDEN);
    const app = buildApp({ allowedSiteIds: [SITE_ALLOWED] });

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
    const app = buildApp({ allowedSiteIds: [SITE_ALLOWED] });

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

  it('rejects remove for an out-of-site device even when permissions are fetched lazily', async () => {
    mockThreatSelect(SITE_FORBIDDEN);
    // No permissions set in context; handler must fetch them.
    getUserPermissionsMock.mockResolvedValue({ allowedSiteIds: [SITE_ALLOWED] });
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
    // permissions has no allowedSiteIds → unrestricted
    const app = buildApp({});

    const res = await app.request(`/security/threats/${THREAT_ID}/restore`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(queueCommandMock).toHaveBeenCalledTimes(1);
  });
});
