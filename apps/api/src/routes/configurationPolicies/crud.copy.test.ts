import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// POST /:id/copy (#12309, #11776; plan W05b K2). The route runs the real copy
// service; the policy reads and writes beneath it are mocked. The planner's
// decisions are pinned in services/configPolicyCopy.test.ts and the writes on
// real Postgres in __tests__/integration/configPolicyCopy.integration.test.ts.

const m = vi.hoisted(() => ({
  getConfigPolicy: vi.fn(),
  createConfigPolicy: vi.fn(),
  addFeatureLink: vi.fn(),
  writeRouteAudit: vi.fn(),
  mfa: { satisfied: true },
  auth: { override: null as any },
  perms: { value: { permissions: [{ resource: '*', action: '*' }] } as any },
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: m.getConfigPolicy,
    createConfigPolicy: m.createConfigPolicy,
    addFeatureLink: m.addFeatureLink,
    validateFeaturePolicyExists: vi.fn(async () => ({ valid: true })),
    parentPolicyEnablesHpCmslCollection: vi.fn(async () => false),
    parentPolicyArmsOemUpdates: vi.fn(async () => false),
  };
});
vi.mock('../patches/helpers', () => ({ resolvePartnerIdForOrg: vi.fn(async () => PARTNER) }));
vi.mock('../../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: m.writeRouteAudit }));
vi.mock('../../services/remoteAccessPolicy', () => ({ invalidateRemoteAccessCache: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!m.mfa.satisfied) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    await next();
  }),
  hasSatisfiedMfa: vi.fn(() => m.mfa.satisfied),
}));

import { crudRoutes } from './crud';

const PARTNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '11111111-1111-4111-8111-11111111111b';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const WRITE_ONLY = { permissions: [{ resource: 'devices', action: 'write' }] } as any;

const fullPartner = {
  scope: 'partner',
  partnerId: PARTNER,
  orgId: null,
  partnerOrgAccess: 'all',
  user: { id: 'user-1' },
  token: { scope: 'partner', mfa: true },
  accessibleOrgIds: [ORG_A, ORG_B],
  canAccessOrg: (o: string) => o === ORG_A || o === ORG_B,
  orgCondition: () => undefined,
};

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', m.auth.override ?? fullPartner);
    c.set('permissions', m.perms.value);
    await next();
  });
  app.route('/', crudRoutes);
  return app;
}

function copy(body: Record<string, unknown>) {
  return buildApp().request(`/${SOURCE}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sourcePolicy(featureLinks: unknown[] = []) {
  return {
    id: SOURCE, name: 'Servers', description: null, status: 'active', orgId: ORG_A, partnerId: null,
    parentPolicyId: null, featureLinks,
  };
}

describe('POST /:id/copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.mfa.satisfied = true;
    m.auth.override = null;
    m.perms.value = { permissions: [{ resource: '*', action: '*' }] };
    m.getConfigPolicy.mockImplementation(async (id: string) => (id === SOURCE ? sourcePolicy() : null));
    m.createConfigPolicy.mockImplementation(async (owner: any, data: any) => ({ id: NEW_ID, orgId: owner.orgId, partnerId: owner.partnerId, ...data }));
    m.addFeatureLink.mockImplementation(async (_id: string, featureType: string) => ({ id: 'l', featureType }));
  });

  it('creates the copy inactive, answers 201 and audits the source', async () => {
    const res = await copy({ name: 'Servers (copy)', ownerScope: 'organization', orgId: ORG_B, status: 'active' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ dryRun: false, policyId: NEW_ID, orgId: ORG_B, dropped: [] });
    expect(m.createConfigPolicy).toHaveBeenCalledWith({ orgId: ORG_B, partnerId: null }, expect.objectContaining({ status: 'inactive' }), 'user-1');
    expect(m.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_B,
      action: 'config_policy.copy',
      resourceId: NEW_ID,
      details: expect.objectContaining({ sourcePolicyId: SOURCE, ownerScope: 'organization', dropped: [] }),
    }));
  });

  it('a dry run answers 200, writes nothing and audits nothing', async () => {
    m.getConfigPolicy.mockImplementation(async (id: string) => (id === SOURCE
      ? sourcePolicy([{ featureType: 'onedrive_helper', featurePolicyId: null, inlineSettings: { libraries: [] } }])
      : null));

    const res = await copy({ name: 'X', ownerScope: 'partner', dryRun: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: true, carried: [], dropped: [{ featureType: 'onedrive_helper', reason: 'org_only_feature' }] });
    expect(m.createConfigPolicy).not.toHaveBeenCalled();
    expect(m.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('copy re-runs the arming gates with the caller\'s own permissions', async () => {
    m.perms.value = WRITE_ONLY;
    m.getConfigPolicy.mockImplementation(async (id: string) => (id === SOURCE
      ? sourcePolicy([{ featureType: 'warranty', featurePolicyId: null, inlineSettings: { enabled: true, hpCmsl: { enabled: true } } }])
      : null));

    const res = await copy({ name: 'X', ownerScope: 'organization', orgId: ORG_A });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'HP_CMSL_EXECUTE_REQUIRED' });
    expect(m.createConfigPolicy).not.toHaveBeenCalled();
  });

  it('a limited partner cannot copy to MSP-managed', async () => {
    m.auth.override = { ...fullPartner, partnerOrgAccess: 'selected', accessibleOrgIds: [ORG_A], canAccessOrg: (o: string) => o === ORG_A };

    const res = await copy({ name: 'X', ownerScope: 'partner' });

    expect(res.status).toBe(403);
    expect(m.createConfigPolicy).not.toHaveBeenCalled();
  });

  it('a site-restricted caller cannot copy', async () => {
    m.auth.override = {
      scope: 'organization', orgId: ORG_A, partnerId: PARTNER, user: { id: 'u' }, allowedSiteIds: ['s1'],
      accessibleOrgIds: [ORG_A], canAccessOrg: (o: string) => o === ORG_A, orgCondition: () => undefined,
    };

    const res = await copy({ name: 'X', ownerScope: 'organization' });

    expect(res.status).toBe(403);
    expect(m.getConfigPolicy).not.toHaveBeenCalled();
  });

  it('needs MFA', async () => {
    m.mfa.satisfied = false;
    const res = await copy({ name: 'X', ownerScope: 'organization', orgId: ORG_A });
    expect(res.status).toBe(403);
    expect(m.getConfigPolicy).not.toHaveBeenCalled();
  });

  it('a source the caller cannot read is a 404', async () => {
    m.getConfigPolicy.mockResolvedValue(null);
    const res = await copy({ name: 'X', ownerScope: 'organization', orgId: ORG_A });
    expect(res.status).toBe(404);
  });

  it('validates the body', async () => {
    const res = await copy({ name: '', ownerScope: 'organization' });
    expect(res.status).toBe(400);
    expect(m.getConfigPolicy).not.toHaveBeenCalled();
  });
});
