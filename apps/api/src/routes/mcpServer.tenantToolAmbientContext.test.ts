// Proves the auth middlewares are told to skip the ambient per-request DB
// transaction (MCP_SKIP_AMBIENT_DB_CONTEXT_KEY) ONLY for a tools/call request
// whose body already names a tenant (BYO MCP) tool (`slug__name` shape) — not
// for tools/list, not for a core tool, and not for a malformed body. See
// middleware/mcpTenantToolSelfManagedContext.ts for why that's safe.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  bearerTokenAuthMiddleware: vi.fn(),
  apiKeyAuthMiddleware: vi.fn(),
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(() => []),
  getToolTier: vi.fn((_: string): number | undefined => undefined),
  writeAuditEvent: vi.fn(),
  rateLimiter: vi.fn(),
  observedSkipFlags: [] as unknown[],
}));

const envState = vi.hoisted(() => ({
  oauthEnabled: false,
  oauthIssuer: 'https://us.example.com',
}));

vi.mock('../config/env', () => ({
  get MCP_OAUTH_ENABLED() { return envState.oauthEnabled; },
  get OAUTH_ISSUER() { return envState.oauthIssuer; },
}));

const setApiKeyContext = (c: any) => {
  c.set('apiKey', {
    id: 'key-1', orgId: 'org-1', name: 'test', keyPrefix: 'brz_test',
    partnerId: 'partner-1',
    scopes: ['ai:read'], rateLimit: 1000, createdBy: 'user-1',
  });
  c.set('apiKeyOrgId', 'org-1');
};

vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: mocks.bearerTokenAuthMiddleware,
  resolvePartnerAccessibleOrgIds: async () => {
    const { db } = await import('../db');
    const rows = await (db as any).select().from().where();
    return rows.map((r: any) => r.id);
  },
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: mocks.apiKeyAuthMiddleware,
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => {
  const membershipRows = [{ partnerId: 'partner-1', orgAccess: 'all', orgIds: null, id: 'org-1', roleId: 'role-1', siteIds: null }];
  const permissionRows = [
    { resource: 'devices', action: 'read' },
    { resource: 'alerts', action: 'read' },
    { resource: 'scripts', action: 'read' },
    { resource: 'automations', action: 'read' },
  ];
  const makeWhere = (rows: unknown[]) => {
    const thenable = Promise.resolve(rows) as Promise<unknown[]> & {
      limit: (n: number) => Promise<unknown[]>;
      orderBy: () => { limit: (n: number) => Promise<unknown[]> };
    };
    thenable.limit = async () => rows;
    thenable.orderBy = () => ({ limit: async () => rows });
    return thenable;
  };
  const makeFrom = () => ({
    where: () => makeWhere(membershipRows),
    innerJoin: () => ({ where: () => makeWhere(permissionRows) }),
  });
  return {
    db: {
      select: () => ({ from: makeFrom }),
    },
    hasDbAccessContext: vi.fn(() => true),
    getCurrentDbAccessContext: vi.fn(() => undefined),
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
  organizationUsers: {
    userId: 'organization_users.user_id',
    orgId: 'organization_users.org_id',
    roleId: 'organization_users.role_id',
    siteIds: 'organization_users.site_ids',
  },
  roles: { id: 'roles.id' },
  permissions: {}, rolePermissions: {},
}));

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: mocks.getToolDefinitions,
  executeTool: mocks.executeTool,
  getToolTier: mocks.getToolTier,
  aiTools: new Map(['manage_invoices', 'manage_quotes'].map(name => [name, { selfManagedDbContext: ['create_pay_link'] }])),
  toolManagesDbContext: (tool: any, input: any) => tool?.selfManagedDbContext?.includes(input.action) ?? false,
}));

vi.mock('../services/aiGuardrails', () => ({
  checkGuardrails: () => ({ allowed: true, tier: 1 }),
  checkToolPermission: async () => null, checkToolRateLimit: async () => null,
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: mocks.writeAuditEvent,
  requestLikeFromSnapshot: vi.fn(),
}));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: any[]) => mocks.rateLimiter(...args),
}));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));

import { mcpServerRoutes } from './mcpServer';
import { MCP_SKIP_AMBIENT_DB_CONTEXT_KEY } from '../middleware/mcpTenantToolSelfManagedContext';

function appWithMcpRoutes() {
  return new Hono().route('/mcp', mcpServerRoutes);
}

async function post(body: unknown) {
  const app = appWithMcpRoutes();
  return app.request('/mcp/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify(body),
  });
}

describe('mcpServer — tenant-tool-call ambient DB context skip', () => {
  beforeEach(() => {
    mocks.observedSkipFlags = [];
    mocks.apiKeyAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => {
      mocks.observedSkipFlags.push(c.get(MCP_SKIP_AMBIENT_DB_CONTEXT_KEY));
      setApiKeyContext(c);
      return next();
    });
    mocks.bearerTokenAuthMiddleware.mockReset();
    mocks.rateLimiter.mockReset().mockResolvedValue({ allowed: true, remaining: 100, resetAt: new Date() });
    mocks.getToolDefinitions.mockReturnValue([]);
    mocks.executeTool.mockResolvedValue('{}');
  });

  it('flags a tools/call naming a tenant tool (slug__name shape)', async () => {
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hudu__get_asset', arguments: {} } });
    expect(mocks.observedSkipFlags).toEqual([true]);
  });

  it.each(['manage_invoices', 'manage_quotes'])('flags only the self-managed create_pay_link action for %s', async name => {
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { action: 'create_pay_link' } } });
    expect(mocks.observedSkipFlags).toEqual([true]);
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: { action: 'list' } } });
    expect(mocks.observedSkipFlags).toEqual([true, false]);
  });

  it('does NOT flag a tools/call naming a core tool', async () => {
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inspect_scope', arguments: {} } });
    expect(mocks.observedSkipFlags).toEqual([false]);
  });

  it('does NOT flag tools/list, even though tenant tools may be among the listed results', async () => {
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(mocks.observedSkipFlags).toEqual([false]);
  });

  it('does NOT flag a malformed tool name (no "__" separator)', async () => {
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'not_a_tenant_tool', arguments: {} } });
    expect(mocks.observedSkipFlags).toEqual([false]);
  });
});
