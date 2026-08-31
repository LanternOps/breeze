import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
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

import { mcpServerRoutes } from './mcpServer';

function appWithMcpRoutes() {
  return new Hono().route('/mcp', mcpServerRoutes);
}

describe('Streamable HTTP transport (POST /sse)', () => {
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

  it('returns 404 for an unknown Mcp-Session-Id so the client re-initializes', async () => {
    const app = appWithMcpRoutes();
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': 'mcp-deadbeefdeadbeefdeadbeefdeadbeef',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/not found/i);
  });

  it('returns 404 when the session expired out of Redis (TTL lapse)', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sessionId = init.headers.get('mcp-session-id')!;
    __sessionStore.delete(`mcp-session:${sessionId}`);

    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 404 (not 403) when the session belongs to a different principal, with a body identical to the unknown-session response', async () => {
    const app = appWithMcpRoutes();
    const unknownSessionId = 'mcp-deadbeefdeadbeefdeadbeefdeadbeef';
    const mismatchSessionId = 'mcp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const requestWithSession = (sessionId: string) => app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    const unknownResponse = await requestWithSession(unknownSessionId);
    const unknownBody = await unknownResponse.json();
    __sessionStore.set(`mcp-session:${mismatchSessionId}`, 'some-other-principal-key');
    const mismatchResponse = await requestWithSession(mismatchSessionId);
    const mismatchBody = await mismatchResponse.json();

    // These two are what discriminate old behaviour from new: the old code
    // returned 403 here, and its body literally said "principal mismatch".
    expect(unknownResponse.status).toBe(404);
    expect(mismatchResponse.status).toBe(404);
    expect(mismatchBody.error.message).not.toMatch(/mismatch/i);
    // This one would ALSO have passed against the old code (both cases shared a
    // single branch there, so their bodies were trivially equal). It is kept as
    // a forward regression guard — it fails the day someone edits one of the
    // two 404 responses and not the other — not as proof of the fix.
    expect(mismatchBody).toEqual(unknownBody);
    // The no-oracle property extends to headers: a rejected request must not
    // echo a session id back.
    expect(unknownResponse.headers.get('mcp-session-id')).toBeNull();
    expect(mismatchResponse.headers.get('mcp-session-id')).toBeNull();
    // The mismatch is still surfaced to operators, just not to the caller.
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'mcp_session_principal_mismatch' }),
    );
  });

  it('does not raise the principal-mismatch signal for an ordinary expiry', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sessionId = init.headers.get('mcp-session-id')!;
    __sessionStore.delete(`mcp-session:${sessionId}`);

    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    expect(res.status).toBe(404);
    // Routine expiry is silent per-request by design — every session ages out
    // this way. Only an abnormal RATE is reported, and one expiry is not that.
    //
    // Asserted against the specific event code rather than "never called":
    // the unknown-session rate counter is module-level and survives
    // `mockReset`, so a blanket assertion would become a landmine for whoever
    // adds the 50th expiry test to this file.
    expect(mocks.captureMessage).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'mcp_session_principal_mismatch' }),
    );
  });

  it('returns 503, not 404, when the session lookup itself throws', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sessionId = init.headers.get('mcp-session-id')!;
    // A live client whose command rejects — distinct from getRedis() === null,
    // and a distinct catch block in the handler. If this ever answered 404,
    // every client would re-initialize in a loop for the duration of an outage.
    redisState.throwOnGet = true;

    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe(-32000);
  });

  it('still mints a session id when persisting it throws, and the next call fails closed', async () => {
    const app = appWithMcpRoutes();
    redisState.throwOnSetex = true;
    const init = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id')!;
    expect(sessionId).toMatch(/^mcp-/);

    // Connection recovers, but the mapping never landed -> 404, client re-inits.
    redisState.throwOnSetex = false;
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a notification (no JSON-RPC id) carrying an expired session instead of accepting it 202', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sessionId = init.headers.get('mcp-session-id')!;
    __sessionStore.delete(`mcp-session:${sessionId}`);

    // Session validation must run BEFORE the notification fast-path, or an
    // invalid-session notification would be silently accepted with a 202 and
    // the client would never learn it needs to re-initialize.
    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it('still returns 403 for a genuine authorization failure (missing ai:read scope), not 404', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sessionId = init.headers.get('mcp-session-id')!;
    mocks.apiKeyAuthMiddleware.mockImplementationOnce(async (c: any, next: any) => {
      setApiKeyContext(c, []);
      return next();
    });

    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it('still returns 400 when the Mcp-Session-Id header is missing or not server-minted', async () => {
    const app = appWithMcpRoutes();
    const requestWithSession = (sessionId?: string) => app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    const missingResponse = await requestWithSession();
    const missingBody = await missingResponse.json();
    const clientSuppliedResponse = await requestWithSession('client-supplied-id');
    const clientSuppliedBody = await clientSuppliedResponse.json();

    expect(missingResponse.status).toBe(400);
    expect(missingBody.error.code).toBe(-32600);
    expect(clientSuppliedResponse.status).toBe(400);
    expect(clientSuppliedBody.error.code).toBe(-32600);
  });

  it('a 404 is recoverable: the client can re-initialize and the new session works', async () => {
    const app = appWithMcpRoutes();
    const firstInit = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const expiredSessionId = firstInit.headers.get('mcp-session-id')!;
    __sessionStore.delete(`mcp-session:${expiredSessionId}`);

    const expiredResponse = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': expiredSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(expiredResponse.status).toBe(404);

    const secondInit = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize' }),
    });
    const newSessionId = secondInit.headers.get('mcp-session-id')!;
    expect(newSessionId).not.toBe(expiredSessionId);

    const recoveredResponse = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': newSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    });

    expect(recoveredResponse.status).toBe(200);
  });

  it('returns 503, not 404, when the session store is unavailable', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const sessionId = init.headers.get('mcp-session-id')!;
    redisState.available = false;

    const res = await app.request('/mcp/sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'k',
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe(-32000);
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
