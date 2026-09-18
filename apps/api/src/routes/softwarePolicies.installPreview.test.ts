/**
 * #5505 W06 — route coverage for GET /software-policies/:id/install-preview,
 * the pre-arm dry run behind PolicyForm's "this will install missing software
 * on ~N device(s)" warning. Read-only: same auth gate and site-ceiling
 * narrowing as its GET siblings, arms nothing, no MFA.
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

const { computeMock } = vi.hoisted(() => ({ computeMock: vi.fn() }));
vi.mock('../services/softwarePolicyInstallPreview', () => ({
  computeInstallPreviewEligibleDeviceCount: (...a: unknown[]) => computeMock(...a),
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

describe('GET /software-policies/:id/install-preview', () => {
  it('returns the eligible device count for an accessible allowlist policy', async () => {
    mockPolicyLookup(ALLOWLIST_POLICY);
    computeMock.mockResolvedValue(42);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligibleDeviceCount: 42 });
    expect(computeMock).toHaveBeenCalledWith({
      policyId: POLICY_ID,
      rules: {
        software: [{ name: 'Zoom', catalogId: 'cat-1' }],
        executable: undefined,
        allowUnknown: undefined,
      },
      siteAllowedDeviceIds: null,
    });
  });

  it('returns 0 without calling the count service for a non-allowlist policy', async () => {
    mockPolicyLookup({ ...ALLOWLIST_POLICY, mode: 'blocklist' });

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligibleDeviceCount: 0 });
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the request is unauthenticated', async () => {
    // Precedent: routes/sso.test.ts — a mocked middleware that returns a
    // Response without calling next() short-circuits the chain, same as the
    // real authMiddleware does for a missing/invalid token.
    vi.mocked(authMiddleware).mockImplementation((c: any) => c.json({ error: 'Unauthorized' }, 401));

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`);

    expect(res.status).toBe(401);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('is gated by the same devices:read permission middleware as every sibling GET route', () => {
    // requirePermission is globally stubbed to an unconditional passthrough in
    // this file's mock block, matching every other route in
    // softwarePolicies.ts — there is no per-route way to force it to reject
    // with that mock shape (requireSoftwarePolicyRead is bound once at
    // module-import time). requirePermission's own rejection behaviour has its
    // own dedicated suite: middleware/auth.test.ts, describe('requirePermission').
    // What IS verifiable here, and is the meaningful "wrong permission"
    // regression guard for THIS route, is that it is wired with a permission
    // gate in the same position as its established-good sibling GET /:id —
    // i.e. it was not registered as a bare unguarded handler.
    const routes = (softwarePoliciesRoutes as unknown as {
      routes: Array<{ method: string; path: string }>;
    }).routes;
    const previewEntries = routes.filter(
      (r) => r.method === 'GET' && r.path === '/:id/install-preview',
    );
    const siblingEntries = routes.filter((r) => r.method === 'GET' && r.path === '/:id');
    expect(previewEntries.length).toBeGreaterThan(1);
    expect(previewEntries.length).toBe(siblingEntries.length);
  });

  it('returns 400 for a non-UUID policy id', async () => {
    const res = await app().request('/software-policies/not-a-uuid/install-preview', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('returns 404, not a count, for a policy id that does not exist', async () => {
    mockPolicyLookup(null);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Policy not found' });
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('returns 404, not a count, for a policy id belonging to another org — multi-tenant isolation', async () => {
    // getPolicyWithAccess's WHERE always includes the caller's tenant access
    // condition (softwarePolicyAccessCondition), so a real cross-org id is
    // filtered out at the database layer and the query returns zero rows —
    // indistinguishable at this mocked layer from a nonexistent id, which is
    // deliberate: GET /:id already returns this identical 404 body for both
    // cases rather than leaking which one occurred, and this route reuses
    // getPolicyWithAccess unchanged.
    mockPolicyLookup(null);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('returns 0 without calling the count service when the caller has a zero-site allowlist', async () => {
    setAuth([]);
    mockPolicyLookup(ALLOWLIST_POLICY);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligibleDeviceCount: 0 });
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('narrows to the caller site allowlist before counting', async () => {
    setAuth(['site-1']);
    mockPolicyLookup(ALLOWLIST_POLICY);
    mockSiteResolution([
      { id: 'dev-allowed', siteId: 'site-1' },
      { id: 'dev-denied', siteId: 'site-2' },
    ]);
    computeMock.mockResolvedValue(1);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(computeMock).toHaveBeenCalledWith(
      expect.objectContaining({ siteAllowedDeviceIds: ['dev-allowed'] }),
    );
  });
});
