import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  bearerTokenAuthMiddleware: vi.fn(),
  apiKeyAuthMiddleware: vi.fn(),
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn<typeof import('../services/aiTools').getToolDefinitions>(() => []),
  getToolTier: vi.fn((_: string): number | undefined => undefined),
  writeAuditEvent: vi.fn(),
  rateLimiter: vi.fn(),
}));

const envState = vi.hoisted(() => ({
  oauthEnabled: true,
  oauthIssuer: 'https://us.example.com',
}));

const redisState = vi.hoisted(() => ({
  available: true,
  // Distinct from `available: false` on purpose: `getRedis()` returning null
  // and a live client whose command REJECTS are different branches in the
  // handler, and both must answer 503 rather than 404.
  throwOnGet: false,
  throwOnSetex: false,
}));

vi.mock('../config/env', () => ({
  get MCP_OAUTH_ENABLED() { return envState.oauthEnabled; },
  get OAUTH_ISSUER() { return envState.oauthIssuer; },
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

// buildAuthFromApiKey now calls getUserPermissions for org keys (to inherit the
// creator's site allowlist). Stub it to an unrestricted org perms object so the
// transport tests don't need to model the permissions DB queries.
//
// SR2-15 (Task 3, scope re-clamp): buildAuthFromApiKey's org branch now
// re-validates the mocked key's stored scopes (default ['ai:read']) against
// these permissions via authorizeHumanApiKeyCreator. These are pure transport
// tests, not scope-delegation tests, so the creator here must actually hold
// the devices/alerts/scripts/automations read grants 'ai:read' requires —
// otherwise every request in this file would be denied by the NEW re-clamp
// before ever reaching the transport behavior under test.
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'devices', action: 'write' },
        { resource: 'alerts', action: 'read' },
        { resource: 'alerts', action: 'write' },
        { resource: 'scripts', action: 'read' },
        { resource: 'scripts', action: 'write' },
        { resource: 'automations', action: 'read' },
        { resource: 'automations', action: 'write' },
      ],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
    })),
  };
});

vi.mock('../services/aiTools', () => ({
  aiTools: new Map(),
  getToolDefinitions: mocks.getToolDefinitions,
  executeTool: mocks.executeTool,
  getToolTier: mocks.getToolTier,
  getToolDomain: vi.fn(() => 'devices'),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: mocks.writeAuditEvent,
  requestLikeFromSnapshot: vi.fn(),
}));
// Session ownership store used by the in-memory Redis mock — shared across
// requests inside a single test so initialize→subsequent-call flows work.
const __sessionStore = new Map<string, string>();
vi.mock('../services/redis', () => ({
  getRedis: () => redisState.available
    ? {
        setex: vi.fn(async (k: string, _ttl: number, v: string) => {
          if (redisState.throwOnSetex) throw new Error('ECONNRESET');
          __sessionStore.set(k, v);
          return 'OK';
        }),
        get: vi.fn(async (k: string) => {
          if (redisState.throwOnGet) throw new Error('ECONNRESET');
          return __sessionStore.get(k) ?? null;
        }),
      }
    : null,
}));
vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  captureMessage: mocks.captureMessage,
}));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: any[]) => mocks.rateLimiter(...args),
}));
vi.mock('../modules/mcpInvites', () => ({
  initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }),
}));

vi.mock('../services/toolSources/resolver', () => ({ resolveTenantTools: vi.fn(async () => []) }));

import { mcpServerRoutes } from './mcpServer';

function appWithMcpRoutes() {
  return new Hono().route('/mcp', mcpServerRoutes);
}

import { SUPPORTED_MCP_PROTOCOL_VERSIONS, LATEST_MCP_PROTOCOL_VERSION } from '../services/mcpProtocol';

import { API_VERSION } from '../version';

beforeEach(() => {
  envState.oauthEnabled = true;
  envState.oauthIssuer = 'https://us.example.com';
  redisState.available = true;
  redisState.throwOnGet = false;
  redisState.throwOnSetex = false;
  mocks.captureMessage.mockReset();
  __sessionStore.clear();
  mocks.executeTool.mockReset();
  mocks.getToolDefinitions.mockReset().mockReturnValue([]);
  mocks.getToolTier.mockReset().mockReturnValue(undefined);
  mocks.writeAuditEvent.mockReset();
  mocks.rateLimiter.mockReset().mockResolvedValue({
    allowed: true,
    resetAt: new Date(Date.now() + 60_000),
  });
  mocks.apiKeyAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => {
    setApiKeyContext(c, ['ai:read', 'ai:write']);
    return next();
  });
  mocks.bearerTokenAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => {
    setApiKeyContext(c, ['ai:read', 'ai:write']);
    return next();
  });
});


afterEach(() => vi.unstubAllEnvs());

const TOOLS: ReturnType<typeof import('../services/aiTools').getToolDefinitions> = [
  { name: 'query_devices', description: 'd', input_schema: { type: 'object', properties: {} } },
  { name: 'manage_services', description: 'd', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'restart'] } } } },
];

describe.each([...SUPPORTED_MCP_PROTOCOL_VERSIONS])('MCP conformance for protocol %s', (version) => {
  beforeEach(() => {
    vi.stubEnv('MCP_TOOLS_LIST_PAGE_SIZE', '0');
    mocks.getToolDefinitions.mockReturnValue(TOOLS);
    mocks.getToolTier.mockImplementation((n: string) => (n === 'manage_services' ? 2 : 1));
    mocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
  });

  async function session() {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
    expect(init.status).toBe(200);
    const body = await init.json();
    const sid = init.headers.get('Mcp-Session-Id')!;
    const rpc = async (method: string, params?: unknown, id = 2) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': sid };
      if (version !== '2024-11-05') headers['MCP-Protocol-Version'] = version;   // header exists from 2025-06-18; harmless earlier
      const res = await app.request('/mcp/sse', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      return { status: res.status, body: await res.json() };
    };
    expect(sid).toMatch(/^mcp-/);
    return { init: body, rpc, app, sid };
  }

  it('initialize echoes the requested version and reports server identity', async () => {
    const { init } = await session();
    expect(init.result.protocolVersion).toBe(version);
    expect(init.result.serverInfo).toMatchObject({ name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION });
    expect(init.result.capabilities.tools).toEqual({ listChanged: false });
  });

  it('tools/list is sorted and every tool carries name, description, inputSchema, title, annotations, _meta', async () => {
    const { rpc } = await session();
    const { body } = await rpc('tools/list');
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['manage_services', 'query_devices']);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    for (const t of body.result.tools) {
      expect(Object.keys(t).sort()).toEqual(['_meta', 'annotations', 'description', 'inputSchema', 'name', 'title']);
      expect(Object.keys(t.annotations).sort()).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']);
      const readOnly = t.name === 'query_devices';
      expect(t.annotations).toEqual({ readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly });
      expect(t._meta).toEqual({ 'app.breeze/domain': 'devices' });
    }
  });

  it('tools/call returns a text block and matching structuredContent', async () => {
    const { rpc } = await session();
    const { body } = await rpc('tools/call', { name: 'query_devices', arguments: {} });
    expect(body.result.content[0].type).toBe('text');
    expect(body.result.structuredContent).toEqual(JSON.parse(body.result.content[0].text));
  });

  it('rejects JSON-RPC batches for every negotiated version', async () => {
    const { app, sid } = await session();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': version },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('unknown methods are -32601 and the deny paths are unchanged (tier-3 action is refused)', async () => {
    const { rpc } = await session();
    expect((await rpc('nope')).body.error.code).toBe(-32601);
    const { body } = await rpc('tools/call', { name: 'manage_services', arguments: { action: 'restart' } });
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toBeUndefined();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});

describe('MCP conformance — negotiation edge cases', () => {
  it('an unsupported requested version gets the latest supported one', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }) });
    expect((await init.json()).result.protocolVersion).toBe(LATEST_MCP_PROTOCOL_VERSION);
  });
  it('an unsupported MCP-Protocol-Version header on a later request is a 400 with -32600', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    const res = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': init.headers.get('Mcp-Session-Id')!, 'MCP-Protocol-Version': '1999-01-01' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });
});
