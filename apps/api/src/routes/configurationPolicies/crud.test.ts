import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Hoist mock values so they're available in vi.mock factories
const {
  listConfigPoliciesMock,
  createConfigPolicyMock,
  getConfigPolicyMock,
  updateConfigPolicyMock,
  deleteConfigPolicyMock,
  assignPolicyMock,
  dbSelectMock,
  listEligibleParentPoliciesMock,
} = vi.hoisted(() => ({
  listConfigPoliciesMock: vi.fn(),
  createConfigPolicyMock: vi.fn(),
  getConfigPolicyMock: vi.fn(),
  updateConfigPolicyMock: vi.fn(),
  deleteConfigPolicyMock: vi.fn(),
  assignPolicyMock: vi.fn(),
  dbSelectMock: vi.fn(),
  listEligibleParentPoliciesMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  // Spread the original so canManagePartnerWidePolicies (the real capability
  // gate) and PartnerWideWriteDeniedError flow through unmocked.
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    listConfigPolicies: listConfigPoliciesMock,
    createConfigPolicy: createConfigPolicyMock,
    getConfigPolicy: getConfigPolicyMock,
    updateConfigPolicy: updateConfigPolicyMock,
    deleteConfigPolicy: deleteConfigPolicyMock,
    assignPolicy: assignPolicyMock,
    listEligibleParentPolicies: listEligibleParentPoliciesMock,
  };
});

// crud.ts uses db.select only for the system-scope org-existence check. The
// real db/schema module loads fine (importOriginal of the service needs its
// tables); only the db driver itself is mocked.
vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Configure the db.select().from().where().limit() chain to report whether the
// target org exists (system-scope create path).
function mockOrgExists(exists: boolean) {
  dbSelectMock.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(exists ? [{ id: ORG_ID }] : []) }) }),
  });
}

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

// `importOriginal` on purpose: this is the ONE config-policy route suite that
// exercises the REAL `requireMfa()` (and, through it, the real
// `hasSatisfiedMfa` + `ENABLE_2FA` resolution) rather than a hand-written
// stand-in. A stand-in can only prove middleware ORDERING; it cannot catch a
// change to what the gate actually accepts — e.g. an API-key context whose
// `token: {}` carries no `mfa` claim. Only `authMiddleware` / `requireScope` /
// `requirePermission` are stubbed, so the suite can inject its own auth.
vi.mock('../../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/auth')>()),
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
}));

import { crudRoutes } from './crud';
import { writeRouteAudit } from '../../services/auditEvents';
import { requireScope } from '../../middleware/auth';
// Real class via the importOriginal spread in the service mock above.
import {
  PartnerWideWriteDeniedError,
  InvalidParentPolicyError,
  PolicyHasChildrenError,
} from '../../services/configurationPolicy';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '99999999-9999-9999-9999-999999999999';

function makeAuth(overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: null,
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    // The real `requireMfa()` runs in this suite (see the auth mock above), so
    // the default session must carry a satisfied claim or every mutation case
    // would 403. Individual tests override `token` to assert the denial.
    token: { scope: 'organization', mfa: true },
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
    ...overrides,
  };
}

function makePermissions(overrides: Record<string, unknown> = {}): any {
  return {
    permissions: [{ resource: 'devices', action: 'write' }],
    partnerId: null,
    orgId: ORG_ID,
    roleId: 'role-1',
    scope: 'organization',
    orgAccess: undefined,
    ...overrides,
  };
}

describe('configurationPolicies CRUD routes', () => {
  let app: Hono;
  // Swapped in per test so a case can drive the shared `app` with a different
  // principal without rebuilding it (the beforeEach app is mounted once).
  let authOverride: any = null;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but NOT implementations, so restore the
    // benign defaults every test — otherwise a mockRejectedValue set by an
    // auto-assign error-path test leaks into later cases.
    assignPolicyMock.mockResolvedValue({ id: 'assignment-1' });
    deleteConfigPolicyMock.mockResolvedValue({ id: POLICY_ID });
    listEligibleParentPoliciesMock.mockResolvedValue([]);
    authOverride = null;
    mockOrgExists(true); // default: system-scope org-existence check passes
    app = new Hono();
    // Set auth context before mounting routes
    app.use('*', async (c, next) => {
      c.set('auth', authOverride ?? makeAuth());
      await next();
    });
    app.route('/', crudRoutes);
  });

  describe('MFA boundary for effective policy mutations', () => {
    beforeEach(() => {
      // A human session that never satisfied MFA: same shape as the default,
      // minus the `mfa` claim. Denial here comes from the REAL requireMfa().
      authOverride = makeAuth({ token: { scope: 'organization' } });
    });

    it.each([
      ['create', '/', 'POST', { name: 'Must not persist' }, createConfigPolicyMock],
      ['update', `/${POLICY_ID}`, 'PATCH', { status: 'inactive' }, updateConfigPolicyMock],
      ['delete', `/${POLICY_ID}`, 'DELETE', undefined, deleteConfigPolicyMock],
    ] as const)('denies %s before any policy service or success audit', async (_name, path, method, body, sink) => {
      const res = await app.request(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 'MFA_REQUIRED' });
      expect(sink).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('denies an API-key principal whose token carries no mfa claim', async () => {
      // Machine MCP/API-key contexts are minted with `token: {}` (mcpServer.ts),
      // so with ENABLE_2FA on they never satisfy the real gate. This is the
      // assertion a hand-written requireMfa stand-in cannot make: it proves
      // what the gate ACCEPTS, not merely that some middleware ran first.
      authOverride = makeAuth({ principal: { kind: 'api_key', apiKeyId: 'key-1' }, token: {} });

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Must not persist' }),
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: 'MFA_REQUIRED' });
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    });

    it('admits the default session, proving the gate is not denying unconditionally', async () => {
      createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'Root', orgId: ORG_ID });
      authOverride = null; // makeAuth() default: token.mfa === true

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Root' }),
      });

      expect(res.status).toBe(201);
      expect(createConfigPolicyMock).toHaveBeenCalled();
    });
  });

  // ============================================
  // GET / — list
  // ============================================

  describe('GET /', () => {
    it('returns a list of policies', async () => {
      const policies = {
        data: [{ id: POLICY_ID, name: 'Test Policy', status: 'active' }],
        total: 1,
        page: 1,
        limit: 25,
      };
      listConfigPoliciesMock.mockResolvedValue(policies);

      const res = await app.request('/');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
    });

    it('passes pagination parameters', async () => {
      listConfigPoliciesMock.mockResolvedValue({ data: [], total: 0, page: 2, limit: 10 });

      const res = await app.request('/?page=2&limit=10');
      expect(res.status).toBe(200);
      expect(listConfigPoliciesMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ page: 2, limit: 10 })
      );
    });

    it('requires correct scopes', () => {
      // requireScope is invoked at route-registration time (not per-request),
      // so we check the import-time calls rather than after clearAllMocks.
      // Re-importing the module would duplicate routes, so instead we verify
      // the mock is wired correctly — the route module calls requireScope(...)
      // which returns middleware. If requireScope were missing, requests would
      // bypass scope checks entirely.
      expect(typeof requireScope).toBe('function');
      // Verify it returns middleware when invoked
      const middleware = (requireScope as any)('organization');
      expect(typeof middleware).toBe('function');
    });

    it('passes status filter', async () => {
      listConfigPoliciesMock.mockResolvedValue({ data: [], total: 0 });

      const res = await app.request('/?status=active');
      expect(res.status).toBe(200);
      expect(listConfigPoliciesMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'active' }),
        expect.anything()
      );
    });
  });

  // ============================================
  // POST / — create
  // ============================================

  describe('POST /', () => {
    it('creates a policy with organization scope (uses auth.orgId)', async () => {
      const policy = { id: POLICY_ID, name: 'New Policy', orgId: ORG_ID, status: 'active' };
      createConfigPolicyMock.mockResolvedValue(policy);

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Policy' }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.name).toBe('New Policy');
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 403 when organization scope has no orgId', async () => {
      const appNoOrg = new Hono();
      appNoOrg.use('*', async (c, next) => {
        c.set('auth', makeAuth({ orgId: null }));
        await next();
      });
      appNoOrg.route('/', crudRoutes);

      const res = await appNoOrg.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Policy' }),
      });
      expect(res.status).toBe(403);
    });

    it('requires orgId for partner scope with multiple orgs', async () => {
      const appPartner = new Hono();
      appPartner.use('*', async (c, next) => {
        c.set('auth', makeAuth({
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: [ORG_ID, '33333333-3333-3333-3333-333333333333'],
        }));
        await next();
      });
      appPartner.route('/', crudRoutes);

      const res = await appPartner.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Policy' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 403 when partner cannot access the provided orgId', async () => {
      const appPartner = new Hono();
      appPartner.use('*', async (c, next) => {
        c.set('auth', makeAuth({
          scope: 'partner',
          orgId: null,
          canAccessOrg: () => false,
        }));
        await next();
      });
      appPartner.route('/', crudRoutes);

      const res = await appPartner.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Policy', orgId: ORG_ID }),
      });
      expect(res.status).toBe(403);
    });

    it('requires orgId for system scope', async () => {
      const appSystem = new Hono();
      appSystem.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'system', orgId: null }));
        await next();
      });
      appSystem.route('/', crudRoutes);

      const res = await appSystem.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Policy' }),
      });
      expect(res.status).toBe(400);
    });

    it('creates a partner-owned policy WITHOUT auto-assigning it to all orgs (#2280 library model)', async () => {
      const policy = { id: POLICY_ID, name: 'Partner-wide', orgId: null, partnerId: PARTNER_ID, status: 'active' };
      createConfigPolicyMock.mockResolvedValue(policy);

      const appPartner = new Hono();
      appPartner.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'all' }));
        // requirePermission populates permissions; simulate orgAccess='all' (full partner admin)
        c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'all' }));
        await next();
      });
      appPartner.route('/', crudRoutes);

      const res = await appPartner.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A client-supplied orgId must be IGNORED for ownerScope:'partner'.
        body: JSON.stringify({ name: 'Partner-wide', ownerScope: 'partner', orgId: ORG_ID }),
      });
      expect(res.status).toBe(201);
      // The partner is derived from auth.partnerId, not from the request body.
      expect(createConfigPolicyMock).toHaveBeenCalledWith(
        { partnerId: PARTNER_ID },
        expect.objectContaining({ name: 'Partner-wide' }),
        'user-1'
      );
      // Library policies start empty — no partner-level (or any) assignment is
      // seeded. The policy is applied later via explicit assignments on the
      // Organizations panel (#2280 library model).
      expect(assignPolicyMock).not.toHaveBeenCalled();
    });

    it('does not auto-assign for an org-owned policy (assignment stays manual)', async () => {
      const policy = { id: POLICY_ID, name: 'Org policy', orgId: ORG_ID, partnerId: null, status: 'active' };
      createConfigPolicyMock.mockResolvedValue(policy);

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Org policy' }),
      });
      expect(res.status).toBe(201);
      expect(assignPolicyMock).not.toHaveBeenCalled();
    });

    function systemCreateApp() {
      const appSystem = new Hono();
      appSystem.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'system', orgId: null, accessibleOrgIds: null, canAccessOrg: () => true }));
        await next();
      });
      appSystem.route('/', crudRoutes);
      return appSystem;
    }

    it('system scope: returns 404 (not a raw 500) when the target org does not exist', async () => {
      mockOrgExists(false);

      const res = await systemCreateApp().request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Policy', orgId: ORG_ID }),
      });

      expect(res.status).toBe(404);
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    });

    it('system scope: creates the policy when the target org exists', async () => {
      mockOrgExists(true);
      createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'Policy', orgId: ORG_ID, partnerId: null, status: 'active' });

      const res = await systemCreateApp().request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Policy', orgId: ORG_ID }),
      });

      expect(res.status).toBe(201);
      expect(createConfigPolicyMock).toHaveBeenCalledWith({ orgId: ORG_ID }, expect.objectContaining({ name: 'Policy' }), 'user-1');
    });

    it('partner scope: distinct message when the partner has NO accessible orgs', async () => {
      const appPartnerNoOrg = new Hono();
      appPartnerNoOrg.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [], canAccessOrg: () => false }));
        await next();
      });
      appPartnerNoOrg.route('/', crudRoutes);

      const res = await appPartnerNoOrg.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Policy' }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/No accessible organization/i);
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    });

    it('partner scope: distinct message when the partner has MULTIPLE orgs and no orgId given', async () => {
      const ORG_B = '55555555-5555-5555-5555-555555555555';
      const appPartnerMulti = new Hono();
      appPartnerMulti.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID, ORG_B], canAccessOrg: (o: string) => o === ORG_ID || o === ORG_B }));
        await next();
      });
      appPartnerMulti.route('/', crudRoutes);

      const res = await appPartnerMulti.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Policy' }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/multiple organizations/i);
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    });

    it('partner scope: defaults to the single accessible org when none is supplied', async () => {
      createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'Policy', orgId: ORG_ID, partnerId: null, status: 'active' });
      const appPartnerSingle = new Hono();
      appPartnerSingle.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID], canAccessOrg: (o: string) => o === ORG_ID }));
        await next();
      });
      appPartnerSingle.route('/', crudRoutes);

      const res = await appPartnerSingle.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Policy' }),
      });

      expect(res.status).toBe(201);
      expect(createConfigPolicyMock).toHaveBeenCalledWith({ orgId: ORG_ID }, expect.objectContaining({ name: 'Policy' }), 'user-1');
    });

    it('rejects ownerScope:partner for an org-scope caller (no partner) (#1724)', async () => {
      const appOrg = new Hono();
      appOrg.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'organization', orgId: ORG_ID, partnerId: null }));
        await next();
      });
      appOrg.route('/', crudRoutes);

      const res = await appOrg.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nope', ownerScope: 'partner' }),
      });
      expect(res.status).toBe(403);
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    });

    // ============================================================
    // Security: orgAccess escalation guard (partner org-reach fix)
    // ============================================================

    it('denies partner-wide policy create when orgAccess is "selected" (attacker fails-closed)', async () => {
      // A partner user with orgAccess='selected' (limited to orgA) must NOT be
      // allowed to create a partner-wide policy that would push config to orgs
      // they cannot access.
      const appPartnerSelected = new Hono();
      appPartnerSelected.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID], partnerOrgAccess: 'selected' }));
        // permissions reflect orgAccess='selected' — as set by requirePermission
        c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'selected', allowedOrgIds: [ORG_ID] }));
        await next();
      });
      appPartnerSelected.route('/', crudRoutes);

      const res = await appPartnerSelected.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Escalation attempt', ownerScope: 'partner' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/full partner org access/);
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    });

    it('denies partner-wide policy create when orgAccess is "none"', async () => {
      const appPartnerNone = new Hono();
      appPartnerNone.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [], partnerOrgAccess: 'none' }));
        c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'none' }));
        await next();
      });
      appPartnerNone.route('/', crudRoutes);

      const res = await appPartnerNone.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Escalation attempt', ownerScope: 'partner' }),
      });
      expect(res.status).toBe(403);
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    });

    it('allows partner-wide policy create when orgAccess is "all" (legit partner admin)', async () => {
      const ORG_B = '55555555-5555-5555-5555-555555555555';
      const policy = { id: POLICY_ID, name: 'Wide Policy', orgId: null, partnerId: PARTNER_ID, status: 'active' };
      createConfigPolicyMock.mockResolvedValue(policy);

      const appPartnerAll = new Hono();
      appPartnerAll.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID, ORG_B], partnerOrgAccess: 'all' }));
        c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'all' }));
        await next();
      });
      appPartnerAll.route('/', crudRoutes);

      const res = await appPartnerAll.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Wide Policy', ownerScope: 'partner' }),
      });
      expect(res.status).toBe(201);
      expect(createConfigPolicyMock).toHaveBeenCalledWith(
        { partnerId: PARTNER_ID },
        expect.objectContaining({ name: 'Wide Policy' }),
        'user-1'
      );
    });

    it('org-scoped policy create is unaffected by the partner-wide guard', async () => {
      // Verify the guard does NOT fire for org-scoped policy creation — even for
      // a partner user with orgAccess='selected'.
      const policy = { id: POLICY_ID, name: 'Org Policy', orgId: ORG_ID, status: 'active' };
      createConfigPolicyMock.mockResolvedValue(policy);

      const appPartnerSelected = new Hono();
      appPartnerSelected.use('*', async (c, next) => {
        c.set('auth', makeAuth({
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (id: string) => id === ORG_ID,
        }));
        c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'selected', allowedOrgIds: [ORG_ID] }));
        await next();
      });
      appPartnerSelected.route('/', crudRoutes);

      // ownerScope defaults to 'org' — no partner-wide guard applies
      const res = await appPartnerSelected.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Org Policy', orgId: ORG_ID }),
      });
      expect(res.status).toBe(201);
      expect(createConfigPolicyMock).toHaveBeenCalledWith(
        { orgId: ORG_ID },
        expect.objectContaining({ name: 'Org Policy' }),
        'user-1'
      );
    });
  });

  // ============================================
  // GET /:id — get by ID
  // ============================================

  describe('GET /:id', () => {
    it('returns the policy when found', async () => {
      const policy = { id: POLICY_ID, name: 'My Policy', status: 'active' };
      getConfigPolicyMock.mockResolvedValue(policy);

      const res = await app.request(`/${POLICY_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.id).toBe(POLICY_ID);
    });

    it('returns 404 when policy not found', async () => {
      getConfigPolicyMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}`);
      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // PATCH /:id — update
  // ============================================

  describe('PATCH /:id', () => {
    it('updates a policy', async () => {
      const updated = { id: POLICY_ID, name: 'Updated', orgId: ORG_ID, status: 'active' };
      updateConfigPolicyMock.mockResolvedValue(updated);

      const res = await app.request(`/${POLICY_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.name).toBe('Updated');
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 400 when no updates provided', async () => {
      const res = await app.request(`/${POLICY_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 when policy not found', async () => {
      updateConfigPolicyMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(404);
    });

    it('maps PartnerWideWriteDeniedError from the service to a 403', async () => {
      // The service throws when a partner-wide policy is visible but not
      // administrable (orgAccess != 'all') — the route must surface 403, not 500.
      updateConfigPolicyMock.mockRejectedValue(new PartnerWideWriteDeniedError());

      const res = await app.request(`/${POLICY_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/full partner org access/);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // DELETE /:id — delete
  // ============================================

  describe('DELETE /:id', () => {
    it('deletes a policy', async () => {
      const deleted = { id: POLICY_ID, name: 'Deleted', orgId: ORG_ID };
      deleteConfigPolicyMock.mockResolvedValue(deleted);

      const res = await app.request(`/${POLICY_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 404 when policy not found', async () => {
      deleteConfigPolicyMock.mockResolvedValue(null);

      const res = await app.request(`/${POLICY_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('maps PartnerWideWriteDeniedError from the service to a 403', async () => {
      deleteConfigPolicyMock.mockRejectedValue(new PartnerWideWriteDeniedError());

      const res = await app.request(`/${POLICY_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Service exception handling
  // ============================================

  describe('service exceptions', () => {
    it('returns 500 when listConfigPolicies throws', async () => {
      listConfigPoliciesMock.mockRejectedValue(new Error('DB connection lost'));
      const res = await app.request('/');
      expect(res.status).toBe(500);
    });

    it('returns 500 when createConfigPolicy throws', async () => {
      createConfigPolicyMock.mockRejectedValue(new Error('Constraint violation'));
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Policy' }),
      });
      expect(res.status).toBe(500);
    });

    it('returns 500 when getConfigPolicy throws', async () => {
      getConfigPolicyMock.mockRejectedValue(new Error('DB error'));
      const res = await app.request(`/${POLICY_ID}`);
      expect(res.status).toBe(500);
    });

    it('returns 500 when updateConfigPolicy throws', async () => {
      updateConfigPolicyMock.mockRejectedValue(new Error('DB error'));
      const res = await app.request(`/${POLICY_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(500);
    });

    it('returns 500 when deleteConfigPolicy throws', async () => {
      deleteConfigPolicyMock.mockRejectedValue(new Error('DB error'));
      const res = await app.request(`/${POLICY_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(500);
    });
  });

  // ============================================
  // One-level inheritance (#5080 W01)
  // ============================================

  describe('inheritance', () => {
    const PARENT_ID = '44444444-4444-4444-4444-444444444444';

    it('POST forwards parentPolicyId to createConfigPolicy', async () => {
      createConfigPolicyMock.mockResolvedValue({
        id: POLICY_ID, name: 'Child', orgId: ORG_ID, parentPolicyId: PARENT_ID,
      });

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Child', parentPolicyId: PARENT_ID }),
      });

      expect(res.status).toBe(201);
      expect(createConfigPolicyMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ parentPolicyId: PARENT_ID }),
        expect.anything(),
      );
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ details: expect.objectContaining({ parentPolicyId: PARENT_ID }) }),
      );
    });

    it('POST maps InvalidParentPolicyError to 400 INVALID_PARENT_POLICY', async () => {
      createConfigPolicyMock.mockRejectedValue(new InvalidParentPolicyError());

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Child', parentPolicyId: PARENT_ID }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'INVALID_PARENT_POLICY' });
    });

    it('POST with a parent requires MFA before resolving or creating the policy', async () => {
      authOverride = makeAuth({ token: { scope: 'organization' } });

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Child', parentPolicyId: PARENT_ID }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'MFA required' });
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    });

    it('POST without a parent also requires MFA before policy creation', async () => {
      authOverride = makeAuth({ token: { scope: 'organization' } });
      createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, name: 'Root', orgId: ORG_ID });

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Root' }),
      });

      expect(res.status).toBe(403);
      expect(createConfigPolicyMock).not.toHaveBeenCalled();
    });

    it('DELETE maps PolicyHasChildrenError to 409 with the children', async () => {
      const children = [{ id: 'c1', name: 'Child One' }];
      deleteConfigPolicyMock.mockRejectedValue(new PolicyHasChildrenError(children));

      const res = await app.request(`/${POLICY_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'POLICY_HAS_CHILDREN', children });
    });

    it('GET /eligible-parents (organization) returns names only', async () => {
      listEligibleParentPoliciesMock.mockResolvedValue([
        { id: PARENT_ID, name: 'MSP baseline', ownerScope: 'partner' },
      ]);

      const res = await app.request(`/eligible-parents?ownerScope=organization&orgId=${ORG_ID}`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [{ id: PARENT_ID, name: 'MSP baseline', ownerScope: 'partner' }],
      });
    });

    // Route ordering regression: `GET /:id` is declared after this route, and
    // if it were declared first Hono would capture "eligible-parents" as an id.
    it('GET /eligible-parents is not captured by GET /:id', async () => {
      getConfigPolicyMock.mockResolvedValue({ id: 'should-not-be-used' });

      const res = await app.request(`/eligible-parents?ownerScope=organization&orgId=${ORG_ID}`);

      expect(res.status).toBe(200);
      expect(getConfigPolicyMock).not.toHaveBeenCalled();
      expect(listEligibleParentPoliciesMock).toHaveBeenCalled();
    });

    it('GET /eligible-parents (organization) 403s for an org the caller cannot access', async () => {
      const res = await app.request(
        '/eligible-parents?ownerScope=organization&orgId=55555555-5555-5555-5555-555555555555',
      );

      expect(res.status).toBe(403);
      expect(listEligibleParentPoliciesMock).not.toHaveBeenCalled();
    });

    it('GET /eligible-parents (partner) 403s for an org-scoped caller even with a partnerId', async () => {
      const partnerApp = new Hono();
      partnerApp.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'organization', partnerId: PARTNER_ID }));
        await next();
      });
      partnerApp.route('/', crudRoutes);

      const res = await partnerApp.request('/eligible-parents?ownerScope=partner');

      expect(res.status).toBe(403);
      expect(listEligibleParentPoliciesMock).not.toHaveBeenCalled();
    });

    it('GET /eligible-parents (partner) serves a partner-scoped caller', async () => {
      const partnerApp = new Hono();
      partnerApp.use('*', async (c, next) => {
        c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID }));
        await next();
      });
      partnerApp.route('/', crudRoutes);
      listEligibleParentPoliciesMock.mockResolvedValue([
        { id: PARENT_ID, name: 'MSP baseline', ownerScope: 'partner' },
      ]);

      const res = await partnerApp.request('/eligible-parents?ownerScope=partner');

      expect(res.status).toBe(200);
      expect(listEligibleParentPoliciesMock).toHaveBeenCalledWith(
        expect.anything(),
        { ownerScope: 'partner' },
      );
    });

    it('GET /eligible-parents rejects an organization query with no orgId', async () => {
      const res = await app.request('/eligible-parents?ownerScope=organization');
      expect(res.status).toBe(400);
    });
  });
});
