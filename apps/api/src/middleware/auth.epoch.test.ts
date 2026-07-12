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
  isUserTokenRevoked: vi.fn().mockResolvedValue(false),
  isTokenIssuedBeforePasswordChange: vi.fn(() => false)
}));

vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn()
}));

// Default to pass-through; nothing here exercises the ipAllowlistGuard deny
// path, but the mock is required so authMiddleware's import resolves.
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
    passwordChangedAt: 'passwordChangedAt',
    mfaEnabled: 'mfaEnabled',
    isPlatformAdmin: 'isPlatformAdmin',
    authEpoch: 'authEpoch',
    mfaEpoch: 'mfaEpoch'
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
import { authMiddleware, requirePermission } from './auth';
import { verifyToken } from '../services/jwt';
import { getUserPermissions } from '../services/permissions';
import { db } from '../db';

// Matches auth.test.ts's `selectWithLimit` helper shape — a
// db.select({...}).from(...).where(...).limit(1) chain.
function selectWithLimit(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

const epochPayload = {
  sub: 'user-123',
  email: 'test@example.com',
  roleId: 'role-123',
  orgId: 'org-123',
  partnerId: 'partner-123',
  scope: 'organization' as const,
  type: 'access' as const,
  mfa: true,
  iat: 1_700_000_000,
  aep: 1,
  mep: 1,
  sid: 'fam-123'
};

const liveUser = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'T',
  status: 'active',
  passwordChangedAt: null as Date | null,
  mfaEnabled: true,
  isPlatformAdmin: false,
  authEpoch: 1,
  mfaEpoch: 1
};

/**
 * Wires up authMiddleware's db.select calls in the order the real code
 * issues them: 1) the pre-auth user lookup, then 2) (partner scope only)
 * computeAccessibleOrgIds' partner_users membership lookup. Both are
 * limit-terminated chains, so `extraSelects` reuses the same helper.
 */
function appWith(middlewarePayload: unknown, userRow: unknown, extraSelects: unknown[][] = []) {
  vi.mocked(verifyToken).mockResolvedValue(middlewarePayload as never);
  let mock = vi.mocked(db.select).mockReturnValueOnce(selectWithLimit([userRow]) as never);
  for (const rows of extraSelects) {
    mock = mock.mockReturnValueOnce(selectWithLimit(rows) as never);
  }
  const app = new Hono();
  app.get('/t', authMiddleware, (c) => c.json({ ok: true }));
  return app;
}

describe('authMiddleware epoch + live-binding gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401s a token whose aep is behind the live row', async () => {
    const app = appWith({ ...epochPayload, aep: 1 }, { ...liveUser, authEpoch: 2 });
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it('401s a token whose mep is behind the live row', async () => {
    const app = appWith({ ...epochPayload, mep: 1 }, { ...liveUser, mfaEpoch: 2 });
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it('401s a token missing sid (legacy token, deliberate global sign-out)', async () => {
    const app = appWith({ ...epochPayload, sid: undefined }, liveUser);
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it('401s a token missing aep (legacy token, deliberate global sign-out)', async () => {
    const app = appWith({ ...epochPayload, aep: undefined }, liveUser);
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it('401s a token missing mep (legacy token, deliberate global sign-out)', async () => {
    const app = appWith({ ...epochPayload, mep: undefined }, liveUser);
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it("403s scope='system' when the live row is no longer a platform admin", async () => {
    const app = appWith(
      { ...epochPayload, scope: 'system', orgId: null, partnerId: null },
      { ...liveUser, isPlatformAdmin: false }
    );
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(403);
  });

  it("passes scope='system' when the live row IS a current platform admin", async () => {
    const app = appWith(
      { ...epochPayload, scope: 'system', orgId: null, partnerId: null },
      { ...liveUser, isPlatformAdmin: true }
    );
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(200);
  });

  it("401s scope='partner' when the live partner_users membership row is gone", async () => {
    // 2nd select = computeAccessibleOrgIds' partner_users lookup → no row.
    const app = appWith(
      { ...epochPayload, scope: 'partner', orgId: null },
      liveUser,
      [[]] // partnerUsers select returns no membership
    );
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(401);
  });

  it("passes scope='partner' when the live partner_users membership row exists", async () => {
    const app = appWith(
      { ...epochPayload, scope: 'partner', orgId: null },
      liveUser,
      [[{ orgAccess: 'none', orgIds: null }]]
    );
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(200);
  });

  it('passes through with matching epochs, sid, and live membership', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue({ permissions: [], allowedSiteIds: undefined } as never);
    const app = appWith(epochPayload, liveUser);
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(200);
  });
});

describe('org-scope live membership (overseer decision: explicit fail-closed proof)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requirePermission 403s when the org membership is gone (getUserPermissions → null)', async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    vi.mocked(verifyToken).mockResolvedValue(epochPayload as never);
    vi.mocked(db.select).mockReturnValueOnce(selectWithLimit([liveUser]) as never);
    const app = new Hono();
    app.get('/t', authMiddleware, requirePermission('devices', 'read'), (c) => c.json({ ok: true }));
    const res = await app.request('/t', { headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(403); // 'No permissions found' — fail closed on null
  });
});
