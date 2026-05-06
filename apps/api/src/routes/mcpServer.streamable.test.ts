import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  bearerTokenAuthMiddleware: vi.fn(),
  apiKeyAuthMiddleware: vi.fn(),
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
  getToolTier: vi.fn((_: string): number | undefined => undefined),
}));

const setApiKeyContext = (c: any, scopes: string[] = ['ai:read']) => {
  c.set('apiKey', {
    id: 'key-1',
    orgId: 'org-1',
    name: 'test',
    keyPrefix: 'brz_test',
    partnerId: 'partner-1',
    scopes,
    rateLimit: 1000,
    createdBy: 'user-1',
  });
  c.set('apiKeyOrgId', 'org-1');
};

vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: mocks.bearerTokenAuthMiddleware,
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: mocks.apiKeyAuthMiddleware,
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => {
  const rows = [{ partnerId: 'partner-1', orgAccess: 'all', orgIds: null, id: 'org-1' }];
  const makeWhere = () => {
    const thenable = Promise.resolve(rows) as Promise<typeof rows> & {
      limit: (n: number) => Promise<typeof rows>;
    };
    thenable.limit = async () => rows;
    return thenable;
  };
  return {
    db: { select: () => ({ from: () => ({ where: makeWhere }) }) },
    withDbAccessContext: vi.fn(),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  devices: {},
  alerts: {},
  scripts: {},
  automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  apiKeys: {},
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
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
  checkToolPermission: async () => null,
  checkToolRateLimit: async () => null,
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(),
}));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));
vi.mock('../modules/mcpInvites', () => ({
  initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }),
}));

async function appWithMcpRoutes() {
  const mod = await import('./mcpServer');
  return { app: new Hono().route('/mcp', mod.mcpServerRoutes), mod };
}

describe('Streamable HTTP transport (POST /sse)', () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    process.env.IS_HOSTED = 'true';
    process.env.OAUTH_ISSUER = 'https://us.example.com';
    vi.resetModules();
    vi.clearAllMocks();
    mocks.apiKeyAuthMiddleware.mockImplementation(async (c: any, next: any) => {
      setApiKeyContext(c);
      return next();
    });
    mocks.bearerTokenAuthMiddleware.mockImplementation(async (c: any, next: any) => {
      setApiKeyContext(c);
      return next();
    });
  });

  it('returns inline JSON-RPC response with 200 application/json', async () => {
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 1, result: expect.objectContaining({ protocolVersion: expect.any(String) }) });
  });

  it('mints Mcp-Session-Id header on initialize when client did not send one', async () => {
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('does not mint session id when client already provided one', async () => {
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': 'client-supplied-id',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('returns 202 with empty body for notifications (no id)', async () => {
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('returns 403 when caller lacks ai:read scope', async () => {
    mocks.apiKeyAuthMiddleware.mockImplementationOnce(async (c: any, next: any) => {
      setApiKeyContext(c, []); // no scopes
      return next();
    });
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it('returns 400 for malformed JSON-RPC request', async () => {
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ id: 1, method: 'initialize' }), // missing jsonrpc
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
  });

  it('returns 400 for invalid JSON body', async () => {
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it('DELETE /sse returns 204', async () => {
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'DELETE',
      headers: { 'X-API-Key': 'k' },
    });
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('legacy POST /message still returns inline JSON without sessionId', async () => {
    const { app } = await appWithMcpRoutes();
    const res = await app.request('/mcp/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 1 });
  });
});
