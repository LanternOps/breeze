import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/jwt', () => ({
  verifyToken: vi.fn()
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
import { authMiddleware, requireScope } from './auth';
import { verifyToken } from '../services/jwt';
import { isUserTokenRevoked } from '../services/tokenRevocation';
import { db, withDbAccessContext } from '../db';

const basePayload = {
  sub: 'user-123',
  email: 'test@example.com',
  roleId: 'role-123',
  orgId: 'org-123',
  partnerId: 'partner-123',
  scope: 'organization' as const,
  type: 'access' as const
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
    app.use(async (c, next) => {
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
    app.use(async (c, next) => {
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
