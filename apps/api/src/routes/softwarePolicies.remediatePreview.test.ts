import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    status: 'devices.status',
    osType: 'devices.osType',
  },
  softwareComplianceStatus: {
    id: 'softwareComplianceStatus.id',
    policyId: 'softwareComplianceStatus.policyId',
    deviceId: 'softwareComplianceStatus.deviceId',
    status: 'softwareComplianceStatus.status',
    violations: 'softwareComplianceStatus.violations',
    lastChecked: 'softwareComplianceStatus.lastChecked',
    remediationStatus: 'softwareComplianceStatus.remediationStatus',
    lastRemediationAttempt: 'softwareComplianceStatus.lastRemediationAttempt',
    installRemediationStatus: 'softwareComplianceStatus.install_remediation_status',
    lastInstallRemediationAttempt: 'softwareComplianceStatus.last_install_remediation_attempt',
    installRemediationAttempts: 'softwareComplianceStatus.install_remediation_attempts',
  },
  softwarePolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', mode: 'mode', name: 'name', isActive: 'isActive', updatedAt: 'updatedAt' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../jobs/softwareComplianceWorker', () => ({
  scheduleSoftwareComplianceCheck: vi.fn(),
}));

vi.mock('../jobs/softwareRemediationWorker', () => ({
  scheduleSoftwareRemediation: vi.fn(async () => 1),
}));

vi.mock('../services/softwarePolicyService', () => ({
  normalizeSoftwarePolicyRules: (r: any) => ({
    software: r.software ?? [],
    executable: r.executable,
    allowUnknown: r.allowUnknown,
  }),
  recordSoftwarePolicyAudit: vi.fn(async () => undefined),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/pamActuationLifecycle', () => ({
  requestPamCleanup: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  // Faithful to the real implementation: unrestricted callers (no
  // allowedSiteIds) always pass; otherwise the site must be in the allowlist.
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));


vi.mock('../services/softwarePolicyRemediationPreview', async () => {
  const actual = await vi.importActual<typeof import('../services/softwarePolicyRemediationPreview')>(
    '../services/softwarePolicyRemediationPreview',
  );
  // The real SQL is proven against Postgres in
  // softwarePolicyRemediationPreview.integration.test.ts; here only the route's
  // wiring — which policy, which tenant filter, which site ceiling — is under test.
  return { ...actual, queryRemediationPreview: vi.fn() };
});

import { softwarePoliciesRoutes } from './softwarePolicies';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';
import { queryRemediationPreview } from '../services/softwarePolicyRemediationPreview';

// ───────────── GET /:id/remediate/preview (#3616) ─────────────
// The dry run behind the Remediate confirmation. It must resolve the target set
// server-side under the caller's tenant + site scope (never the client's filter
// view), hand back the exact device ids the confirm call will send, and never
// queue anything itself.
describe('GET /:id/remediate/preview', () => {
  const ORG_ID = '11111111-1111-1111-1111-111111111111';
  const POLICY_ID = '22222222-2222-2222-2222-222222222222';
  const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
  const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
  const DEVICE_A = '33333333-3333-3333-3333-333333333333';
  const DEVICE_B = '44444444-4444-4444-4444-444444444444';
  const ORG_CONDITION = { __orgCondition: ORG_ID };

  const EMPTY = {
    deviceIds: [],
    deviceCount: 0,
    uninstallCount: 0,
    software: [],
    softwareDistinctCount: 0,
    sampleDevices: [],
    totalTargetDevices: 0,
    capped: false,
    maxDevices: 500,
  };

  let app: Hono;

  function setAuth(allowedSiteIds?: string[]) {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: ORG_ID,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
        orgCondition: () => ORG_CONDITION,
        user: { id: 'user-123', email: 'test@example.com' },
      });
      if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
      return next();
    });
  }

  function mockPolicyLookup(policy: Record<string, unknown> | null) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(policy ? [policy] : []),
        }),
      }),
    } as any);
  }

  function mockSiteResolution(rows: Array<{ id: string; siteId: string | null }>) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryRemediationPreview).mockResolvedValue(EMPTY as any);
    app = new Hono();
    app.route('/software-policies', softwarePoliciesRoutes);
  });

  it('returns the server-resolved preview plus policy identity, scoped to the caller, without queuing anything', async () => {
    setAuth();
    mockPolicyLookup({ id: POLICY_ID, orgId: ORG_ID, mode: 'allowlist', name: 'Standard apps' });
    vi.mocked(queryRemediationPreview).mockResolvedValueOnce({
      ...EMPTY,
      deviceIds: [DEVICE_A, DEVICE_B],
      deviceCount: 2,
      uninstallCount: 3,
      software: [{ name: 'Zoom', deviceCount: 2 }],
      softwareDistinctCount: 1,
      totalTargetDevices: 2,
    } as any);

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toEqual({ id: POLICY_ID, name: 'Standard apps', mode: 'allowlist' });
    expect(body.deviceIds).toEqual([DEVICE_A, DEVICE_B]);
    expect(body.uninstallCount).toBe(3);
    expect(vi.mocked(queryRemediationPreview)).toHaveBeenCalledWith({
      policyId: POLICY_ID,
      orgCondition: ORG_CONDITION,
      siteAllowedDeviceIds: null,
    });
    expect(vi.mocked(scheduleSoftwareRemediation)).not.toHaveBeenCalled();
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('narrows a site-restricted caller to devices in their allowed sites', async () => {
    setAuth([SITE_ALLOWED]);
    mockPolicyLookup({ id: POLICY_ID, orgId: ORG_ID, mode: 'blocklist', name: 'Block' });
    mockSiteResolution([
      { id: DEVICE_A, siteId: SITE_ALLOWED },
      { id: DEVICE_B, siteId: SITE_DENIED },
    ]);

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);
    expect(res.status).toBe(200);
    expect(vi.mocked(queryRemediationPreview)).toHaveBeenCalledWith(
      expect.objectContaining({ siteAllowedDeviceIds: [DEVICE_A] }),
    );
  });

  it('fails closed for a site-restricted caller on a partner-wide policy (orgId null)', async () => {
    setAuth([SITE_ALLOWED]);
    mockPolicyLookup({ id: POLICY_ID, orgId: null, partnerId: 'p-1', mode: 'blocklist', name: 'Partner template' });

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);
    expect(res.status).toBe(200);
    // [] (no devices), never null (unrestricted).
    expect(vi.mocked(queryRemediationPreview)).toHaveBeenCalledWith(
      expect.objectContaining({ siteAllowedDeviceIds: [] }),
    );
  });

  it('404s for a policy the caller cannot see', async () => {
    setAuth();
    mockPolicyLookup(null);
    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);
    expect(res.status).toBe(404);
    expect(vi.mocked(queryRemediationPreview)).not.toHaveBeenCalled();
  });

  it('400s for an audit-only policy, matching the remediate route', async () => {
    setAuth();
    mockPolicyLookup({ id: POLICY_ID, orgId: ORG_ID, mode: 'audit', name: 'Audit' });
    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);
    expect(res.status).toBe(400);
    expect(vi.mocked(queryRemediationPreview)).not.toHaveBeenCalled();
  });
});
