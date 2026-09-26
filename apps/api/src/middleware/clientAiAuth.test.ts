import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  redisMock,
  getRedisMock,
  dbSelectMock,
  withDbAccessContextMock,
  capturedDbContexts,
  dbContextDepth,
  getOrgPolicyMock,
} = vi.hoisted(() => {
  const redis = {
    get: vi.fn(),
    del: vi.fn(() => Promise.resolve(1)),
    srem: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  const captured: unknown[] = [];
  const depth = { current: 0 };
  return {
    redisMock: redis,
    getRedisMock: vi.fn(() => redis),
    dbSelectMock: vi.fn(),
    withDbAccessContextMock: vi.fn(async (ctx: unknown, fn: () => unknown) => {
      captured.push(ctx);
      depth.current += 1;
      try {
        return await fn();
      } finally {
        depth.current -= 1;
      }
    }),
    capturedDbContexts: captured,
    dbContextDepth: depth,
    getOrgPolicyMock: vi.fn(),
  };
});

vi.mock('../db', () => ({
  db: { select: dbSelectMock },
  withDbAccessContext: withDbAccessContextMock,
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../services/redis', () => ({ getRedis: getRedisMock }));

// Org-status gate (org-lifecycle Wave 2): the middleware now refuses a session
// whose org is not usable. Default to "usable" so these tests keep asserting
// what they are about; the gate itself is covered by clientAiAuthOrgStatusGate.test.ts.
vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async (orgId: string) => ({ orgId, partnerId: 'partner-1' })),
}));

vi.mock('../services/clientAiPolicy', () => ({
  getOrgPolicy: getOrgPolicyMock,
  isClientUserPermitted: (
    policy: { userAccess: string; selectedUserIds: string[] },
    id: string
  ) => policy.userAccess === 'all' || policy.selectedUserIds.includes(id),
}));

import {
  clientAiAuthMiddleware,
  clientAiDbAccessContext,
  requireClientAiEnabledMiddleware,
} from './clientAiAuth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PORTAL_USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK';

const USER_ROW = {
  id: PORTAL_USER_ID,
  orgId: ORG_ID,
  email: 'finance.user@contoso.com',
  name: 'Finance User',
  status: 'active',
  authEpoch: 1,
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
    JSON.stringify({ portalUserId: PORTAL_USER_ID, orgId: ORG_ID, authEpoch: 1, createdAt: new Date().toISOString() })
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

// #3127 — POST /client-ai/sessions/:id/messages may wait (bounded) for a turn
// blocked on approvals to conclude, so it is registered in
// selfManagedDbContextRoutes: the auth middleware must not hold a request
// transaction across the handler, and the policy gate reads in its own short
// context instead.
describe('self-managed DB context routes (#3127)', () => {
  const SID = '11111111-1111-4111-8111-111111111111';
  const ENABLED_POLICY = {
    orgId: ORG_ID,
    enabled: true,
    userAccess: 'all',
    selectedUserIds: [],
    writeMode: 'readwrite',
  };

  function buildChatApp() {
    const app = new Hono();
    app.use('*', clientAiAuthMiddleware);
    app.use('*', requireClientAiEnabledMiddleware);
    app.post('/api/v1/client-ai/sessions/:id/messages', (c) => c.json({
      depth: dbContextDepth.current,
      writeMode: c.get('clientAiPolicy').writeMode,
    }));
    app.get('/api/v1/client-ai/sessions/:id/messages', (c) => c.json({ depth: dbContextDepth.current }));
    return app;
  }

  it('runs the message-send handler with no request transaction held', async () => {
    let policyReadDepth = -1;
    getOrgPolicyMock.mockImplementation(async () => {
      policyReadDepth = dbContextDepth.current;
      return ENABLED_POLICY;
    });

    const res = await buildChatApp().request(`/api/v1/client-ai/sessions/${SID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ depth: 0, writeMode: 'readwrite' });
    // The policy gate still reads under the org-scoped context — just a short one.
    expect(policyReadDepth).toBe(1);
    expect(capturedDbContexts).toEqual([clientAiDbAccessContext(ORG_ID)]);
  });

  it('still wraps sibling routes in the request transaction', async () => {
    getOrgPolicyMock.mockResolvedValue(ENABLED_POLICY);

    const res = await buildChatApp().request(`/api/v1/client-ai/sessions/${SID}/messages`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ depth: 1 });
  });

  it('clientAiDbAccessContext is exactly the context the middleware opens', async () => {
    await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(capturedDbContexts[0]).toEqual(clientAiDbAccessContext(ORG_ID));
  });
});
