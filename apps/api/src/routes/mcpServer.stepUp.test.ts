import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B-W02 (#6156, D-B7): every MCP 401 names the mcp scopes; a bearer refused
// ONLY for a missing tier scope gets a 403 insufficient_scope step-up when
// MCP_INSUFFICIENT_SCOPE_HTTP_403=true (default off). Nothing else ever does.

const testState = vi.hoisted(() => ({
  principal: null as Record<string, any> | null,
}));

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  checkToolPermission: vi.fn(),
}));

vi.mock('../config/env', () => ({
  MCP_OAUTH_ENABLED: true,
  OAUTH_ISSUER: 'https://issuer.example.com',
}));

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: vi.fn(async () => ({ id: 'ledger-1' })),
  completeMcpToolExecutionLedger: vi.fn(async () => undefined),
}));
vi.mock('../services/auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: vi.fn(() => { throw new Error('Unexpected db.select call'); }) },
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));
vi.mock('../db/schema', async () => {
  const { pgTable, text, timestamp } = await import('drizzle-orm/pg-core');
  return {
    devices: pgTable('test_devices', { id: text('id'), orgId: text('org_id'), siteId: text('site_id') }),
    alerts: pgTable('test_alerts', { id: text('id'), orgId: text('org_id') }),
    scripts: pgTable('test_scripts', { id: text('id'), orgId: text('org_id') }),
    automations: pgTable('test_automations', { id: text('id'), orgId: text('org_id') }),
    organizations: pgTable('test_organizations', { id: text('id'), partnerId: text('partner_id'), createdAt: timestamp('created_at') }),
    partners: pgTable('test_partners', { id: text('id'), billingEmail: text('billing_email') }),
  };
});

const setPrincipal = async (c: any, next: any) => {
  if (!testState.principal) throw new Error('no principal');
  c.set('apiKey', testState.principal);
  if (testState.principal.orgId) c.set('apiKeyOrgId', testState.principal.orgId);
  await next();
};
vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: (c: any, next: any) => setPrincipal(c, next),
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));
vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: (c: any, next: any) => setPrincipal(c, next),
  resolvePartnerAccessibleOrgIds: async () => [],
}));

vi.mock('../services/aiTools', async () => {
  const fx = await import('./__fixtures__/mcpDomainTools');
  return {
    aiTools: new Map(),
    getToolDefinitions: () => fx.DOMAIN_TEST_TOOLS.map((t) => ({ ...t })),
    executeTool: (...args: any[]) => mocks.executeTool(...args),
    getToolTier: (name: string) => fx.DOMAIN_TEST_TIERS[name],
    getToolDomain: (name: string) => fx.DOMAIN_TEST_DOMAINS[name],
  };
});
// In-memory session store so the streamable transport can mint and verify
// Mcp-Session-Id.
const sessionStore = new Map<string, string>();
vi.mock('../services/redis', () => ({
  getRedis: () => ({
    setex: async (k: string, _ttl: number, v: string) => { sessionStore.set(k, v); return 'OK'; },
    get: async (k: string) => sessionStore.get(k) ?? null,
  }),
}));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));
vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => null),
  assertActiveTenantContext: vi.fn(),
  TenantInactiveError: class TenantInactiveError extends Error {},
}));
vi.mock('../services/recoveryBootstrap', () => ({
  resolveServerUrl: (requestUrl?: string) => (requestUrl ? new URL(requestUrl).origin : 'http://localhost:3001'),
}));
vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));
vi.mock('../services/toolSources/resolver', () => ({
  resolveTenantTools: vi.fn(async () => []),
  resolveTenantToolByName: vi.fn(async () => null),
  resolveTenantToolHealthByName: vi.fn(async () => ({ found: false })),
}));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));
vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  return {
    ...actual,
    checkToolPermission: (...args: any[]) => mocks.checkToolPermission(...args),
    checkToolRateLimit: vi.fn(async () => null),
    checkPermissionRequirement: vi.fn(async () => null),
    checkPermissionRequirements: vi.fn(async () => null),
  };
});
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: [{ resource: '*', action: '*' }],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
      allowedSiteIds: undefined,
    })),
  };
});

import { mcpServerRoutes } from './mcpServer';

const DEFAULT_CHALLENGE =
  'Bearer realm="breeze", resource_metadata="https://issuer.example.com/.well-known/oauth-protected-resource", scope="mcp:read mcp:write mcp:execute"';

function bearer(overrides: Record<string, unknown> = {}) {
  testState.principal = {
    id: 'oauth:jti-1', orgId: 'org-1', partnerId: 'partner-1', name: 'OAuth bearer', keyPrefix: 'oauth',
    scopes: ['ai:read'], rateLimit: 1000, createdBy: 'user-1',
    oauthGrantId: 'grant-1', oauthClientId: 'client-1', mcpDomains: null,
    ...overrides,
  };
  return { Authorization: 'Bearer token' };
}

function xApiKey(overrides: Record<string, unknown> = {}) {
  testState.principal = {
    id: 'key-1', orgId: 'org-1', partnerId: 'partner-1', name: 'k', keyPrefix: 'brz_test',
    scopes: ['ai:read'], rateLimit: 1000, createdBy: 'user-1', mcpDomains: null,
    ...overrides,
  };
  return { 'X-API-Key': 'brz_test' };
}

async function post(path: string, auth: Record<string, string>, method: string, params?: unknown) {
  const res = await mcpServerRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, ...(params ? { params } : {}) }),
  });
  return { res, body: await res.json() as any };
}

const callCreateTicket = (auth: Record<string, string>) =>
  post('/message', auth, 'tools/call', { name: 'create_ticket', arguments: {} });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.checkToolPermission.mockResolvedValue(null);
});

afterEach(() => vi.unstubAllEnvs());

describe('insufficient_scope step-up', () => {
  it('flag off: bearer tier-scope denial stays HTTP 200 with JSON-RPC error', async () => {
    const { res, body } = await callCreateTicket(bearer());
    expect(res.status).toBe(200);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(body.error).toEqual({
      code: -32603,
      message: 'Tool "create_ticket" requires ai:write scope',
      data: { reason: 'insufficient_scope', requiredScope: 'ai:write' },
    });
  });

  it('flag on: bearer missing mcp:write gets 403 + insufficient_scope challenge, body unchanged', async () => {
    vi.stubEnv('MCP_INSUFFICIENT_SCOPE_HTTP_403', 'true');
    const { res, body } = await callCreateTicket(bearer());
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer realm="breeze", error="insufficient_scope", resource_metadata="https://issuer.example.com/.well-known/oauth-protected-resource", scope="mcp:read mcp:write"',
    );
    expect(body.error).toMatchObject({ code: -32603, message: 'Tool "create_ticket" requires ai:write scope' });
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('flag on: streamable POST /sse returns the same 403 challenge', async () => {
    vi.stubEnv('MCP_INSUFFICIENT_SCOPE_HTTP_403', 'true');
    const auth = bearer();
    const init = await post('/sse', auth, 'initialize');
    const sid = init.res.headers.get('Mcp-Session-Id');
    const res = await mcpServerRoutes.request('/sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth, ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'create_ticket', arguments: {} } }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect((await res.json()).error.data).toEqual({ reason: 'insufficient_scope', requiredScope: 'ai:write' });
  });

  it('flag on: X-API-Key callers never get 403', async () => {
    vi.stubEnv('MCP_INSUFFICIENT_SCOPE_HTTP_403', 'true');
    const { res, body } = await callCreateTicket(xApiKey());
    expect(res.status).toBe(200);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(body.error.data).toEqual({ reason: 'insufficient_scope', requiredScope: 'ai:write' });
  });

  it('flag on: domain_not_granted never becomes 403', async () => {
    vi.stubEnv('MCP_INSUFFICIENT_SCOPE_HTTP_403', 'true');
    const { res, body } = await callCreateTicket(bearer({ mcpDomains: ['devices'] }));
    expect(res.status).toBe(200);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(body.error).toMatchObject({ code: -32003, data: { reason: 'domain_not_granted' } });
  });

  it('approval, MFA, RBAC and execute_admin denials never carry insufficient_scope', async () => {
    vi.stubEnv('MCP_INSUFFICIENT_SCOPE_HTTP_403', 'true');
    // Approval: a wholly-gated tier-3 tool with every scope.
    const approval = await post('/message', bearer({ scopes: ['ai:read', 'ai:write', 'ai:execute'] }), 'tools/call', { name: 'run_script', arguments: {} });
    expect(approval.res.status).toBe(200);
    expect(JSON.parse(approval.body.result.content[0].text).code).toBe('MCP_APPROVAL_REQUIRED');
    // RBAC: the product-permission denial is not a scope problem.
    mocks.checkToolPermission.mockResolvedValueOnce('Permission denied: tickets.write');
    const rbac = await callCreateTicket(bearer({ scopes: ['ai:read', 'ai:write'] }));
    expect(rbac.res.status).toBe(200);
    expect(rbac.res.headers.get('www-authenticate')).toBeNull();
    expect(rbac.body.error.data).toBeUndefined();
  });

  it('legacy SSE path keeps 202 and queues the error', async () => {
    vi.stubEnv('MCP_INSUFFICIENT_SCOPE_HTTP_403', 'true');
    vi.stubEnv('PUBLIC_API_URL', 'https://mcp.example.com');
    const auth = bearer();
    const stream = await mcpServerRoutes.request('/sse', { method: 'GET', headers: auth });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      const sessionId = /sessionId=([0-9a-f-]+)/.exec(first)?.[1];
      expect(sessionId).toBeDefined();

      const { res, body } = await post(`/message?sessionId=${sessionId}`, auth, 'tools/call', { name: 'create_ticket', arguments: {} });
      expect(res.status).toBe(202);
      expect(body).toEqual({ status: 'accepted' });
      expect(res.headers.get('www-authenticate')).toBeNull();

      const queued = new TextDecoder().decode((await reader.read()).value);
      expect(queued).toContain('requires ai:write scope');
      expect(queued).toContain('insufficient_scope');
    } finally {
      await reader.cancel();
    }
  });
});

describe('401 / preflight challenges', () => {
  it('401 without credentials carries scope="mcp:read mcp:write mcp:execute"', async () => {
    testState.principal = null;
    const { res, body } = await post('/message', {}, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(DEFAULT_CHALLENGE);
    expect(body.error.code).toBe(-32001);
  });

  it('bearer without mcp:read gets the preflight 403 with an insufficient_scope mcp:read challenge (flag-independent)', async () => {
    const { res, body } = await post('/message', bearer({ scopes: [] }), 'tools/list');
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer realm="breeze", error="insufficient_scope", resource_metadata="https://issuer.example.com/.well-known/oauth-protected-resource", scope="mcp:read"',
    );
    expect(body.error).toMatchObject({ code: -32001, message: 'API key missing required scope: ai:read' });
  });

  it('an X-API-Key caller without ai:read gets the 403 with no challenge', async () => {
    const { res } = await post('/message', xApiKey({ scopes: [] }), 'tools/list');
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});
