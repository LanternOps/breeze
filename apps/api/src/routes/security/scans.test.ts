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
  // services/patchSeverityOverlay.ts builds module-level SQL fragments from these at import time.
  patches: { severity: 'patches.severity', category: 'patches.category' },
  devicePatches: { reportedSeverity: 'device_patches.reported_severity', reportedCategory: 'device_patches.reported_category' },
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

const { resolveSecurityScanSettingsForDeviceMock } = vi.hoisted(() => ({
  resolveSecurityScanSettingsForDeviceMock: vi.fn(
    async (): Promise<import('@breeze/shared').SecurityScanSettings | null> => null,
  ),
}));

vi.mock('../../services/featureConfigResolver', () => ({
  resolveSecurityScanSettingsForDevice: resolveSecurityScanSettingsForDeviceMock,
}));

const { getUserPermissionsMock, planYaraScanMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
  planYaraScanMock: vi.fn(async (): Promise<import('../../services/yaraScanRefs').YaraScanPlan> => ({
    ruleSets: [], engine: 'legacy', ruleSetErrors: null,
  })),
}));

vi.mock('../../services/yaraScanRefs', () => ({ planYaraScan: planYaraScanMock }));

// #10057 gap 2: the Scan now / cancel services own their transaction and the
// claim; their behaviour is covered in services/securityScanStart.test.ts and
// jobs/securityScanClaim.test.ts. Here: the HTTP mapping only.
const svc = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), audit: vi.fn() }));
vi.mock('../../services/securityScanStart', () => ({
  startDeviceScan: (...a: unknown[]) => svc.start(...a),
  cancelDeviceScan: (...a: unknown[]) => svc.cancel(...a),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: (...a: unknown[]) => svc.audit(...a) }));

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
    // Session-claim MFA, controlled per test through the auth token.
    hasSatisfiedMfa: vi.fn((auth: any) => auth.token?.mfa === true),
  };
});

import { db } from '../../db';
import { queueCommand } from '../../services/commandQueue';
import { scansRoutes } from './scans';
import { SECURITY_SCAN_SETTINGS_DEFAULTS } from '@breeze/shared';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';

function buildApp(opts: { mfa?: boolean } = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      token: { mfa: opts.mfa ?? false },
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

describe('GET /scans/:deviceId — timed_out filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
  });

  it('lists a waiting Scan now with its queue expiry (#10057 gap 2)', async () => {
    mockDeviceSelect();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([{
            id: 's-1', scanType: 'quick', status: 'queued', startedAt: new Date('2027-01-01T00:00:00Z'),
            completedAt: null, threatsFound: null, duration: null, queueExpiresAt: new Date('2027-01-02T00:00:00Z'),
          }]),
        }),
      }),
    } as any);
    const res = await buildApp().request(`/security/scans/${DEVICE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect((await res.json()).data[0]).toMatchObject({ id: 's-1', status: 'queued', queueExpiresAt: '2027-01-02T00:00:00.000Z' });
  });

  it('accepts timed_out as a scan list filter', async () => {
    mockDeviceSelect();
    mockScansSelect();
    const res = await buildApp().request(`/security/scans/${DEVICE_ID}?status=timed_out`, {
      method: 'GET',
    });
    expect(res.status).not.toBe(400);
  });
});

describe('POST /scan/:deviceId and POST /scans/:scanId/cancel (#10057 gap 2)', () => {
  const SCAN_ID = '33333333-3333-4333-8333-333333333333';
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'execute' }],
      allowedSiteIds: undefined,
    });
  });

  it('202 with the queued scan and its queue expiry; the session MFA state is passed through', async () => {
    const scan = {
      id: SCAN_ID, deviceId: DEVICE_ID, deviceName: 'h', orgId: ORG_ID, scanType: 'quick', status: 'queued',
      startedAt: '2027-01-01T00:00:00.000Z', queueExpiresAt: '2027-01-02T00:00:00.000Z',
    };
    svc.start.mockResolvedValue({ ok: true, scan });
    const res = await buildApp({ mfa: true }).request(`/security/scan/${DEVICE_ID}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scanType: 'quick' }),
    });
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({ ...scan, threatsFound: 0 });
    expect(svc.start.mock.calls[0]![1]).toMatchObject({ deviceId: DEVICE_ID, scanType: 'quick', mfaSatisfied: true });
    expect(queueCommand).not.toHaveBeenCalled();
  });

  it('409 with the waiting scan id when one is already queued', async () => {
    svc.start.mockResolvedValue({ ok: false, status: 409, error: 'A scan is already queued for this device', scanId: SCAN_ID });
    const res = await buildApp().request(`/security/scan/${DEVICE_ID}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scanType: 'quick' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'A scan is already queued for this device', code: 'SCAN_ALREADY_QUEUED', scanId: SCAN_ID });
  });

  it('cancel: 200 and an audit row on success', async () => {
    svc.cancel.mockResolvedValue({ ok: true, scan: { id: SCAN_ID, status: 'cancelled' }, orgId: ORG_ID });
    const res = await buildApp().request(`/security/scans/${SCAN_ID}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: SCAN_ID, status: 'cancelled' } });
    expect(svc.cancel).toHaveBeenCalledWith(expect.anything(), SCAN_ID);
    expect(svc.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, action: 'security.scan.cancel', resourceType: 'security_scan', resourceId: SCAN_ID,
    }));
  });

  it('cancel: maps a 409 with its code; no audit row', async () => {
    svc.cancel.mockResolvedValue({ ok: false, status: 409, code: 'SCAN_RUNNING', error: 'running' });
    const res = await buildApp().request(`/security/scans/${SCAN_ID}/cancel`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'running', code: 'SCAN_RUNNING' });
    expect(svc.audit).not.toHaveBeenCalled();
  });

  it('cancel: 400 for a non-uuid id, before the service', async () => {
    const res = await buildApp().request('/security/scans/not-a-uuid/cancel', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(svc.cancel).not.toHaveBeenCalled();
  });

  it('cancel needs devices:execute', async () => {
    getUserPermissionsMock.mockResolvedValue({ permissions: [{ resource: 'devices', action: 'read' }], allowedSiteIds: undefined });
    const res = await buildApp().request(`/security/scans/${SCAN_ID}/cancel`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(svc.cancel).not.toHaveBeenCalled();
  });
});
