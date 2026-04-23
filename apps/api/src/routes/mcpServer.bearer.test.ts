import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  bearerTokenAuthMiddleware: vi.fn(),
  apiKeyAuthMiddleware: vi.fn(),
}));

const setApiKeyContext = (c: any) => {
  c.set('apiKey', {
    id: 'key-1', orgId: 'org-1', name: 'test', keyPrefix: 'brz_test',
    scopes: ['ai:read'], rateLimit: 1000, createdBy: 'user-1', scopeState: 'full',
  });
  c.set('apiKeyOrgId', 'org-1');
};

vi.mock('../middleware/bearerTokenAuth', () => ({ bearerTokenAuthMiddleware: mocks.bearerTokenAuthMiddleware }));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: mocks.apiKeyAuthMiddleware,
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }) }) }),
  },
  withDbAccessContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {}, alerts: {}, scripts: {}, automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  apiKeys: {}, partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
}));

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: () => [], executeTool: vi.fn(), getToolTier: () => undefined,
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
vi.mock('../modules/mcpBootstrap', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

const ENV = ['MCP_OAUTH_ENABLED', 'MCP_BOOTSTRAP_ENABLED', 'OAUTH_ISSUER'] as const;
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

  it('still allows the bootstrap carve-out with no auth headers', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    process.env.MCP_BOOTSTRAP_ENABLED = 'true';
    const { app, mod } = await appWithMcpRoutes();
    await mod.__loadMcpBootstrapForTests();
    const res = await app.request('/mcp/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    expect(mocks.bearerTokenAuthMiddleware).not.toHaveBeenCalled();
    expect(mocks.apiKeyAuthMiddleware).not.toHaveBeenCalled();
  });
});
