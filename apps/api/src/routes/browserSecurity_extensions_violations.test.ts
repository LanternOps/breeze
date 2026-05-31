import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  browserExtensions: {
    id: 'browserExtensions.id',
    orgId: 'browserExtensions.orgId',
    deviceId: 'browserExtensions.deviceId',
    browser: 'browserExtensions.browser',
    extensionId: 'browserExtensions.extensionId',
    name: 'browserExtensions.name',
    version: 'browserExtensions.version',
    source: 'browserExtensions.source',
    permissions: 'browserExtensions.permissions',
    riskLevel: 'browserExtensions.riskLevel',
    enabled: 'browserExtensions.enabled',
    firstSeenAt: 'browserExtensions.firstSeenAt',
    lastSeenAt: 'browserExtensions.lastSeenAt',
  },
  browserPolicies: {
    id: 'browserPolicies.id',
    orgId: 'browserPolicies.orgId',
    name: 'browserPolicies.name',
    targetType: 'browserPolicies.targetType',
    targetIds: 'browserPolicies.targetIds',
    allowedExtensions: 'browserPolicies.allowedExtensions',
    blockedExtensions: 'browserPolicies.blockedExtensions',
    requiredExtensions: 'browserPolicies.requiredExtensions',
    settings: 'browserPolicies.settings',
    isActive: 'browserPolicies.isActive',
    createdBy: 'browserPolicies.createdBy',
    updatedAt: 'browserPolicies.updatedAt',
  },
  browserPolicyViolations: {
    id: 'browserPolicyViolations.id',
    orgId: 'browserPolicyViolations.orgId',
    deviceId: 'browserPolicyViolations.deviceId',
    policyId: 'browserPolicyViolations.policyId',
    violationType: 'browserPolicyViolations.violationType',
    details: 'browserPolicyViolations.details',
    detectedAt: 'browserPolicyViolations.detectedAt',
    resolvedAt: 'browserPolicyViolations.resolvedAt',
  },
}));

vi.mock('../db/schema/devices', () => ({
  devices: {
    id: 'devices.id',
    hostname: 'devices.hostname',
    orgId: 'devices.orgId',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
  // Faithful to the real implementation: unrestricted callers (no
  // allowedSiteIds) always pass; otherwise the site must be in the allowlist.
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('../jobs/browserSecurityJobs', () => ({
  triggerBrowserPolicyEvaluation: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { browserSecurityRoutes } from './browserSecurity';
import { triggerBrowserPolicyEvaluation } from '../jobs/browserSecurityJobs';

// ── Constants ──────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const POLICY_ID = '44444444-4444-4444-4444-444444444444';
const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
const DEVICE_DENIED = '55555555-5555-5555-5555-555555555555';
const NOW = new Date('2026-03-13T12:00:00Z');

function setAuth(
  overrides: Record<string, unknown> = {},
  permissions?: Record<string, unknown>
) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
      ...overrides,
    });
    if (permissions !== undefined) c.set('permissions', permissions);
    return next();
  });
}

// Mocks the device-resolution query a restricted reader runs first:
// db.select({id, siteId}).from(devices).where(eq(orgId, ...)) → rows
function mockDeviceResolution(rows: Array<{ id: string; siteId: string | null }>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

function makeApp() {
  const app = new Hono();
  app.route('/browser-security', browserSecurityRoutes);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────


describe('browserSecurity routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = makeApp();
  });

  // ────────────────────── GET /extensions ──────────────────────
  describe('GET /extensions', () => {
    it('returns extensions with risk summary', async () => {
      const summaryResult = [{ total: 3, low: 1, medium: 1, high: 1, critical: 0 }];
      const extensionRows = [
        {
          id: 'ext-1',
          orgId: ORG_ID,
          deviceId: DEVICE_ID,
          deviceName: 'PC-01',
          browser: 'chrome',
          extensionId: 'abc123',
          name: 'Ad Blocker',
          version: '1.0',
          source: 'webstore',
          riskLevel: 'low',
          enabled: true,
          lastSeenAt: NOW,
        },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(summaryResult),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue(extensionRows),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request('/browser-security/extensions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.total).toBe(3);
      expect(body.extensions).toHaveLength(1);
      expect(body.extensions[0].name).toBe('Ad Blocker');
    });

    it('respects query filters (deviceId, browser, riskLevel)', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ total: 0, low: 0, medium: 0, high: 0, critical: 0 }]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request(
        `/browser-security/extensions?deviceId=${DEVICE_ID}&browser=chrome&riskLevel=high`
      );
      expect(res.status).toBe(200);
    });

    it('caps limit at 500', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ total: 0, low: 0, medium: 0, high: 0, critical: 0 }]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request('/browser-security/extensions?limit=9999');
      expect(res.status).toBe(200);
    });
  });

  // ────────────────────── GET /violations ──────────────────────
  describe('GET /violations', () => {
    it('returns unresolved violations', async () => {
      const violationRows = [
        {
          id: 'viol-1',
          orgId: ORG_ID,
          deviceId: DEVICE_ID,
          deviceName: 'PC-01',
          policyId: POLICY_ID,
          violationType: 'blocked_extension',
          details: { extensionName: 'Bad Extension' },
          detectedAt: NOW,
        },
      ];

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(violationRows),
              }),
            }),
          }),
        }),
      } as any);

      const res = await app.request('/browser-security/violations');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.violations).toHaveLength(1);
      expect(body.violations[0].violationType).toBe('blocked_extension');
    });

    it('filters by deviceId and policyId', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      } as any);

      const res = await app.request(
        `/browser-security/violations?deviceId=${DEVICE_ID}&policyId=${POLICY_ID}`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.violations).toHaveLength(0);
    });
  });

  // ────────────────────── GET /policies ──────────────────────
  describe('GET /policies', () => {
    it('returns policies for org', async () => {
      const policyRows = [
        {
          id: POLICY_ID,
          orgId: ORG_ID,
          name: 'Block Malicious Extensions',
          targetType: 'org',
          isActive: true,
          updatedAt: NOW,
        },
      ];

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(policyRows),
          }),
        }),
      } as any);

      const res = await app.request('/browser-security/policies');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.policies).toHaveLength(1);
      expect(body.policies[0].name).toBe('Block Malicious Extensions');
    });
  });

  // ────────────────────── POST /policies ──────────────────────
  describe('POST /policies', () => {
    it('creates a policy', async () => {
      const created = {
        id: POLICY_ID,
        orgId: ORG_ID,
        name: 'New Policy',
        targetType: 'org',
        isActive: true,
        createdBy: 'user-1',
      };

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      } as any);

      const res = await app.request('/browser-security/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Policy',
          targetType: 'org',
          blockedExtensions: ['bad-ext-id'],
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.policy.name).toBe('New Policy');
      expect(vi.mocked(triggerBrowserPolicyEvaluation)).toHaveBeenCalledWith(ORG_ID, POLICY_ID);
    });

    it('returns 400 when org context is missing', async () => {
      setAuth({ orgId: null });

      const res = await app.request('/browser-security/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Policy',
          targetType: 'org',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Organization context required');
    });

    it('validates required fields', async () => {
      const res = await app.request('/browser-security/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('validates targetType enum', async () => {
      const res = await app.request('/browser-security/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Policy',
          targetType: 'invalid',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ────────────────────── Site-scope enforcement (reads) ──────────────────────
  // A site-restricted org user (permissions.allowedSiteIds set) must not read
  // extension inventory or violations for devices in sites outside their
  // allowlist. Site is an app-layer concept only — RLS does not defend it.
  describe('GET /extensions — site scope', () => {
    it('denies an explicit deviceId outside the caller site allowlist (403)', async () => {
      setAuth({}, { allowedSiteIds: [SITE_ALLOWED] });
      // Device resolution: DEVICE_DENIED lives in a site the caller cannot access
      mockDeviceResolution([
        { id: DEVICE_ID, siteId: SITE_ALLOWED },
        { id: DEVICE_DENIED, siteId: SITE_DENIED },
      ]);

      const res = await app.request(
        `/browser-security/extensions?deviceId=${DEVICE_DENIED}`
      );
      expect(res.status).toBe(403);
    });

    it('returns empty when the caller has no accessible devices', async () => {
      setAuth({}, { allowedSiteIds: [SITE_ALLOWED] });
      mockDeviceResolution([{ id: DEVICE_DENIED, siteId: SITE_DENIED }]);

      const res = await app.request('/browser-security/extensions');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.extensions).toEqual([]);
      expect(body.summary.total).toBe(0);
    });

    it('narrows to accessible devices and returns data', async () => {
      setAuth({}, { allowedSiteIds: [SITE_ALLOWED] });
      mockDeviceResolution([{ id: DEVICE_ID, siteId: SITE_ALLOWED }]);
      // summary + list selects after narrowing
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ total: 1, low: 1, medium: 0, high: 0, critical: 0 }]),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    { id: 'ext-1', orgId: ORG_ID, deviceId: DEVICE_ID, name: 'Ad Blocker' },
                  ]),
                }),
              }),
            }),
          }),
        } as any);

      const res = await app.request(`/browser-security/extensions?deviceId=${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.extensions).toHaveLength(1);
    });
  });

  describe('GET /violations — site scope', () => {
    it('denies an explicit deviceId outside the caller site allowlist (403)', async () => {
      setAuth({}, { allowedSiteIds: [SITE_ALLOWED] });
      mockDeviceResolution([
        { id: DEVICE_ID, siteId: SITE_ALLOWED },
        { id: DEVICE_DENIED, siteId: SITE_DENIED },
      ]);

      const res = await app.request(
        `/browser-security/violations?deviceId=${DEVICE_DENIED}`
      );
      expect(res.status).toBe(403);
    });

    it('returns empty when the caller has no accessible devices', async () => {
      setAuth({}, { allowedSiteIds: [SITE_ALLOWED] });
      mockDeviceResolution([{ id: DEVICE_DENIED, siteId: SITE_DENIED }]);

      const res = await app.request('/browser-security/violations');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.violations).toEqual([]);
    });

    it('narrows to accessible devices and returns data', async () => {
      setAuth({}, { allowedSiteIds: [SITE_ALLOWED] });
      mockDeviceResolution([{ id: DEVICE_ID, siteId: SITE_ALLOWED }]);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  { id: 'viol-1', orgId: ORG_ID, deviceId: DEVICE_ID, violationType: 'blocked_extension' },
                ]),
              }),
            }),
          }),
        }),
      } as any);

      const res = await app.request(`/browser-security/violations?deviceId=${DEVICE_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.violations).toHaveLength(1);
    });
  });

});
