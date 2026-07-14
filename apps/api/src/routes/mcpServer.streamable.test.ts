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
}));

const envState = vi.hoisted(() => ({
  oauthEnabled: true,
  oauthIssuer: 'https://us.example.com',
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
        { resource: 'alerts', action: 'read' },
        { resource: 'scripts', action: 'read' },
        { resource: 'automations', action: 'read' },
      ],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
    })),
  };
});

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: mocks.getToolDefinitions,
  executeTool: mocks.executeTool,
  getToolTier: mocks.getToolTier,
}));

vi.mock('../services/aiGuardrails', () => ({
  checkGuardrails: () => ({ allowed: true, tier: 1 }),
  checkToolPermission: async () => null,
  checkToolRateLimit: async () => null,
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: mocks.writeAuditEvent,
  requestLikeFromSnapshot: vi.fn(),
}));
// Session ownership store used by the in-memory Redis mock — shared across
// requests inside a single test so initialize→subsequent-call flows work.
const __sessionStore = new Map<string, string>();
vi.mock('../services/redis', () => ({
  getRedis: () => ({
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      __sessionStore.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => __sessionStore.get(k) ?? null),
  }),
}));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: any[]) => mocks.rateLimiter(...args),
}));
vi.mock('../modules/mcpInvites', () => ({
  initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }),
}));

import { mcpServerRoutes } from './mcpServer';

function appWithMcpRoutes() {
  return new Hono().route('/mcp', mcpServerRoutes);
}

describe('Streamable HTTP transport (POST /sse)', () => {
  beforeEach(() => {
    envState.oauthEnabled = true;
    envState.oauthIssuer = 'https://us.example.com';
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
      setApiKeyContext(c);
      return next();
    });
    mocks.bearerTokenAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => {
      setApiKeyContext(c);
      return next();
    });
  });

  it('returns inline JSON-RPC response with 200 application/json', async () => {
    const app = appWithMcpRoutes();
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

  it('mints server-prefixed Mcp-Session-Id header on initialize', async () => {
    const app = appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(200);
    // Server-minted ids are prefixed with `mcp-` (audit finding MED-1).
    expect(res.headers.get('mcp-session-id')).toMatch(/^mcp-[a-f0-9]{20,}$/);
  });

  it('ignores client-supplied Mcp-Session-Id on initialize and mints a server-prefixed value', async () => {
    const app = appWithMcpRoutes();
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
    const minted = res.headers.get('mcp-session-id');
    expect(minted).not.toBe('client-supplied-id');
    expect(minted).toMatch(/^mcp-[a-f0-9]{20,}$/);
  });

  it('returns 202 with empty body for notifications (no id) when carrying a valid session', async () => {
    const app = appWithMcpRoutes();
    // Initialize first so we have a server-minted session id to present.
    const init = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sessionId = init.headers.get('mcp-session-id')!;
    expect(sessionId).toMatch(/^mcp-/);

    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': sessionId,
      },
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
    const app = appWithMcpRoutes();
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
    const app = appWithMcpRoutes();
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
    const app = appWithMcpRoutes();
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
    const app = appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'DELETE',
      headers: { 'X-API-Key': 'k' },
    });
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('legacy POST /message still returns inline JSON without sessionId', async () => {
    const app = appWithMcpRoutes();
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
