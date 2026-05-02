import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  bearerTokenAuthMiddleware: vi.fn(),
  apiKeyAuthMiddleware: vi.fn(),
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
  getToolTier: vi.fn((_: string): number | undefined => undefined),
}));

const setApiKeyContext = (c: any) => {
  c.set('apiKey', {
    id: 'key-1', orgId: 'org-1', name: 'test', keyPrefix: 'brz_test',
    partnerId: 'partner-1',
    scopes: ['ai:read'], rateLimit: 1000, createdBy: 'user-1',
  });
  c.set('apiKeyOrgId', 'org-1');
};

vi.mock('../middleware/bearerTokenAuth', () => ({ bearerTokenAuthMiddleware: mocks.bearerTokenAuthMiddleware }));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: mocks.apiKeyAuthMiddleware,
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => {
  // `.where(...)` needs to be both awaitable (for queries that don't call
  // .limit — e.g. resolvePartnerAccessibleOrgIds' org enumeration) AND
  // provide a `.limit(...)` continuation (for the membership lookup).
  const rows = [{ partnerId: 'partner-1', orgAccess: 'all', orgIds: null, id: 'org-1' }];
  const makeWhere = () => {
    const thenable = Promise.resolve(rows) as Promise<typeof rows> & { limit: (n: number) => Promise<typeof rows> };
    thenable.limit = async () => rows;
    return thenable;
  };
  return {
    db: {
      select: () => ({ from: () => ({ where: makeWhere }) }),
    },
    withDbAccessContext: vi.fn(),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  devices: {}, alerts: {}, scripts: {}, automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  apiKeys: {}, partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
  partnerUsers: {
    userId: 'partner_users.user_id',
    partnerId: 'partner_users.partner_id',
    orgAccess: 'partner_users.org_access',
    orgIds: 'partner_users.org_ids',
  },
}));

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: mocks.getToolDefinitions,
  executeTool: mocks.executeTool,
  getToolTier: mocks.getToolTier,
}));

vi.mock('../services/aiGuardrails', () => ({
  checkGuardrails: () => ({ allowed: true }),
  checkToolPermission: async () => null, checkToolRateLimit: async () => null,
}));

vi.mock('../services/auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

const ENV = ['MCP_OAUTH_ENABLED', 'IS_HOSTED', 'OAUTH_ISSUER'] as const;
const clearEnv = () => { for (const key of ENV) delete process.env[key]; };

async function appWithMcpRoutes() {
  const mod = await import('./mcpServer');
  return { app: new Hono().route('/mcp', mod.mcpServerRoutes), mod };
}

async function postToolsList(headers: Record<string, string> = {}) {
  const { app } = await appWithMcpRoutes();
  return app.request('/mcp/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

async function postToolsCall(headers: Record<string, string> = {}) {
  const { app } = await appWithMcpRoutes();
  return app.request('/mcp/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'inspect_scope', arguments: {} },
    }),
  });
}

describe('mcpServer bearer auth routing', () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.bearerTokenAuthMiddleware.mockImplementation(async (c: any, next: any) => {
      setApiKeyContext(c);
      return next();
    });
    mocks.apiKeyAuthMiddleware.mockImplementation(async (c: any, next: any) => {
      setApiKeyContext(c);
      return next();
    });
    mocks.getToolDefinitions.mockReturnValue([]);
    mocks.getToolTier.mockReturnValue(undefined);
    mocks.executeTool.mockResolvedValue('{}');
  });

  afterEach(() => clearEnv());

  it('routes Bearer auth through bearer middleware when OAuth is enabled', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const res = await postToolsList({ Authorization: 'Bearer foo' });
    expect(res.status).toBe(200);
    expect(mocks.bearerTokenAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mocks.apiKeyAuthMiddleware).not.toHaveBeenCalled();
  });

  it('routes X-API-Key auth through api key middleware when no Bearer header exists', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const res = await postToolsList({ 'X-API-Key': 'brz_abc' });
    expect(res.status).toBe(200);
    expect(mocks.apiKeyAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mocks.bearerTokenAuthMiddleware).not.toHaveBeenCalled();
  });

  it('does not route Bearer auth through bearer middleware when OAuth is disabled', async () => {
    process.env.MCP_OAUTH_ENABLED = 'false';
    const res = await postToolsList({ Authorization: 'Bearer foo' });
    expect(res.status).toBe(401);
    expect(mocks.bearerTokenAuthMiddleware).not.toHaveBeenCalled();
    expect(mocks.apiKeyAuthMiddleware).not.toHaveBeenCalled();
  });

  it('prefers Bearer auth when both Bearer and X-API-Key headers exist', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const res = await postToolsList({ Authorization: 'Bearer foo', 'X-API-Key': 'brz_abc' });
    expect(res.status).toBe(200);
    expect(mocks.bearerTokenAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mocks.apiKeyAuthMiddleware).not.toHaveBeenCalled();
  });

  it('builds partner-scope auth for Bearer context without org_id (M-B1: resolves the concrete org allowlist)', async () => {
    // M-B1 defense-in-depth: buildAuthFromApiKey now resolves the partner's
    // actual org list instead of passing `accessibleOrgIds: null`. The test
    // shim at the top of the file returns whatever single-row shape the code
    // asks for; in this path the resolver does:
    //   1. SELECT partner_users (membership) → returns [{ partnerId: ... }]
    //      (no orgAccess field, so it falls through to the 'all' branch)
    //   2. SELECT organizations → returns [{ partnerId: ... }] (which the
    //      resolver maps via `.id` → [undefined]).
    // So we expect accessibleOrgIds to be an array (length 1 with undefined),
    // NOT null. The important invariant is the SHAPE change — it's no longer
    // null, and downstream `orgCondition()` now returns an IN filter instead
    // of undefined.
    process.env.MCP_OAUTH_ENABLED = 'true';
    mocks.bearerTokenAuthMiddleware.mockImplementation(async (c: any, next: any) => {
      c.set('apiKey', {
        id: 'oauth:jti-1',
        orgId: null,
        partnerId: 'partner-1',
        name: 'OAuth bearer',
        keyPrefix: 'oauth',
        scopes: ['ai:read'],
        rateLimit: 1000,
        createdBy: 'user-1',
      });
      return next();
    });
    mocks.getToolTier.mockReturnValue(1);
    mocks.executeTool.mockResolvedValue('ok');

    const res = await postToolsCall({ Authorization: 'Bearer foo' });

    expect(res.status).toBe(200);
    const authArg = mocks.executeTool.mock.calls.at(-1)?.[2] as Record<string, unknown> | undefined;
    expect(authArg).toMatchObject({
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-1',
    });
    // accessibleOrgIds MUST be an array now (never null) — the exact contents
    // depend on the shim above; what matters is that the type changed so the
    // "no filter" fall-through path is closed.
    expect(Array.isArray(authArg?.accessibleOrgIds)).toBe(true);
  });

  it('no auth headers → 401 even with MCP_OAUTH_ENABLED (carve-out deleted in Phase 3)', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    delete process.env.IS_HOSTED;
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(mocks.bearerTokenAuthMiddleware).not.toHaveBeenCalled();
    expect(mocks.apiKeyAuthMiddleware).not.toHaveBeenCalled();
  });
});
