import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {},
  withDbAccessContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
  alerts: {},
  scripts: {},
  automations: {},
  organizations: {},
  apiKeys: {},
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
}));

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: () => [],
  executeTool: vi.fn(),
  getToolTier: () => undefined,
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

vi.mock('../services/redis', () => ({
  getRedis: () => null,
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async () => {
    throw new Error('should not be called when no X-API-Key header');
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => {
    throw new Error('should not be called without a Bearer header');
  },
}));

const ENV = ['MCP_OAUTH_ENABLED', 'MCP_BOOTSTRAP_ENABLED', 'OAUTH_ISSUER'] as const;
const clear = () => {
  for (const k of ENV) delete process.env[k];
};

describe('mcpServer WWW-Authenticate', () => {
  beforeEach(() => {
    clear();
    vi.resetModules();
  });

  afterEach(() => {
    clear();
  });

  it('omits WWW-Authenticate when MCP_OAUTH_ENABLED is false', async () => {
    const { mcpServerRoutes } = await import('./mcpServer');
    const app = new Hono().route('/mcp', mcpServerRoutes);
    const res = await app.request('/mcp/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_fleet_status' },
      }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('emits WWW-Authenticate with resource_metadata when flag is on', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    process.env.OAUTH_ISSUER = 'https://example.test';

    const { mcpServerRoutes } = await import('./mcpServer');
    const app = new Hono().route('/mcp', mcpServerRoutes);
    const res = await app.request('/mcp/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_fleet_status' },
      }),
    });

    expect(res.status).toBe(401);
    const wa = res.headers.get('WWW-Authenticate');
    expect(wa).toMatch(/^Bearer/);
    expect(wa).toContain('realm="breeze"');
    expect(wa).toContain('resource_metadata="https://example.test/.well-known/oauth-protected-resource"');
  });
});
