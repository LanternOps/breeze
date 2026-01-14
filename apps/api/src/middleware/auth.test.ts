import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/jwt', () => ({
  verifyToken: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  users: {
    id: 'id',
    email: 'email',
    name: 'name',
    status: 'status'
  },
  partnerUsers: {},
  organizationUsers: {}
}));

import { Hono } from 'hono';
import { authMiddleware, requireScope } from './auth';
import { verifyToken } from '../services/jwt';
import { db } from '../db';

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
  scope: basePayload.scope
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

function buildAuthApp() {
  const app = new Hono();
  app.use(authMiddleware);
  app.get('/test', (c) => c.json({ auth: c.get('auth') }));
  return app;
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
