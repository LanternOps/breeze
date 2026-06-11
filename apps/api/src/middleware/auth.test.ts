import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/jwt', () => ({
  verifyToken: vi.fn()
}));

vi.mock('../services/permissions', () => ({
  getUserPermissions: vi.fn(),
  hasPermission: vi.fn(),
  canAccessOrg: vi.fn(),
  canAccessSite: vi.fn(),
  clearPermissionCache: vi.fn(),
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    SCRIPTS_READ: { resource: 'scripts', action: 'read' },
    SCRIPTS_WRITE: { resource: 'scripts', action: 'write' }
  }
}));

vi.mock('../services/tokenRevocation', () => ({
  isUserTokenRevoked: vi.fn().mockResolvedValue(false)
}));

vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn()
}));

// Default to pass-through; the propagation test below overrides it to
// return a deny Response the way the real guard does.
const ipGuardMocks = vi.hoisted(() => ({
  ipAllowlistGuard: vi.fn(async (_c: unknown, next: () => Promise<void>) => {
    await next();
  })
}));

vi.mock('./ipAllowlistGuard', () => ({
  ipAllowlistGuard: ipGuardMocks.ipAllowlistGuard
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  db: {
    select: vi.fn()
  },
  withDbAccessContext: vi.fn(async (_context, fn) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn())
}));

vi.mock('../db/schema', () => ({
  users: {
    id: 'id',
    email: 'email',
    name: 'name',
    status: 'status',
    mfaEnabled: 'mfaEnabled',
    isPlatformAdmin: 'isPlatformAdmin'
  },
  partnerUsers: {
    userId: 'partnerUsers.userId',
    partnerId: 'partnerUsers.partnerId',
    roleId: 'partnerUsers.roleId',
    orgAccess: 'partnerUsers.orgAccess',
    orgIds: 'partnerUsers.orgIds'
  },
  organizationUsers: {
    userId: 'organizationUsers.userId',
    orgId: 'organizationUsers.orgId',
    roleId: 'organizationUsers.roleId'
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId'
  },
  roles: {
    id: 'roles.id',
    forceMfa: 'roles.forceMfa'
  }
}));

import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission, requireMfa, requireOrg, requirePartner, requireOrgAccess, resolveOrgAccess, AuthContext } from './auth';
import { verifyToken } from '../services/jwt';
import { isUserTokenRevoked } from '../services/tokenRevocation';
import { db, withDbAccessContext } from '../db';
import { getUserPermissions, hasPermission, canAccessOrg } from '../services/permissions';
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';

const basePayload = {
  sub: 'user-123',
  email: 'test@example.com',
  roleId: 'role-123',
  orgId: 'org-123',
  partnerId: 'partner-123',
  scope: 'organization' as const,
  type: 'access' as const,
  mfa: false
};

const activeUser = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  status: 'active',
  // Default to enrolled so existing tests don't pick up the new role-MFA
  // gate; the gate-specific tests below override this explicitly.
  mfaEnabled: true,
  isPlatformAdmin: false
};

// User who hasn't enrolled MFA yet — used by force_mfa gate tests.
const unenrolledUser = {
  ...activeUser,
  mfaEnabled: false
};

const baseAuth = {
  user: {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    isPlatformAdmin: false
  },
  token: basePayload,
  partnerId: basePayload.partnerId,
  orgId: basePayload.orgId,
  scope: basePayload.scope,
  accessibleOrgIds: [basePayload.orgId],
  orgCondition: vi.fn(),
  canAccessOrg: (orgId: string) => orgId === basePayload.orgId
};

function mockUserSelect(rows: Array<typeof activeUser>) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  } as any);
}

function selectWithLimit(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

function selectWithWhere(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows)
    })
  };
}

function buildAuthApp() {
  const app = new Hono();
  app.use(authMiddleware);
  app.get('/test', (c) => c.json({ auth: c.get('auth') }));
  return app;
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(verifyToken).mockReset();
    vi.mocked(isUserTokenRevoked).mockResolvedValue(false);
    vi.mocked(assertActiveTenantContext).mockResolvedValue(undefined);
  });

  it('rejects missing authorization header', async () => {
    const app = buildAuthApp();

    const res = await app.request('/test');

    expect(res.status).toBe(401);
    expect(vi.mocked(verifyToken)).not.toHaveBeenCalled();
  });

  it('rejects invalid token', async () => {
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue(null);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer invalid' }
    });

    expect(res.status).toBe(401);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('rejects non-access token', async () => {
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue({ ...basePayload, type: 'refresh' });

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(401);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('rejects when user is missing', async () => {
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue(basePayload);
    mockUserSelect([]);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(401);
  });

  it('rejects when user is inactive', async () => {
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue(basePayload);
    mockUserSelect([{ ...activeUser, status: 'suspended' }]);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(403);
  });

  it('sets auth context for valid token', async () => {
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue(basePayload);
    mockUserSelect([activeUser]);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(verifyToken)).toHaveBeenCalledWith('token');
    const body = await res.json();
    expect(body.auth).toMatchObject({
      user: {
        id: activeUser.id,
        email: activeUser.email,
        name: activeUser.name
      },
      token: basePayload,
      partnerId: basePayload.partnerId,
      orgId: basePayload.orgId,
      scope: basePayload.scope
    });
    expect(vi.mocked(withDbAccessContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: basePayload.scope,
        orgId: basePayload.orgId,
        accessibleOrgIds: [basePayload.orgId]
      }),
      expect.any(Function)
    );
  });

  it('propagates the ipAllowlistGuard deny Response instead of swallowing it', async () => {
    // Regression: the guard returns its 403 as a value (it does not throw).
    // authMiddleware must return the withDbAccessContext result, otherwise
    // the Response is dropped, the Hono context is never finalized, and the
    // request 500s with "Context is not finalized" instead of the 403.
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue(basePayload);
    mockUserSelect([activeUser]);
    ipGuardMocks.ipAllowlistGuard.mockImplementationOnce(async (c: any) =>
      c.json({ code: 'ip_not_allowed', error: 'Access denied from this IP address' }, 403)
    );

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('ip_not_allowed');
  });

  it('rejects active users when their tenant context is inactive or deleted', async () => {
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue(basePayload);
    vi.mocked(assertActiveTenantContext).mockRejectedValue(new TenantInactiveError('Organization is not active'));
    mockUserSelect([activeUser]);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(403);
  });

  it('rejects revoked access tokens', async () => {
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue(basePayload);
    vi.mocked(isUserTokenRevoked).mockResolvedValue(true);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(401);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('restricts partner scope to selected orgIds from partner membership', async () => {
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue({
      ...basePayload,
      scope: 'partner',
      orgId: null
    });

    vi.mocked(db.select)
      .mockReturnValueOnce(selectWithLimit([activeUser]) as any)
      .mockReturnValueOnce(selectWithLimit([{ orgAccess: 'selected', orgIds: ['org-a', 'org-b'] }]) as any)
      .mockReturnValueOnce(selectWithWhere([{ id: 'org-a' }]) as any);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth.scope).toBe('partner');
    expect(body.auth.accessibleOrgIds).toEqual(['org-a']);
  });

  it('enforces partner orgAccess=none as no accessible organizations', async () => {
    const app = buildAuthApp();
    vi.mocked(verifyToken).mockResolvedValue({
      ...basePayload,
      scope: 'partner',
      orgId: null
    });

    vi.mocked(db.select)
      .mockReturnValueOnce(selectWithLimit([activeUser]) as any)
      .mockReturnValueOnce(selectWithLimit([{ orgAccess: 'none', orgIds: null }]) as any);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth.scope).toBe('partner');
    expect(body.auth.accessibleOrgIds).toEqual([]);
  });

  // ---- Role-level force_mfa gate (Task 8) ----
  //
  // Builds a select chain that supports the role-lookup inner-join:
  //   db.select({...}).from(table).innerJoin(roles, ...).where(...).limit(1)
  function selectWithJoinLimit(rows: unknown[]) {
    return {
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows)
          })
        })
      })
    };
  }

  it('returns 428 mfa_enrollment_required when a force_mfa role user has no MFA enabled', async () => {
    const app = new Hono();
    app.use(authMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
    app.post('/api/v1/partner/me', (c) => c.json({ ok: true }));

    vi.mocked(verifyToken).mockResolvedValue({
      ...basePayload,
      scope: 'partner',
      orgId: null
    });

    vi.mocked(db.select)
      // 1) user lookup
      .mockReturnValueOnce(selectWithLimit([unenrolledUser]) as any)
      // 2) role lookup via partner_users INNER JOIN roles
      .mockReturnValueOnce(selectWithJoinLimit([{ forceMfa: true }]) as any);

    const res = await app.request('/api/v1/partner/me', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body).toEqual({
      error: 'mfa_enrollment_required',
      enrollUrl: '/auth/mfa/setup'
    });
  });

  it('allows force_mfa role user to reach /auth/mfa/setup-totp while in mfa-required state', async () => {
    const app = new Hono();
    app.use(authMiddleware);
    app.post('/api/v1/auth/mfa/setup-totp', (c) => c.json({ secret: 'abc' }));

    vi.mocked(verifyToken).mockResolvedValue({
      ...basePayload,
      scope: 'partner',
      orgId: null
    });

    vi.mocked(db.select)
      // 1) user lookup
      .mockReturnValueOnce(selectWithLimit([unenrolledUser]) as any)
      // 2) role lookup — would say "force MFA" but we never reach it
      //    because the path is exempt before the gate runs role lookup.
      //    Still — the gate path-checks AFTER doing the role lookup, so
      //    we still need to return forceMfa here.
      .mockReturnValueOnce(selectWithJoinLimit([{ forceMfa: true }]) as any)
      // 3) computeAccessibleOrgIds → partnerUsers (orgAccess only)
      .mockReturnValueOnce(selectWithLimit([{ orgAccess: 'none', orgIds: null }]) as any);

    const res = await app.request('/api/v1/auth/mfa/setup-totp', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).not.toBe(428);
    expect(res.status).toBe(200);
  });

  it('permits force_mfa role user once MFA is enabled (skips role lookup entirely)', async () => {
    const app = new Hono();
    app.use(authMiddleware);
    app.post('/api/v1/partner/me', (c) => c.json({ ok: true }));

    vi.mocked(verifyToken).mockResolvedValue({
      ...basePayload,
      scope: 'partner',
      orgId: null,
      mfa: true
    });

    vi.mocked(db.select)
      // 1) user lookup — mfaEnabled=true (default activeUser)
      .mockReturnValueOnce(selectWithLimit([activeUser]) as any)
      // 2) Gate is skipped, so the next select is computeAccessibleOrgIds
      .mockReturnValueOnce(selectWithLimit([{ orgAccess: 'none', orgIds: null }]) as any);

    const res = await app.request('/api/v1/partner/me', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
  });

  it('does not gate users whose role does NOT have force_mfa', async () => {
    const app = new Hono();
    app.use(authMiddleware);
    app.post('/api/v1/partner/me', (c) => c.json({ ok: true }));

    vi.mocked(verifyToken).mockResolvedValue({
      ...basePayload,
      scope: 'partner',
      orgId: null
    });

    vi.mocked(db.select)
      .mockReturnValueOnce(selectWithLimit([unenrolledUser]) as any)
      // forceMfa=false → gate passes
      .mockReturnValueOnce(selectWithJoinLimit([{ forceMfa: false }]) as any)
      // computeAccessibleOrgIds
      .mockReturnValueOnce(selectWithLimit([{ orgAccess: 'none', orgIds: null }]) as any);

    const res = await app.request('/api/v1/partner/me', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
  });

  it('does not gate system-scope users (platform admin uses a user flag, not a role)', async () => {
    const app = new Hono();
    app.use(authMiddleware);
    app.post('/api/v1/partner/me', (c) => c.json({ ok: true }));

    vi.mocked(verifyToken).mockResolvedValue({
      ...basePayload,
      scope: 'system',
      partnerId: null,
      orgId: null
    });

    vi.mocked(db.select)
      // Just the user lookup — system scope skips force_mfa lookup
      // (no partner/org membership), and computeAccessibleOrgIds returns
      // null for system scope without a query.
      .mockReturnValueOnce(selectWithLimit([{ ...unenrolledUser, isPlatformAdmin: true }]) as any);

    const res = await app.request('/api/v1/partner/me', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
  });

  // Kill-switch: MFA_FORCE_FOR_PARTNER_ADMIN=false disables the gate
  // even for users in force_mfa roles, and short-circuits BEFORE the
  // role lookup so a misconfigured DB can't fail the request either.
  it('skips the gate entirely when MFA_FORCE_FOR_PARTNER_ADMIN=false', async () => {
    const prev = process.env.MFA_FORCE_FOR_PARTNER_ADMIN;
    process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false';
    try {
      const app = new Hono();
      app.use(authMiddleware);
      app.post('/api/v1/partner/me', (c) => c.json({ ok: true }));

      vi.mocked(verifyToken).mockResolvedValue({
        ...basePayload,
        scope: 'partner',
        orgId: null
      });

      vi.mocked(db.select)
        // Only the user lookup — the role lookup must be skipped, so we
        // intentionally do NOT mock selectWithJoinLimit. If the middleware
        // calls db.select a second time the mock returns undefined and the
        // test fails with a destructuring error, proving the short-circuit.
        .mockReturnValueOnce(selectWithLimit([unenrolledUser]) as any)
        // computeAccessibleOrgIds (last select)
        .mockReturnValueOnce(selectWithLimit([{ orgAccess: 'none', orgIds: null }]) as any);

      const res = await app.request('/api/v1/partner/me', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.MFA_FORCE_FOR_PARTNER_ADMIN;
      else process.env.MFA_FORCE_FOR_PARTNER_ADMIN = prev;
    }
  });
});

describe('requireScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when auth context is missing', async () => {
    const app = new Hono();
    app.use(requireScope('organization'));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(401);
  });

  it('rejects when scope is insufficient', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', { ...baseAuth, scope: 'partner' });
      await next();
    });
    app.use(requireScope('organization'));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(403);
  });

  it('allows when scope matches', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use(requireScope('organization', 'partner'));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe('resolveOrgAccess', () => {
  describe('organization scope', () => {
    it('returns single org for org user without requested org', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'organization',
        orgId: 'org-123',
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (id) => id === 'org-123',
      } as AuthContext;

      const result = await resolveOrgAccess(auth);

      expect(result).toEqual({ type: 'single', orgId: 'org-123' });
    });

    it('returns single org when requestedOrgId matches the user org', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'organization',
        orgId: 'org-123',
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (id) => id === 'org-123',
      } as AuthContext;

      const result = await resolveOrgAccess(auth, 'org-123');

      expect(result).toEqual({ type: 'single', orgId: 'org-123' });
    });

    it('returns 403 error when requestedOrgId is a different org', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'organization',
        orgId: 'org-123',
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (id) => id === 'org-123',
      } as AuthContext;

      const result = await resolveOrgAccess(auth, 'org-other');

      expect(result).toEqual({
        type: 'error',
        error: 'Access to this organization denied',
        status: 403
      });
    });

    it('returns 403 error when org user has null orgId', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'organization',
        orgId: null,
        accessibleOrgIds: [],
        canAccessOrg: () => false,
      } as AuthContext;

      const result = await resolveOrgAccess(auth);

      expect(result).toEqual({
        type: 'error',
        error: 'Organization context required',
        status: 403
      });
    });
  });

  describe('partner scope', () => {
    it('returns single org when partner user requests an org they can access', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'partner',
        orgId: null,
        partnerId: 'partner-123',
        accessibleOrgIds: ['org-123', 'org-456'],
        canAccessOrg: (id) => ['org-123', 'org-456'].includes(id),
      } as AuthContext;

      const result = await resolveOrgAccess(auth, 'org-456');

      expect(result).toEqual({ type: 'single', orgId: 'org-456' });
    });

    it('returns 403 error when partner user requests an org they cannot access', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'partner',
        orgId: null,
        partnerId: 'partner-123',
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (id) => id === 'org-123',
      } as AuthContext;

      const result = await resolveOrgAccess(auth, 'org-not-allowed');

      expect(result).toEqual({
        type: 'error',
        error: 'Access to this organization denied',
        status: 403
      });
    });

    it('returns multiple orgs when partner user provides no requestedOrgId', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'partner',
        orgId: null,
        partnerId: 'partner-123',
        accessibleOrgIds: ['org-123', 'org-456'],
        canAccessOrg: (id) => ['org-123', 'org-456'].includes(id),
      } as AuthContext;

      const result = await resolveOrgAccess(auth);

      expect(result).toEqual({ type: 'multiple', orgIds: ['org-123', 'org-456'] });
    });

    it('returns empty array when partner user has null accessibleOrgIds', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'partner',
        orgId: null,
        partnerId: 'partner-123',
        accessibleOrgIds: null,
        canAccessOrg: () => false,
      } as AuthContext;

      const result = await resolveOrgAccess(auth);

      expect(result).toEqual({ type: 'multiple', orgIds: [] });
    });

    it('returns 403 error when partner user has null partnerId', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'partner',
        orgId: null,
        partnerId: null,
        accessibleOrgIds: null,
        canAccessOrg: () => false,
      } as AuthContext;

      const result = await resolveOrgAccess(auth);

      expect(result).toEqual({
        type: 'error',
        error: 'Partner context required',
        status: 403
      });
    });
  });

  describe('system scope', () => {
    it('returns single org when system user requests a specific org', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'system',
        orgId: null,
        partnerId: null,
        accessibleOrgIds: null,
        canAccessOrg: () => true,
      } as AuthContext;

      const result = await resolveOrgAccess(auth, 'org-any');

      expect(result).toEqual({ type: 'single', orgId: 'org-any' });
    });

    it('returns all when system user provides no requestedOrgId', async () => {
      const auth: AuthContext = {
        ...baseAuth,
        scope: 'system',
        orgId: null,
        partnerId: null,
        accessibleOrgIds: null,
        canAccessOrg: () => true,
      } as AuthContext;

      const result = await resolveOrgAccess(auth);

      expect(result).toEqual({ type: 'all' });
    });
  });
});

describe('requirePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPerms = {
    permissions: [{ resource: 'devices', action: 'read' }],
    partnerId: null,
    orgId: 'org-123',
    roleId: 'role-1',
    scope: 'organization' as const
  };

  it('rejects unauthenticated request (no auth context)', async () => {
    const app = new Hono();
    app.use(requirePermission('devices', 'read'));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(401);
  });

  it('rejects when getUserPermissions returns null', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use(requirePermission('devices', 'read'));
    app.get('/test', (c) => c.json({ ok: true }));

    vi.mocked(getUserPermissions).mockResolvedValue(null);

    const res = await app.request('/test');

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe('No permissions found');
  });

  it('rejects when user lacks the required permission', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use(requirePermission('devices', 'write'));
    app.get('/test', (c) => c.json({ ok: true }));

    vi.mocked(getUserPermissions).mockResolvedValue(mockPerms);
    vi.mocked(hasPermission).mockReturnValue(false);

    const res = await app.request('/test');

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe('Permission denied');
  });

  it('allows when user has the exact required permission', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use(requirePermission('devices', 'read'));
    app.get('/test', (c) => c.json({ ok: true }));

    vi.mocked(getUserPermissions).mockResolvedValue(mockPerms);
    vi.mocked(hasPermission).mockReturnValue(true);

    const res = await app.request('/test');

    expect(res.status).toBe(200);
    expect(vi.mocked(hasPermission)).toHaveBeenCalledWith(mockPerms, 'devices', 'read');
  });

  it('allows when user has wildcard permission', async () => {
    const wildcardPerms = {
      ...mockPerms,
      permissions: [{ resource: '*', action: '*' }]
    };
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use(requirePermission('devices', 'write'));
    app.get('/test', (c) => c.json({ ok: true }));

    vi.mocked(getUserPermissions).mockResolvedValue(wildcardPerms);
    vi.mocked(hasPermission).mockReturnValue(true);

    const res = await app.request('/test');

    expect(res.status).toBe(200);
  });

  it('stores permissions in context after successful check', async () => {
    let capturedPerms: any;
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use(requirePermission('devices', 'read'));
    app.get('/test', (c: any) => {
      capturedPerms = c.get('permissions');
      return c.json({ ok: true });
    });

    vi.mocked(getUserPermissions).mockResolvedValue(mockPerms);
    vi.mocked(hasPermission).mockReturnValue(true);

    const res = await app.request('/test');

    expect(res.status).toBe(200);
    expect(capturedPerms).toEqual(mockPerms);
  });
});

describe('requireMfa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when there is no auth context', async () => {
    const app = new Hono();
    app.use(requireMfa());
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(401);
  });

  it('rejects when token.mfa is false', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', { ...baseAuth, token: { ...basePayload, mfa: false } });
      await next();
    });
    app.use(requireMfa());
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe('MFA required');
  });

  it('allows when token.mfa is true', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', { ...baseAuth, token: { ...basePayload, mfa: true } });
      await next();
    });
    app.use(requireMfa());
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe('requireOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when there is no auth context', async () => {
    const app = new Hono();
    app.use(requireOrg);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(403);
  });

  it('rejects when orgId is null', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', { ...baseAuth, orgId: null });
      await next();
    });
    app.use(requireOrg);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe('Organization context required');
  });

  it('allows when auth has an orgId', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use(requireOrg);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe('requirePartner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when there is no auth context', async () => {
    const app = new Hono();
    app.use(requirePartner);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(403);
  });

  it('rejects when partnerId is null', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', { ...baseAuth, partnerId: null });
      await next();
    });
    app.use(requirePartner);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe('Partner context required');
  });

  it('allows when auth has a partnerId', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use(requirePartner);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

describe('requireOrgAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPermsForOrg = {
    permissions: [{ resource: 'devices', action: 'read' }],
    partnerId: null,
    orgId: 'org-123',
    roleId: 'role-1',
    scope: 'organization' as const
  };

  it('rejects when there is no auth context', async () => {
    const app = new Hono();
    app.use(requireOrgAccess());
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(401);
  });

  it('rejects when orgId param is missing', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use(requireOrgAccess('orgId'));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toBe('Organization ID required');
  });

  it('rejects when user cannot access the requested org', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use('/test/:orgId', requireOrgAccess());
    app.get('/test/:orgId', (c) => c.json({ ok: true }));

    vi.mocked(getUserPermissions).mockResolvedValue(mockPermsForOrg);
    vi.mocked(canAccessOrg).mockReturnValue(false);

    const res = await app.request('/test/other-org-456');

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toBe('Access to this organization denied');
  });

  it('allows when user can access the requested org', async () => {
    const app = new Hono();
    app.use(async (c: any, next: any) => {
      c.set('auth', baseAuth);
      await next();
    });
    app.use('/test/:orgId', requireOrgAccess());
    app.get('/test/:orgId', (c) => c.json({ ok: true }));

    vi.mocked(getUserPermissions).mockResolvedValue(mockPermsForOrg);
    vi.mocked(canAccessOrg).mockReturnValue(true);

    const res = await app.request('/test/org-123');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
