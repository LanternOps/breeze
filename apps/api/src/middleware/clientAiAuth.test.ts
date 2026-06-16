import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  redisMock,
  getRedisMock,
  dbSelectMock,
  withDbAccessContextMock,
  capturedDbContexts,
  getOrgPolicyMock,
} = vi.hoisted(() => {
  const redis = {
    get: vi.fn(),
    del: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  const captured: unknown[] = [];
  return {
    redisMock: redis,
    getRedisMock: vi.fn(() => redis),
    dbSelectMock: vi.fn(),
    withDbAccessContextMock: vi.fn((ctx: unknown, fn: () => unknown) => {
      captured.push(ctx);
      return fn();
    }),
    capturedDbContexts: captured,
    getOrgPolicyMock: vi.fn(),
  };
});

vi.mock('../db', () => ({
  db: { select: dbSelectMock },
  withDbAccessContext: withDbAccessContextMock,
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../services/redis', () => ({ getRedis: getRedisMock }));

vi.mock('../services/clientAiPolicy', () => ({
  getOrgPolicy: getOrgPolicyMock,
  isClientUserPermitted: (
    policy: { userAccess: string; selectedUserIds: string[] },
    id: string
  ) => policy.userAccess === 'all' || policy.selectedUserIds.includes(id),
}));

import { clientAiAuthMiddleware, requireClientAiEnabledMiddleware } from './clientAiAuth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PORTAL_USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK';

const USER_ROW = {
  id: PORTAL_USER_ID,
  orgId: ORG_ID,
  email: 'finance.user@contoso.com',
  name: 'Finance User',
  status: 'active',
  partnerAiForOfficeEnabled: true,
};

function setupUserSelect(row: object | null) {
  const limit = vi.fn(() => Promise.resolve(row ? [row] : []));
  const where = vi.fn(() => ({ limit }));
  const innerJoin2 = vi.fn(() => ({ where }));
  const innerJoin1 = vi.fn(() => ({ innerJoin: innerJoin2 }));
  dbSelectMock.mockImplementation(() => ({
    from: vi.fn(() => ({ innerJoin: innerJoin1 })),
  }));
}

function buildApp() {
  const app = new Hono();
  app.use('*', clientAiAuthMiddleware);
  app.get('/me', (c) => {
    const auth = c.get('clientAiAuth');
    return c.json({ clientUserId: auth.clientUserId, orgId: auth.orgId });
  });
  return app;
}

function get(app: Hono, headers: Record<string, string> = {}) {
  return app.request('/me', { method: 'GET', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedDbContexts.length = 0;
  getRedisMock.mockReturnValue(redisMock);
  redisMock.get.mockResolvedValue(
    JSON.stringify({ portalUserId: PORTAL_USER_ID, orgId: ORG_ID, createdAt: new Date().toISOString() })
  );
  setupUserSelect(USER_ROW);
});

describe('clientAiAuthMiddleware', () => {
  it('401s without a bearer token', async () => {
    const res = await get(buildApp());
    expect(res.status).toBe(401);
  });

  it('401s on an unknown/expired token and does not touch the DB', async () => {
    redisMock.get.mockResolvedValue(null);
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('401s and clears the session when the portal user row is gone', async () => {
    setupUserSelect(null);
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
    expect(redisMock.del).toHaveBeenCalledWith(`clientai:session:${TOKEN}`);
  });

  it('403s when the portal user is not active', async () => {
    setupUserSelect({ ...USER_ROW, status: 'disabled' });
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
  });

  it('503s when Redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(503);
  });

  it('attaches clientAiAuth, slides the TTL, and runs the handler inside an org-scoped DB context', async () => {
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientUserId: PORTAL_USER_ID, orgId: ORG_ID });

    expect(redisMock.expire).toHaveBeenCalledWith(`clientai:session:${TOKEN}`, 86400);
    expect(capturedDbContexts[0]).toMatchObject({
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      accessiblePartnerIds: [],
      userId: null,
    });
  });
});

describe('requireClientAiEnabledMiddleware', () => {
  function buildGuardedApp() {
    const app = new Hono();
    app.use('*', clientAiAuthMiddleware);
    app.use('*', requireClientAiEnabledMiddleware);
    app.get('/guarded', (c) => c.json({ writeMode: c.get('clientAiPolicy').writeMode }));
    return app;
  }

  it('403s with disabled when the org policy is off', async () => {
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID,
      enabled: false,
      userAccess: 'all',
      selectedUserIds: [],
      writeMode: 'readwrite',
    });
    const res = await buildGuardedApp().request('/guarded', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'disabled' });
  });

  it('403s with user_not_permitted when the user falls off the selected list mid-session', async () => {
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID,
      enabled: true,
      userAccess: 'selected',
      selectedUserIds: ['ffffffff-1111-4222-8333-444455556666'],
      writeMode: 'readwrite',
    });
    const res = await buildGuardedApp().request('/guarded', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'user_not_permitted' });
  });

  it('403s with disabled when the partner has AI for Office disabled (even if org policy is enabled)', async () => {
    setupUserSelect({ ...USER_ROW, partnerAiForOfficeEnabled: false });
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID,
      enabled: true,
      userAccess: 'all',
      selectedUserIds: [],
      writeMode: 'readwrite',
    });
    const res = await buildGuardedApp().request('/guarded', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'disabled' });
  });

  it('passes the policy through to the handler when enabled', async () => {
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID,
      enabled: true,
      userAccess: 'all',
      selectedUserIds: [],
      writeMode: 'readonly',
    });
    const res = await buildGuardedApp().request('/guarded', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ writeMode: 'readonly' });
  });
});
