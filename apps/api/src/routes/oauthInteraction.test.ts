import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const mocks = vi.hoisted(() => {
  class Grant {
    static instances: Grant[] = [];
    accountId: string;
    clientId: string;
    breeze?: Record<string, string | null>;
    addOIDCScope = vi.fn();
    addResourceScope = vi.fn();
    save = vi.fn(async () => 'grant-1');

    constructor(args: { accountId: string; clientId: string }) {
      this.accountId = args.accountId;
      this.clientId = args.clientId;
      Grant.instances.push(this);
    }
  }

  return {
    Grant,
    interactionDetails: vi.fn(),
    interactionResult: vi.fn(async () => 'https://client.example/callback'),
    select: vi.fn(),
    update: vi.fn(),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../oauth/provider', () => ({
  getProvider: vi.fn(async () => ({
    interactionDetails: mocks.interactionDetails,
    interactionResult: mocks.interactionResult,
    Grant: mocks.Grant,
  })),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'u1', email: 'user@example.com', name: 'User One' },
      token: {},
      partnerId: 'current-partner',
      orgId: 'current-org',
      scope: 'partner',
      accessibleOrgIds: null,
      orgCondition: vi.fn(),
      canAccessOrg: vi.fn(),
    });
    await next();
  }),
}));

vi.mock('../db', () => ({
  db: { select: mocks.select, update: mocks.update },
  runOutsideDbContext: mocks.runOutsideDbContext,
  withSystemDbAccessContext: mocks.withSystemDbAccessContext,
}));

function details(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'uid-1',
    params: {
      client_id: 'client-1',
      client_name: 'Claude Desktop',
      resource: 'https://api.example/mcp/server',
    },
    prompt: { details: { scopes: { new: ['openid', 'offline_access'] } } },
    ...overrides,
  };
}

function queueSelect(rows: unknown[], mode: 'where' | 'limit' = 'where') {
  const where = mode === 'where'
    ? vi.fn(async () => rows)
    : vi.fn(() => ({ limit: vi.fn(async () => rows) }));
  const join = { where };
  const from = vi.fn(() => ({
    innerJoin: vi.fn(() => join),
    where,
  }));
  mocks.select.mockImplementationOnce(() => ({ from }));
  return { from, where };
}

function queueUpdate() {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  mocks.update.mockImplementationOnce(() => ({ set }));
  return { set, where };
}

async function loadApp(enabled = true) {
  process.env.MCP_OAUTH_ENABLED = enabled ? 'true' : 'false';
  process.env.OAUTH_RESOURCE_URL = 'https://api.example/mcp/server';
  vi.resetModules();
  const { oauthInteractionRoutes } = await import('./oauthInteraction');
  const app = new Hono().route('/api/v1/oauth', oauthInteractionRoutes);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ message: err.message }, err.status);
    }
    throw err;
  });
  return app;
}

async function request(app: Hono, path: string, init?: RequestInit) {
  return app.request(path, init, { incoming: {}, outgoing: {} } as any);
}

describe('oauthInteractionRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.Grant.instances.length = 0;
  });

  afterEach(() => {
    delete process.env.MCP_OAUTH_ENABLED;
    delete process.env.OAUTH_RESOURCE_URL;
  });

  it('returns 404 when interactionDetails rejects with SessionNotFound', async () => {
    const err: Error & { name: string } = new Error('cookie missing');
    err.name = 'SessionNotFound';
    mocks.interactionDetails.mockRejectedValue(err);
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(404);
  });

  it('returns 404 when interaction uid is mismatched', async () => {
    mocks.interactionDetails.mockResolvedValue(details({ uid: 'other-uid' }));
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(404);
  });

  it('returns client, scopes, resource, and partner picker data', async () => {
    mocks.interactionDetails.mockResolvedValue(details());
    queueSelect([{ partnerId: 'partner-1', partnerName: 'Acme MSP' }]);
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      uid: 'uid-1',
      client: { client_id: 'client-1', client_name: 'Claude Desktop' },
      scopes: ['openid', 'offline_access'],
      resource: 'https://api.example/mcp/server',
      partners: [{ partnerId: 'partner-1', partnerName: 'Acme MSP' }],
    });
  });

  it('returns access_denied redirect when consent is denied', async () => {
    mocks.interactionDetails.mockResolvedValue(details());
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: 'partner-1', approve: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectTo: 'https://client.example/callback' });
    expect(mocks.interactionResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { error: 'access_denied', error_description: 'user denied access' },
      { mergeWithLastSubmission: false }
    );
  });

  it('rejects unsupported resource indicators', async () => {
    mocks.interactionDetails.mockResolvedValue(details({
      params: { client_id: 'client-1', resource: 'https://evil.example/mcp' },
    }));
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: 'partner-1', approve: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: 'unsupported resource indicator' });
  });

  it('rejects consent for partners where the user is not a member', async () => {
    mocks.interactionDetails.mockResolvedValue(details());
    queueSelect([], 'limit');
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: 'partner-1', approve: true }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'not a member of this partner' });
  });

  it('creates a stamped grant, binds the client partner, and returns a redirect', async () => {
    mocks.interactionDetails.mockResolvedValue(details());
    queueSelect([{ partnerId: 'partner-1', userId: 'u1' }], 'limit');
    queueSelect([{ partnerId: 'partner-1', orgId: 'org-1' }], 'limit');
    const update = queueUpdate();
    const res = await request(await loadApp(), '/api/v1/oauth/interaction/uid-1/consent', {
      method: 'POST',
      body: JSON.stringify({ partner_id: 'partner-1', approve: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectTo: 'https://client.example/callback' });
    expect(mocks.Grant.instances[0]).toMatchObject({
      accountId: 'u1',
      clientId: 'client-1',
      breeze: { partner_id: 'partner-1', org_id: 'org-1' },
    });
    expect(mocks.Grant.instances[0]?.addOIDCScope).toHaveBeenCalledWith('openid offline_access');
    expect(mocks.Grant.instances[0]?.addResourceScope)
      .toHaveBeenCalledWith('https://api.example/mcp/server', 'mcp:read mcp:write');
    expect(update.set).toHaveBeenCalledWith({ partnerId: 'partner-1' });
    expect(mocks.interactionResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { consent: { grantId: 'grant-1' }, login: { accountId: 'u1' } },
      { mergeWithLastSubmission: false }
    );
  });

  it('does not mount routes when MCP_OAUTH_ENABLED is false', async () => {
    const res = await request(await loadApp(false), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(404);
  });

  it('returns 500 when interactionDetails throws an unexpected error', async () => {
    mocks.interactionDetails.mockRejectedValueOnce(new Error('boom'));
    const res = await request(await loadApp(true), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(500);
  });

  it('returns 401 when authMiddleware rejects (no Bearer header)', async () => {
    // Replace the per-test authMiddleware mock with the real-shape rejection
    // so we can assert the routes propagate auth failures rather than silently
    // accepting all callers.
    const authMod = await import('../middleware/auth');
    const HTTPException = (await import('hono/http-exception')).HTTPException;
    vi.mocked(authMod.authMiddleware).mockImplementationOnce(async () => {
      throw new HTTPException(401, { message: 'Missing or invalid authorization header' });
    });
    const res = await request(await loadApp(true), '/api/v1/oauth/interaction/uid-1');
    expect(res.status).toBe(401);
  });
});
