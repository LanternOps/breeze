import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Route tests for the portal access policy (portal registration W3 #11380,
 * Task 4). The real Task 3 service (portalAccessPolicyWrites + the pure pick)
 * runs against a small in-memory fake of the two tables it touches, so the
 * view shape, validation codes and changedFields asserted here are the
 * service's own, not stubs.
 */
const h = vi.hoisted(() => {
  const organizations = { id: 'organizations.id', partnerId: 'organizations.partner_id', deletedAt: 'organizations.deleted_at' };
  const portalAccessPolicies = {
    orgId: 'pap.org_id',
    partnerId: 'pap.partner_id',
    entraEnabled: 'pap.entra_enabled',
    googleEnabled: 'pap.google_enabled',
    passwordMode: 'pap.password_mode',
    selfRegistrationMode: 'pap.self_registration_mode',
    ssoNewPersonMode: 'pap.sso_new_person_mode',
    ssoSessionMaxHours: 'pap.sso_session_max_hours',
    updatedAt: 'pap.updated_at',
  };
  type PolicyRow = Record<string, unknown> & { orgId: string | null; partnerId: string | null };
  const store = {
    // What the org lookup returns (the fake does not evaluate WHERE clauses).
    orgs: [] as Array<{ id: string; partnerId: string }>,
    policies: [] as PolicyRow[],
  };
  const upserts: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }> = [];
  const rowsFor = (table: unknown) =>
    (table === organizations ? store.orgs : store.policies).map((r) => ({ ...r }));
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = rowsFor(table);
          return Object.assign(Promise.resolve(rows), { limit: async (n: number) => rows.slice(0, n) });
        },
      }),
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
          returning: async () => {
            upserts.push({ values, set });
            const existing = store.policies.find((r) => (values.orgId != null
              ? r.orgId === values.orgId
              : r.orgId === null && r.partnerId === values.partnerId));
            if (existing) {
              Object.assign(existing, set);
              return [{ ...existing }];
            }
            const row = { ...values } as PolicyRow;
            store.policies.push(row);
            return [{ ...row }];
          },
        }),
      }),
    })),
  };
  return {
    organizations, portalAccessPolicies, store, upserts, db, authRef: { current: null as any }, auditSpy: vi.fn(),
    // The org's proven Entra tenant (W4 D2), as findProvenEntraTenantForOrg returns it.
    provenTenant: { current: null as { tenantId: string; provenAt: Date } | null },
    // W4 D12: the sso_only impact (the preview's computeFlips, the save's
    // lockImpact over the rows it locks) and the clear (their SQL is
    // portalSsoOnly.integration's), and the work the route defers until the
    // request transaction commits.
    computeFlips: vi.fn(),
    lockImpact: vi.fn(),
    clearPasswords: vi.fn(),
    listStranded: vi.fn(),
    afterCommit: [] as Array<{ label: string; work: () => unknown }>,
    purgePortal: vi.fn(async () => 0),
    purgeAi: vi.fn(async () => 0),
  };
});

vi.mock('../services/portalSsoOnly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/portalSsoOnly')>()),
  computeSsoOnlyFlips: (...args: unknown[]) => h.computeFlips(...args),
  lockSsoOnlyImpact: (...args: unknown[]) => h.lockImpact(...args),
  clearPasswordsForSsoOnly: (...args: unknown[]) => h.clearPasswords(...args),
  listSsoOnlyStranded: (...args: unknown[]) => h.listStranded(...args),
}));
vi.mock('./portal/helpers', () => ({ purgePortalSessionsForUsers: h.purgePortal }));
vi.mock('../services/clientAiSessionStore', () => ({ purgeClientAiSessionsForUsers: h.purgeAi }));
vi.mock('../services/redis', () => ({ getRedis: () => ({ fake: 'redis' }) }));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!h.authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', h.authRef.current);
    await next();
  }),
  // Real-shaped gates: each denies when the stub auth lacks what it checks, so a
  // dropped requireScope / requirePermission / requireMfa / requirePartner reds a test.
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth').scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const perms: string[] | undefined = c.get('auth').perms;
    if (perms && !perms.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    await next();
  },
  requireMfa: () => async (c: any, next: any) => {
    if (c.get('auth').mfa === false) return c.json({ error: 'MFA required' }, 403);
    await next();
  },
  requirePartner: async (c: any, next: any) => {
    if (!c.get('auth')?.partnerId) return c.json({ error: 'Partner context required' }, 403);
    await next();
  },
}));

vi.mock('../db', () => ({
  db: h.db,
  hasDbAccessContext: () => true,
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  withDbTransaction: (fn: () => unknown) => fn(),
  withDbTransactionIfHeld: (fn: () => unknown) => fn(),
  runAfterDbContextCommit: (label: string, work: () => unknown) => { h.afterCommit.push({ label, work }); },
}));

vi.mock('../db/schema', () => ({
  organizations: h.organizations,
  portalAccessPolicies: h.portalAccessPolicies,
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => h.auditSpy(...args),
}));
vi.mock('../services/auditOrgResolver', () => ({
  resolveAuditOrgIdForPartner: async (partnerId: string | null) => (partnerId ? 'org-audit-1' : null),
}));
vi.mock('../services/portalEntraTenantProof', () => ({
  findProvenEntraTenantForOrg: async () => h.provenTenant.current,
}));

import { authMiddleware } from '../middleware/auth';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { __testOnly } from '../services/portalAccessPolicy';
import { ssoOnlyImpactDigest } from '../services/portalSsoOnly';
import { registerPortalAccessPolicyRoutes } from './orgPortalAccessPolicy';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '7c0a1f7e-9999-4222-8333-444455556666';
const ORG_PATH = `/organizations/${ORG_ID}/portal-access-policy`;
const PARTNER_PATH = '/partners/me/portal-access-policy';

const FULL_ADMIN = {
  scope: 'partner',
  user: { id: 'u-1', email: 'tess@msp.example' },
  partnerId: 'p-1',
  orgId: null,
  partnerOrgAccess: 'all',
  canAccessOrg: (_id: string) => true,
};
const SELECTED = {
  ...FULL_ADMIN,
  user: { id: 'u-2', email: 'sam@msp.example' },
  partnerOrgAccess: 'selected',
  canAccessOrg: (id: string) => id === ORG_ID,
};
const ORG_TOKEN = {
  scope: 'organization',
  user: { id: 'u-3', email: 'owner@customer.example' },
  partnerId: 'p-1',
  orgId: ORG_ID,
  canAccessOrg: (id: string) => id === ORG_ID,
};

const ALL_NULL = {
  entraEnabled: null,
  googleEnabled: null,
  passwordMode: null,
  selfRegistrationMode: null,
  ssoNewPersonMode: null,
  ssoSessionMaxHours: null,
};

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerPortalAccessPolicyRoutes(app);
  return app;
}

function patch(body: unknown) {
  return { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function partnerDefaultRow(fields: Record<string, unknown>) {
  return { orgId: null, partnerId: 'p-1', ...ALL_NULL, ...fields };
}

function orgOverrideRow(fields: Record<string, unknown>) {
  return { orgId: ORG_ID, partnerId: null, ...ALL_NULL, ...fields };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.authRef.current = FULL_ADMIN;
  h.store.orgs = [{ id: ORG_ID, partnerId: 'p-1' }];
  h.store.policies = [];
  h.upserts.length = 0;
  h.provenTenant.current = null;
  h.afterCommit.length = 0;
  h.computeFlips.mockReset().mockResolvedValue([]);
  h.lockImpact.mockReset().mockResolvedValue({ flips: [], clearableUserIds: [] });
  h.clearPasswords.mockReset().mockResolvedValue({ clearedUserIds: [] });
  h.listStranded.mockReset().mockResolvedValue({ items: [], total: 0 });
  // Explicit, never the deployment's (W4 derives entra from the portal Entra app env).
  __testOnly.setCapabilities({ entra: false, google: false, selfRegistration: false });
});
afterEach(() => __testOnly.setCapabilities(null));

describe('GET /organizations/:id/portal-access-policy', () => {
  it('GET org returns values (all null), inherited from partner/default, effective and capabilities', async () => {
    h.store.policies = [partnerDefaultRow({ ssoNewPersonMode: 'instant', ssoSessionMaxHours: 24 })];
    const res = await makeApp().request(ORG_PATH);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.owner).toEqual({ kind: 'org', id: ORG_ID });
    expect(data.values).toEqual(ALL_NULL);
    expect(data.inherited).toEqual({
      entraEnabled: { value: false, source: 'default' },
      googleEnabled: { value: false, source: 'default' },
      passwordMode: { value: 'allowed', source: 'default' },
      selfRegistrationMode: { value: 'off', source: 'default' },
      ssoNewPersonMode: { value: 'instant', source: 'partner' },
      ssoSessionMaxHours: { value: 24, source: 'partner' },
    });
    // No org override: the effective policy is exactly what the org inherits.
    expect(data.effective).toEqual(data.inherited);
    expect(data.passwordModeFallback).toBe(false);
    expect(data.capabilities).toEqual({ entra: false, google: false, selfRegistration: false });
    expect(data.canEdit).toBe(true);
    expect(data.entraTenantProven).toBe(false);
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('an org the partner user cannot access is 404', async () => {
    h.authRef.current = SELECTED;
    const res = await makeApp().request(`/organizations/${OTHER_ORG_ID}/portal-access-policy`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('PATCH /organizations/:id/portal-access-policy', () => {
  it('PATCH org with {} → 400 NO_UPDATES_PROVIDED', async () => {
    const res = await makeApp().request(ORG_PATH, patch({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'NO_UPDATES_PROVIDED' });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('PATCH org entraEnabled true → 400 PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE with field', async () => {
    const res = await makeApp().request(ORG_PATH, patch({ entraEnabled: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: expect.any(String),
      code: 'PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE',
      field: 'entraEnabled',
    });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('PATCH org entraEnabled true without a proven tenant → 400 PORTAL_ACCESS_POLICY_TENANT_NOT_PROVEN with field', async () => {
    __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    const res = await makeApp().request(ORG_PATH, patch({ entraEnabled: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Prove the organization's Microsoft tenant before turning on Microsoft sign-in.",
      code: 'PORTAL_ACCESS_POLICY_TENANT_NOT_PROVEN',
      field: 'entraEnabled',
    });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();

    // Proven: saved, audited, and the view says so.
    h.provenTenant.current = { tenantId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5', provenAt: new Date('2027-01-23T10:00:00.000Z') };
    const ok = await makeApp().request(ORG_PATH, patch({ entraEnabled: true }));
    expect(ok.status).toBe(200);
    const { data } = await ok.json();
    expect(data.effective.entraEnabled).toEqual({ value: true, source: 'org' });
    expect(data.entraTenantProven).toBe(true);
    expect(h.auditSpy).toHaveBeenCalledTimes(1);
  });

  it('PATCH org passwordMode sso_only with no SSO method → 400 PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO', async () => {
    const res = await makeApp().request(ORG_PATH, patch({ passwordMode: 'sso_only' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO', field: 'passwordMode' });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('PATCH org with an unknown key is 400 and writes nothing', async () => {
    const res = await makeApp().request(ORG_PATH, patch({ orgId: OTHER_ORG_ID }));
    expect(res.status).toBe(400);
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it('PATCH org for an org the partner user cannot access → 404 (no audit)', async () => {
    h.authRef.current = SELECTED;
    const res = await makeApp().request(`/organizations/${OTHER_ORG_ID}/portal-access-policy`, patch({ passwordMode: 'allowed' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('PATCH org for a missing org → 404 (no audit)', async () => {
    h.store.orgs = [];
    const res = await makeApp().request(ORG_PATH, patch({ passwordMode: 'allowed' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('PATCH org audits changedFields with before/after of changed fields only', async () => {
    h.store.policies = [
      partnerDefaultRow({ passwordMode: 'allowed' }),
      orgOverrideRow({ entraEnabled: false, ssoNewPersonMode: 'instant' }),
    ];
    // entraEnabled is patched to its stored value, so it is not a change.
    const res = await makeApp().request(ORG_PATH, patch({ entraEnabled: false, passwordMode: 'allowed', ssoNewPersonMode: null }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.owner).toEqual({ kind: 'org', id: ORG_ID });
    expect(data.values).toEqual({ ...ALL_NULL, entraEnabled: false, passwordMode: 'allowed' });
    expect(data.effective.passwordMode).toEqual({ value: 'allowed', source: 'org' });
    expect(data.effective.ssoNewPersonMode).toEqual({ value: 'approval', source: 'default' });

    expect(h.auditSpy).toHaveBeenCalledTimes(1);
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      action: 'organization.portal_access_policy.update',
      resourceType: 'organization',
      resourceId: ORG_ID,
      details: {
        changedFields: ['passwordMode', 'ssoNewPersonMode'],
        before: { passwordMode: null, ssoNewPersonMode: 'instant' },
        after: { passwordMode: 'allowed', ssoNewPersonMode: null },
      },
    });
  });

  it('PATCH org that changes nothing → 200 with the view, no write, no audit', async () => {
    h.store.policies = [orgOverrideRow({ passwordMode: 'allowed' })];
    const res = await makeApp().request(ORG_PATH, patch({ passwordMode: 'allowed', ssoSessionMaxHours: null }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.values).toEqual({ ...ALL_NULL, passwordMode: 'allowed' });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
  });
});

describe('/partners/me/portal-access-policy', () => {
  it('PATCH partner as a selected-orgs partner user → 403 ACCESS_DENIED; GET shows canEdit false', async () => {
    h.authRef.current = SELECTED;
    const res = await makeApp().request(PARTNER_PATH, patch({ passwordMode: 'allowed' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'ACCESS_DENIED' });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();

    const get = await makeApp().request(PARTNER_PATH);
    expect(get.status).toBe(200);
    const { data } = await get.json();
    expect(data.owner).toEqual({ kind: 'partner', id: 'p-1' });
    expect(data.canEdit).toBe(false);
  });

  it('GET partner as full partner admin shows its own row over the built-in defaults, canEdit true', async () => {
    h.store.policies = [
      partnerDefaultRow({ ssoSessionMaxHours: 24 }),
      orgOverrideRow({ ssoSessionMaxHours: 48 }),
    ];
    const res = await makeApp().request(PARTNER_PATH);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.owner).toEqual({ kind: 'partner', id: 'p-1' });
    expect(data.values).toEqual({ ...ALL_NULL, ssoSessionMaxHours: 24 });
    expect(data.inherited.ssoSessionMaxHours).toEqual({ value: 12, source: 'default' });
    expect(data.effective.ssoSessionMaxHours).toEqual({ value: 24, source: 'partner' });
    expect(data.canEdit).toBe(true);
    // Tenant proof is a fact about one org; a partner view has none.
    expect(data.entraTenantProven).toBeNull();
  });

  it('PATCH partner as full partner admin upserts the partner row and audits partner.portal_access_policy.update', async () => {
    const res = await makeApp().request(PARTNER_PATH, patch({ passwordMode: 'allowed', selfRegistrationMode: 'off' }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.owner).toEqual({ kind: 'partner', id: 'p-1' });
    expect(data.values).toEqual({ ...ALL_NULL, passwordMode: 'allowed', selfRegistrationMode: 'off' });
    expect(data.effective.passwordMode).toEqual({ value: 'allowed', source: 'partner' });
    expect(data.canEdit).toBe(true);

    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]!.values).toEqual({ partnerId: 'p-1', orgId: null, passwordMode: 'allowed', selfRegistrationMode: 'off' });
    expect(h.store.policies).toEqual([
      expect.objectContaining({ partnerId: 'p-1', orgId: null, passwordMode: 'allowed', selfRegistrationMode: 'off' }),
    ]);

    expect(h.auditSpy).toHaveBeenCalledTimes(1);
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org-audit-1',
      action: 'partner.portal_access_policy.update',
      resourceType: 'partner',
      resourceId: 'p-1',
      details: {
        changedFields: ['passwordMode', 'selfRegistrationMode'],
        before: { passwordMode: null, selfRegistrationMode: null },
        after: { passwordMode: 'allowed', selfRegistrationMode: 'off' },
      },
    });
  });

  it('PATCH partner with {} → 400 NO_UPDATES_PROVIDED', async () => {
    const res = await makeApp().request(PARTNER_PATH, patch({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'NO_UPDATES_PROVIDED' });
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it('PATCH partner googleEnabled true → 400 PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE with field', async () => {
    const res = await makeApp().request(PARTNER_PATH, patch({ googleEnabled: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE', field: 'googleEnabled' });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('PATCH partner that changes nothing → 200, no write, no audit', async () => {
    h.store.policies = [partnerDefaultRow({ passwordMode: 'allowed' })];
    const res = await makeApp().request(PARTNER_PATH, patch({ passwordMode: 'allowed' }));
    expect(res.status).toBe(200);
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  it('partner routes refuse a partner-scope caller with no partner context', async () => {
    h.authRef.current = { ...FULL_ADMIN, partnerId: null };
    expect((await makeApp().request(PARTNER_PATH)).status).toBe(403);
    expect((await makeApp().request(PARTNER_PATH, patch({ passwordMode: 'allowed' }))).status).toBe(403);
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it('partner routes refuse system scope (partner-scope only)', async () => {
    h.authRef.current = { ...FULL_ADMIN, scope: 'system' };
    expect((await makeApp().request(PARTNER_PATH)).status).toBe(403);
    expect((await makeApp().request(PARTNER_PATH, patch({ passwordMode: 'allowed' }))).status).toBe(403);
    expect(h.db.insert).not.toHaveBeenCalled();
  });
});

describe('gates', () => {
  const ROUTES = [
    { name: 'org', path: ORG_PATH },
    { name: 'partner', path: PARTNER_PATH },
  ];

  it('org-scope token → 403 on every route (requireScope)', async () => {
    h.authRef.current = ORG_TOKEN;
    for (const r of ROUTES) {
      expect((await makeApp().request(r.path)).status, `GET ${r.name}`).toBe(403);
      expect((await makeApp().request(r.path, patch({ passwordMode: 'allowed' }))).status, `PATCH ${r.name}`).toBe(403);
    }
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
  });

  for (const r of ROUTES) {
    it(`${r.name} PATCH requires MFA`, async () => {
      h.authRef.current = { ...FULL_ADMIN, mfa: false };
      expect((await makeApp().request(r.path, patch({ passwordMode: 'allowed' }))).status).toBe(403);
      expect(h.db.insert).not.toHaveBeenCalled();
    });

    it(`${r.name} PATCH requires organizations:write`, async () => {
      h.authRef.current = { ...FULL_ADMIN, perms: ['organizations:read'] };
      expect((await makeApp().request(r.path, patch({ passwordMode: 'allowed' }))).status).toBe(403);
      expect(h.db.insert).not.toHaveBeenCalled();
    });

    it(`${r.name} GET requires organizations:read but not write or MFA`, async () => {
      h.authRef.current = { ...FULL_ADMIN, perms: ['organizations:read'], mfa: false };
      expect((await makeApp().request(r.path)).status).toBe(200);
      h.authRef.current = { ...FULL_ADMIN, perms: [] };
      expect((await makeApp().request(r.path)).status).toBe(403);
    });
  }

  it('system scope may read and write an org policy', async () => {
    h.authRef.current = { ...FULL_ADMIN, scope: 'system', partnerId: null, partnerOrgAccess: undefined };
    expect((await makeApp().request(ORG_PATH)).status).toBe(200);
    const res = await makeApp().request(ORG_PATH, patch({ passwordMode: 'allowed' }));
    expect(res.status).toBe(200);
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, action: 'organization.portal_access_policy.update',
    }));
  });
});

// W4 (#11381) Task 9, plan D12: the sso_only save flow.
describe('sso_only save flow (D12)', () => {
  const ENTRA = { entra: true, google: false, selfRegistration: false };
  const PROVEN = { tenantId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5', provenAt: new Date('2027-01-23T10:00:00.000Z') };
  const SECOND_ORG_ID = '7c0a1f7e-2222-4222-8333-444455556666';
  const FLIP = { orgId: ORG_ID, orgName: 'Acme', passwordsToClear: 2, strandedTotal: 1 };
  const FLIP_2 = { orgId: SECOND_ORG_ID, orgName: 'Beta', passwordsToClear: 1, strandedTotal: 0 };
  const DIGEST = ssoOnlyImpactDigest([FLIP]);
  const IMPACT_PATH = `${ORG_PATH}/sso-only-impact`;
  const PARTNER_IMPACT_PATH = `${PARTNER_PATH}/sso-only-impact`;
  const STRANDED_PATH = `${ORG_PATH}/stranded`;
  const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(() => {
    __testOnly.setCapabilities(ENTRA);
    h.provenTenant.current = PROVEN;
    h.store.policies = [orgOverrideRow({ entraEnabled: true })];
  });

  async function runAfterCommit() {
    for (const { work } of h.afterCommit) await work();
  }

  it('PATCH without acknowledge → 409 with impact and nothing written', async () => {
    h.lockImpact.mockResolvedValue({ flips: [FLIP], clearableUserIds: ['pu-1', 'pu-2'] });
    const res = await makeApp().request(ORG_PATH, patch({ passwordMode: 'sso_only' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: 'PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED',
      impact: { flips: [FLIP], impactDigest: DIGEST },
    });
    expect(h.lockImpact).toHaveBeenCalledWith({ kind: 'org', orgId: ORG_ID, partnerId: 'p-1' }, { passwordMode: 'sso_only' });
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.clearPasswords).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();
    expect(h.afterCommit).toHaveLength(0);
  });

  it('PATCH with a stale digest → 409 with the fresh digest, nothing written', async () => {
    h.lockImpact.mockResolvedValue({ flips: [FLIP], clearableUserIds: ['pu-1', 'pu-2'] });
    const stale = ssoOnlyImpactDigest([{ ...FLIP, passwordsToClear: 1 }]);
    const res = await makeApp().request(`${ORG_PATH}?acknowledge=${stale}`, patch({ passwordMode: 'sso_only' }));
    expect(res.status).toBe(409);
    expect((await res.json()).impact.impactDigest).toBe(DIGEST);
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.clearPasswords).not.toHaveBeenCalled();
  });

  it('PATCH with the current digest saves, audits details.ssoOnly and purges cleared sessions only after commit', async () => {
    h.lockImpact.mockResolvedValue({ flips: [FLIP], clearableUserIds: ['pu-1', 'pu-2'] });
    h.clearPasswords.mockResolvedValue({ clearedUserIds: ['pu-1', 'pu-2'] });
    const res = await makeApp().request(`${ORG_PATH}?acknowledge=${DIGEST}`, patch({ passwordMode: 'sso_only' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });
    expect(h.upserts).toHaveLength(1);
    // The locked ids the acknowledged impact counted, not an org-wide re-select.
    expect(h.clearPasswords.mock.calls[0]![1]).toEqual({ portalUserIds: ['pu-1', 'pu-2'] });
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      action: 'organization.portal_access_policy.update',
      resourceType: 'organization',
      resourceId: ORG_ID,
      details: {
        changedFields: ['passwordMode'],
        before: { passwordMode: null },
        after: { passwordMode: 'sso_only' },
        ssoOnly: { orgIds: [ORG_ID], passwordsCleared: 2 },
      },
    });

    // Cleanup, deferred to the commit: nothing purged while the transaction is open.
    expect(h.purgePortal).not.toHaveBeenCalled();
    expect(h.afterCommit).toHaveLength(1);
    await runAfterCommit();
    expect(h.purgePortal).toHaveBeenCalledWith(['pu-1', 'pu-2']);
    expect(h.purgeAi).toHaveBeenCalledWith({ fake: 'redis' }, ['pu-1', 'pu-2']);
  });

  it('a save that flips nothing carries no ssoOnly audit detail and defers no purge', async () => {
    const res = await makeApp().request(ORG_PATH, patch({ ssoSessionMaxHours: 8 }));
    expect(res.status).toBe(200);
    const details = h.auditSpy.mock.calls[0]![1].details;
    expect(details).not.toHaveProperty('ssoOnly');
    expect(h.afterCommit).toHaveLength(0);
  });

  it('partner PATCH: 409 without an ack; with it, clears across the flipped orgs and audits partner details.ssoOnly', async () => {
    h.store.policies = [];
    h.lockImpact.mockResolvedValue({ flips: [FLIP, FLIP_2], clearableUserIds: ['pu-7'] });
    const refused = await makeApp().request(PARTNER_PATH, patch({ entraEnabled: true, passwordMode: 'sso_only' }));
    expect(refused.status).toBe(409);
    const { impact } = await refused.json();
    expect(impact.flips).toEqual([FLIP, FLIP_2]);
    expect(h.lockImpact).toHaveBeenCalledWith({ kind: 'partner', partnerId: 'p-1' }, { entraEnabled: true, passwordMode: 'sso_only' });
    expect(h.db.insert).not.toHaveBeenCalled();

    h.clearPasswords.mockResolvedValue({ clearedUserIds: ['pu-7'] });
    const ok = await makeApp().request(`${PARTNER_PATH}?acknowledge=${impact.impactDigest}`, patch({ entraEnabled: true, passwordMode: 'sso_only' }));
    expect(ok.status).toBe(200);
    expect(h.clearPasswords.mock.calls[0]![1]).toEqual({ portalUserIds: ['pu-7'] });
    expect(h.auditSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'partner.portal_access_policy.update',
      details: expect.objectContaining({ ssoOnly: { orgIds: [ORG_ID, SECOND_ORG_ID], passwordsCleared: 1 } }),
    }));
    await runAfterCommit();
    expect(h.purgePortal).toHaveBeenCalledWith(['pu-7']);
  });

  it('POST org sso-only-impact returns the flips, their digest and the stranded list; writes nothing', async () => {
    h.computeFlips.mockResolvedValue([FLIP]);
    const stranded = { items: [{ portalUserId: 'pu-3', email: 'kim@acme.example', name: 'Kim', status: 'active' }], total: 1 };
    h.listStranded.mockResolvedValue(stranded);
    const res = await makeApp().request(IMPACT_PATH, post({ passwordMode: 'sso_only' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { flips: [FLIP], impactDigest: DIGEST, stranded } });
    expect(h.computeFlips).toHaveBeenCalledWith({ kind: 'org', orgId: ORG_ID, partnerId: 'p-1' }, { passwordMode: 'sso_only' });
    expect(h.listStranded).toHaveBeenCalledWith(ORG_ID);
    expect(h.db.insert).not.toHaveBeenCalled();
    expect(h.auditSpy).not.toHaveBeenCalled();

    // The body is the PATCH schema: unknown keys are refused.
    expect((await makeApp().request(IMPACT_PATH, post({ orgId: OTHER_ORG_ID }))).status).toBe(400);
  });

  it('POST partner sso-only-impact returns the per-org flips and their digest', async () => {
    h.computeFlips.mockResolvedValue([FLIP, FLIP_2]);
    const res = await makeApp().request(PARTNER_IMPACT_PATH, post({ entraEnabled: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { flips: [FLIP, FLIP_2], impactDigest: ssoOnlyImpactDigest([FLIP, FLIP_2]) } });
    expect(h.computeFlips).toHaveBeenCalledWith({ kind: 'partner', partnerId: 'p-1' }, { entraEnabled: true });
  });

  it('GET stranded lists the org stranded accounts; an inaccessible org is 404', async () => {
    const stranded = { items: [{ portalUserId: 'pu-3', email: 'kim@acme.example', name: null, status: 'invited' }], total: 7 };
    h.listStranded.mockResolvedValue(stranded);
    const res = await makeApp().request(STRANDED_PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: stranded });
    expect(h.listStranded).toHaveBeenCalledWith(ORG_ID);

    h.authRef.current = SELECTED;
    const hidden = await makeApp().request(`/organizations/${OTHER_ORG_ID}/portal-access-policy/stranded`);
    expect(hidden.status).toBe(404);
    expect((await makeApp().request(`/organizations/${OTHER_ORG_ID}/portal-access-policy/sso-only-impact`, post({ passwordMode: 'sso_only' }))).status).toBe(404);
  });

  it('impact and stranded routes: org-scope token → 403; need organizations:read, not write or MFA', async () => {
    const reads = [
      () => makeApp().request(IMPACT_PATH, post({ passwordMode: 'sso_only' })),
      () => makeApp().request(PARTNER_IMPACT_PATH, post({ passwordMode: 'sso_only' })),
      () => makeApp().request(STRANDED_PATH),
    ];
    h.authRef.current = ORG_TOKEN;
    for (const r of reads) expect((await r()).status).toBe(403);
    h.authRef.current = { ...FULL_ADMIN, perms: ['organizations:read'], mfa: false };
    for (const r of reads) expect((await r()).status).toBe(200);
    h.authRef.current = { ...FULL_ADMIN, perms: [] };
    for (const r of reads) expect((await r()).status).toBe(403);
    // The partner impact is partner-scope only.
    h.authRef.current = { ...FULL_ADMIN, scope: 'system' };
    expect((await reads[1]!()).status).toBe(403);
  });
});
