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


import { softwarePoliciesRoutes } from './softwarePolicies';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';

// ───────────── GET /:id/remediate/preview (#3616) ─────────────
// The dry run behind the Remediate confirmation. It must resolve the SAME
// server-side target set the operator is about to act on (never the client's
// filter view), hand back the exact device ids the confirm call will send, and
// never queue anything itself.
describe('GET /:id/remediate/preview', () => {
  const ORG_ID = '11111111-1111-1111-1111-111111111111';
  const POLICY_ID = '22222222-2222-2222-2222-222222222222';
  const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
  const DEVICE_A = '33333333-3333-3333-3333-333333333333';
  const DEVICE_B = '44444444-4444-4444-4444-444444444444';

  let app: Hono;

  function setAuth(allowedSiteIds?: string[]) {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: ORG_ID,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
        orgCondition: () => undefined,
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

  // db.select({deviceId, hostname, violations}).from(compliance)
  //   .innerJoin(devices).where(...).orderBy(...).limit(500)
  function mockTargetRows(rows: Array<Record<string, unknown>>) {
    const limit = vi.fn().mockResolvedValue(rows);
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ limit }),
          }),
        }),
      }),
    } as any);
    return limit;
  }

  // db.select({count}).from(compliance).innerJoin(devices).where(...)
  function mockTotalCount(count: number) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count }]),
        }),
      }),
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/software-policies', softwarePoliciesRoutes);
  });

  it('returns the server-resolved target set, blast radius, and policy identity without queuing anything', async () => {
    setAuth();
    mockPolicyLookup({ id: POLICY_ID, orgId: ORG_ID, mode: 'allowlist', name: 'Standard apps' });
    const limit = mockTargetRows([
      { deviceId: DEVICE_A, hostname: 'alpha', violations: [
        { type: 'unauthorized', software: { name: 'Zoom', version: '5' } },
        { type: 'unauthorized', software: { name: 'Steam' } },
      ] },
      { deviceId: DEVICE_B, hostname: 'bravo', violations: [
        { type: 'unauthorized', software: { name: 'Zoom', version: '5' } },
      ] },
    ]);
    mockTotalCount(2);

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toEqual({ id: POLICY_ID, name: 'Standard apps', mode: 'allowlist' });
    expect(body.deviceIds).toEqual([DEVICE_A, DEVICE_B]);
    expect(body.deviceCount).toBe(2);
    expect(body.uninstallCount).toBe(3);
    expect(body.totalTargetDevices).toBe(2);
    expect(body.capped).toBe(false);
    expect(body.maxDevices).toBe(500);
    expect(body.software[0]).toEqual({ name: 'Zoom', deviceCount: 2 });
    expect(body.sampleDevices[0].hostname).toBe('alpha');
    // Same cap the remediate route enforces on its explicit deviceIds.
    expect(limit).toHaveBeenCalledWith(500);
    expect(vi.mocked(scheduleSoftwareRemediation)).not.toHaveBeenCalled();
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('reports capped when more devices would be targeted than one remediation can carry', async () => {
    setAuth();
    mockPolicyLookup({ id: POLICY_ID, orgId: ORG_ID, mode: 'blocklist', name: 'Block' });
    mockTargetRows([
      { deviceId: DEVICE_A, hostname: 'alpha', violations: [{ type: 'unauthorized', software: { name: 'X' } }] },
    ]);
    mockTotalCount(812);

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);
    const body = await res.json();
    expect(body.totalTargetDevices).toBe(812);
    expect(body.capped).toBe(true);
  });

  it('404s for a policy the caller cannot see', async () => {
    setAuth();
    mockPolicyLookup(null);
    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);
    expect(res.status).toBe(404);
  });

  it('400s for an audit-only policy, matching the remediate route', async () => {
    setAuth();
    mockPolicyLookup({ id: POLICY_ID, orgId: ORG_ID, mode: 'audit', name: 'Audit' });
    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);
    expect(res.status).toBe(400);
  });

  it('previews zero for a site-restricted caller with no reachable devices, without querying violations', async () => {
    setAuth([SITE_ALLOWED]);
    mockPolicyLookup({ id: POLICY_ID, orgId: ORG_ID, mode: 'blocklist', name: 'Block' });
    mockSiteResolution([]);

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate/preview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deviceCount).toBe(0);
    expect(body.deviceIds).toEqual([]);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });
});
