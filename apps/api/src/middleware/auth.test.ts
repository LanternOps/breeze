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

vi.mock('../db', () => ({
  db: {
    select: vi.fn()
  },
  withDbAccessContext: vi.fn(async (_context, fn) => fn())
}));

vi.mock('../db/schema', () => ({
  users: {
    id: 'id',
    email: 'email',
    name: 'name',
    status: 'status'
  },
  partnerUsers: {
    userId: 'partnerUsers.userId',
    partnerId: 'partnerUsers.partnerId',
    orgAccess: 'partnerUsers.orgAccess',
    orgIds: 'partnerUsers.orgIds'
  },
  organizationUsers: {},
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId'
  }
}));

import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission, requireMfa, requireOrg, requirePartner, requireOrgAccess, resolveOrgAccess, AuthContext } from './auth';
import { verifyToken } from '../services/jwt';
import { isUserTokenRevoked } from '../services/tokenRevocation';
import { db, withDbAccessContext } from '../db';
import { getUserPermissions, hasPermission, canAccessOrg } from '../services/permissions';

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
  status: 'active'
};

const baseAuth = {
  user: {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User'
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
      {
        scope: basePayload.scope,
        orgId: basePayload.orgId,
        accessibleOrgIds: [basePayload.orgId]
      },
      expect.any(Function)
    );
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
