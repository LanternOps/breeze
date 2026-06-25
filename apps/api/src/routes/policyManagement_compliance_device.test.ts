/**
 * Route tests for `GET /policies/compliance/device/:deviceId` (#1876).
 *
 * This route is the ONLY authz guard in front of
 * `getConfigPolicyComplianceForDevice`, which does no tenant/site checks of its
 * own. The gate mirrors the per-device monitoring routes (`monitoring.ts`):
 *   1. resolve the device's org/site,
 *   2. 404 if the device does not exist,
 *   3. 403 if the caller cannot access the device's org (`ensureOrgAccess`),
 *   4. 403 if the caller is site-restricted and lacks the device's site.
 *
 * Site is an app-layer concept (Postgres RLS does NOT defend it), and the site
 * narrowing only runs when `requirePermission` has populated the `permissions`
 * context — so these tests mock `requirePermission` to set `allowedSiteIds`,
 * exactly as the live middleware chain does, and prove the gate fires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const FOREIGN_ORG_ID = '22222222-2222-2222-2222-222222222222';
const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Permissions context applied by the (mocked) requirePermission middleware.
// Tests mutate this before issuing a request.
let currentPermissions: { allowedSiteIds: string[] | null } | undefined;

// Auth context applied by the (mocked) authMiddleware. Tests mutate this to
// exercise organization / partner / system scopes. Mirrors the real shape the
// middleware sets (auth.ts), incl. the `canAccessOrg` predicate.
type TestAuth = {
  scope: 'organization' | 'partner' | 'system';
  orgId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
};
const orgScopeAuth = (): TestAuth => ({
  scope: 'organization',
  orgId: ORG_ID,
  partnerId: null,
  accessibleOrgIds: [ORG_ID],
  canAccessOrg: (orgId: string) => orgId === ORG_ID,
});
let currentAuth: TestAuth = orgScopeAuth();

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  automationPolicies: { id: 'id', orgId: 'orgId' },
  automationPolicyCompliance: { id: 'id', policyId: 'policyId' },
  configPolicyFeatureLinks: { id: 'id', configPolicyId: 'configPolicyId' },
  configurationPolicies: { id: 'id', orgId: 'orgId', name: 'name', status: 'status' },
  devices: { id: 'id', orgId: 'orgId', siteId: 'siteId' },
}));

// Keep the real, pure authz helpers (ensureOrgAccess) but stub the DB-hitting
// per-device compliance reader.
vi.mock('./policyManagement/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./policyManagement/helpers')>();
  return {
    ...actual,
    getConfigPolicyComplianceForDevice: vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'row-1',
          policyId: null,
          configPolicyId: 'feature-link-1',
          configItemName: 'USB storage block',
          deviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          status: 'compliant',
          details: {},
          lastCheckedAt: new Date('2026-06-24T00:00:00Z'),
          remediationAttempts: 0,
          updatedAt: new Date('2026-06-24T00:00:00Z'),
          deviceHostname: 'WIN-TEST',
          deviceStatus: 'online',
          deviceOsType: 'windows',
        },
      ],
      ruleInfoMap: new Map([['feature-link-1', [{ ruleName: 'USB storage block' }]]]),
    }),
  };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-123', email: 'test@example.com' }, ...currentAuth });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  // The real requirePermission populates `permissions`; mirror that so the
  // site-scope gate is LIVE (a no-op mock would make the gate dead and the
  // 403-on-foreign-site test pass vacuously).
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (currentPermissions) c.set('permissions', currentPermissions);
    return next();
  }),
}));

import { db } from '../db';
import { policyRoutes } from './policyManagement';
import { getConfigPolicyComplianceForDevice } from './policyManagement/helpers';

function mockDeviceLookup(device: { orgId: string | null; siteId: string | null } | undefined) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(device ? [device] : []),
      }),
    }),
  } as any);
}

describe('GET /policies/compliance/device/:deviceId (#1876)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    currentPermissions = undefined;
    currentAuth = orgScopeAuth();
    app = new Hono();
    app.route('/policies', policyRoutes);
  });

  it('returns 404 when the device does not exist', async () => {
    mockDeviceLookup(undefined);
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(404);
    expect(vi.mocked(getConfigPolicyComplianceForDevice)).not.toHaveBeenCalled();
  });

  it('returns 403 when the device belongs to an inaccessible org', async () => {
    mockDeviceLookup({ orgId: FOREIGN_ORG_ID, siteId: SITE_ID });
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(403);
    expect(vi.mocked(getConfigPolicyComplianceForDevice)).not.toHaveBeenCalled();
  });

  it('returns 403 for a site-restricted caller without the device\'s site', async () => {
    // The site-scope gate is the load-bearing guard: a partner/org user limited
    // to OTHER_SITE_ID must not read compliance for a device in SITE_ID even
    // though the device is in their org.
    currentPermissions = { allowedSiteIds: [OTHER_SITE_ID] };
    mockDeviceLookup({ orgId: ORG_ID, siteId: SITE_ID });
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(403);
    expect(vi.mocked(getConfigPolicyComplianceForDevice)).not.toHaveBeenCalled();
  });

  it('returns 403 when the device has no site and the caller is site-restricted', async () => {
    currentPermissions = { allowedSiteIds: [SITE_ID] };
    mockDeviceLookup({ orgId: ORG_ID, siteId: null });
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with compliance rows for an in-site caller', async () => {
    currentPermissions = { allowedSiteIds: [SITE_ID] };
    mockDeviceLookup({ orgId: ORG_ID, siteId: SITE_ID });
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; ruleInfo: Record<string, unknown[]> };
    expect(body.data).toHaveLength(1);
    expect(body.ruleInfo['feature-link-1']).toBeDefined();
    expect(vi.mocked(getConfigPolicyComplianceForDevice)).toHaveBeenCalledWith(DEVICE_ID, [ORG_ID]);
  });

  it('returns 200 with no site restriction (unrestricted org/partner caller)', async () => {
    currentPermissions = { allowedSiteIds: null };
    mockDeviceLookup({ orgId: ORG_ID, siteId: SITE_ID });
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(200);
  });

  it('returns 403 when the device has a null org (orphaned device)', async () => {
    // Defends the orphaned-device guard: a device with no owning org must never
    // be readable, and `[device.orgId]` must never be passed to the helper as null.
    mockDeviceLookup({ orgId: null, siteId: SITE_ID });
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(403);
    expect(vi.mocked(getConfigPolicyComplianceForDevice)).not.toHaveBeenCalled();
  });

  // --- Partner scope: this route is the sole tenant guard, so cross-tenant
  // denial and the in-reach success path are both pinned. ---
  it('returns 403 for a partner-scope caller when the device org is out of reach', async () => {
    currentAuth = {
      scope: 'partner',
      orgId: null,
      partnerId: '99999999-9999-4999-8999-999999999999',
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    };
    mockDeviceLookup({ orgId: FOREIGN_ORG_ID, siteId: SITE_ID });
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(403);
    expect(vi.mocked(getConfigPolicyComplianceForDevice)).not.toHaveBeenCalled();
  });

  it('returns 200 for a partner-scope caller when the device org is in reach', async () => {
    currentAuth = {
      scope: 'partner',
      orgId: null,
      partnerId: '99999999-9999-4999-8999-999999999999',
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    };
    currentPermissions = { allowedSiteIds: null };
    mockDeviceLookup({ orgId: ORG_ID, siteId: SITE_ID });
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(getConfigPolicyComplianceForDevice)).toHaveBeenCalledWith(DEVICE_ID, [ORG_ID]);
  });

  it('returns 200 for a system-scope caller across any org (no site restriction)', async () => {
    // System callers reach every org (ensureOrgAccess returns true) and have no
    // site restriction, so the site gate must not block them.
    currentAuth = {
      scope: 'system',
      orgId: null,
      partnerId: null,
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    };
    currentPermissions = undefined; // system callers carry no allowedSiteIds
    mockDeviceLookup({ orgId: FOREIGN_ORG_ID, siteId: SITE_ID });
    const res = await app.request(`/policies/compliance/device/${DEVICE_ID}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(getConfigPolicyComplianceForDevice)).toHaveBeenCalledWith(DEVICE_ID, [FOREIGN_ORG_ID]);
  });
});
