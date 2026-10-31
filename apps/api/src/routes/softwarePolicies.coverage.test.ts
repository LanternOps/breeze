/**
 * #9635 — route coverage for GET /software-policies/:id/coverage, the read
 * behind the "applies to N devices / overridden by X" indicator. Read-only:
 * same auth gate, tenancy 404 and site-ceiling narrowing as install-preview.
 * The counting itself is pinned on Postgres by softwarePolicyTie.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
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
    id: 'x',
    policyId: 'x',
    deviceId: 'x',
    status: 'x',
    violations: 'x',
    lastChecked: 'x',
    remediationStatus: 'x',
    lastRemediationAttempt: 'x',
    installRemediationStatus: 'x',
    lastInstallRemediationAttempt: 'x',
    installRemediationAttempts: 'x',
  },
  softwarePolicies: {
    id: 'id',
    orgId: 'orgId',
    partnerId: 'partnerId',
    mode: 'mode',
    rules: 'rules',
    name: 'name',
    isActive: 'isActive',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));
vi.mock('../services/softwarePolicyService', () => ({
  normalizeSoftwarePolicyRules: (r: any) => ({
    software: r?.software ?? [],
    executable: r?.executable,
    allowUnknown: r?.allowUnknown,
  }),
  recordSoftwarePolicyAudit: vi.fn(async () => undefined),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/pamActuationLifecycle', () => ({ requestPamCleanup: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/partnerWideAccess', () => ({
  canManagePartnerWidePolicies: vi.fn(() => true),
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'denied',
}));
vi.mock('../services/siteCeilingAccess', () => ({
  canMutateOrgWideGovernance: vi.fn(() => true),
  SITE_CEILING_WRITE_DENIED_MESSAGE: 'denied',
}));
vi.mock('../services/softwarePolicyAuthorization', () => ({ assertMayArmInstall: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('../services/softwarePolicyInstallPreview', () => ({
  computeInstallPreviewEligibleDeviceCount: vi.fn(),
}));
const { coverageMock } = vi.hoisted(() => ({ coverageMock: vi.fn() }));
vi.mock('../services/softwarePolicyCoverage', () => ({
  getSoftwarePolicyCoverage: (...a: unknown[]) => coverageMock(...a),
}));

import { softwarePoliciesRoutes } from './softwarePolicies';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';

function setAuth(allowedSiteIds?: string[]) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
      user: { id: 'user-123', email: 'test@example.com' },
    });
    if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
    return next();
  });
}

function mockPolicyLookup(row: Record<string, unknown> | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
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

const ALLOWLIST_POLICY = {
  id: POLICY_ID,
  orgId: ORG_ID,
  partnerId: null,
  mode: 'allowlist',
  rules: { software: [{ name: 'Zoom', catalogId: 'cat-1' }] },
};

function app() {
  const instance = new Hono();
  instance.route('/software-policies', softwarePoliciesRoutes);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth();
});

const COVERAGE = {
  assignedDeviceCount: 4,
  appliesToDeviceCount: 0,
  overriddenBy: [{ policyId: 'p-win', name: 'Default Allowlist', mode: 'allowlist', partnerWide: false, configPolicyId: 'c', configPolicyName: 'Default Allowlist Config', deviceCount: 4 }],
};

describe('GET /software-policies/:id/coverage', () => {
  it('returns the coverage of an accessible policy', async () => {
    mockPolicyLookup(ALLOWLIST_POLICY);
    coverageMock.mockResolvedValue(COVERAGE);

    const res = await app().request(`/software-policies/${POLICY_ID}/coverage`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: COVERAGE });
    expect(coverageMock).toHaveBeenCalledWith(POLICY_ID, {});
  });

  it('returns 404 and counts nothing for an inaccessible or unknown policy', async () => {
    mockPolicyLookup(null);

    const res = await app().request(`/software-policies/${POLICY_ID}/coverage`);

    expect(res.status).toBe(404);
    expect(coverageMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-UUID id', async () => {
    const res = await app().request('/software-policies/nope/coverage');
    expect(res.status).toBe(400);
  });

  it('narrows to the caller site allowlist', async () => {
    setAuth(['site-1']);
    mockPolicyLookup(ALLOWLIST_POLICY);
    mockSiteResolution([
      { id: 'dev-allowed', siteId: 'site-1' },
      { id: 'dev-denied', siteId: 'site-2' },
    ]);
    coverageMock.mockResolvedValue(COVERAGE);

    const res = await app().request(`/software-policies/${POLICY_ID}/coverage`);

    expect(res.status).toBe(200);
    expect(coverageMock).toHaveBeenCalledWith(POLICY_ID, { restrictToDeviceIds: ['dev-allowed'] });
  });

  it('answers zero coverage without resolving when the caller has a zero-site allowlist', async () => {
    setAuth([]);
    mockPolicyLookup(ALLOWLIST_POLICY);

    const res = await app().request(`/software-policies/${POLICY_ID}/coverage`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { assignedDeviceCount: 0, appliesToDeviceCount: 0, overriddenBy: [] } });
    expect(coverageMock).not.toHaveBeenCalled();
  });
});
