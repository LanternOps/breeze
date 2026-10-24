/**
 * B-W03 (#6157): the stateless `2026-07-28` era on `POST /sse`, its rejection
 * on `POST /message`, and request correlation for both eras.
 *
 * Harness copied from mcpServer.streamable.test.ts (in-memory Redis session
 * store, header-driven API-key context), plus ledger / tenant-tool mocks so the
 * tier-3 and tenant-tool audit paths can be observed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  bearerTokenAuthMiddleware: vi.fn(),
  apiKeyAuthMiddleware: vi.fn(),
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn<typeof import('../services/aiTools').getToolDefinitions>(() => []),
  getToolTier: vi.fn((_: string): number | undefined => undefined),
  getToolDomain: vi.fn((_: string): string => 'devices'),
  writeAuditEvent: vi.fn(),
  rateLimiter: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  resolveTenantToolByName: vi.fn(),
  executeTenantToolDetailed: vi.fn(),
  getUserPermissionsNull: { value: false },
}));

const envState = vi.hoisted(() => ({
  oauthEnabled: true,
  oauthIssuer: 'https://us.example.com',
}));

const redisState = vi.hoisted(() => ({
  available: true,
  setex: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../config/env', () => ({
  get MCP_OAUTH_ENABLED() { return envState.oauthEnabled; },
  get OAUTH_ISSUER() { return envState.oauthIssuer; },
}));

const KEY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const KEY_B = '0b0b0b0b-0000-4000-8000-00000000000b';

type KeyOverrides = { id?: string; scopes?: string[]; mcpDomains?: unknown; oauthGrantId?: string | null };
let currentKey: KeyOverrides = {};

const setApiKeyContext = (c: any) => {
  c.set('apiKey', {
    id: currentKey.id ?? KEY_A,
    orgId: 'org-1',
    name: 'test',
    keyPrefix: 'brz_test',
    mcpDomains: currentKey.mcpDomains ?? null,
    partnerId: 'partner-1',
    scopes: currentKey.scopes ?? ['ai:read'],
    rateLimit: 1000,
    createdBy: 'user-1',
    oauthGrantId: currentKey.oauthGrantId ?? null,
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
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => any) => fn()),
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

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => (mocks.getUserPermissionsNull.value ? null : {
      permissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'devices', action: 'write' },
        { resource: 'devices', action: 'execute' },
        { resource: 'alerts', action: 'read' },
        { resource: 'alerts', action: 'write' },
        { resource: 'scripts', action: 'read' },
        { resource: 'scripts', action: 'write' },
        { resource: 'scripts', action: 'execute' },
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
  getToolDomain: mocks.getToolDomain,
}));

vi.mock('../services/aiGuardrails', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/aiGuardrails')>(),
  checkGuardrails: () => ({ allowed: true, tier: 1 }),
  checkToolPermission: async () => null,
  checkToolRateLimit: async () => null,
  checkPermissionRequirement: async () => null,
  checkPermissionRequirements: async () => null,
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: mocks.writeAuditEvent,
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerBegin(...args),
  completeMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerComplete(...args),
}));

vi.mock('../services/toolSources/resolver', () => ({
  resolveTenantTools: vi.fn(async () => []),
  resolveTenantToolByName: (...args: any[]) => mocks.resolveTenantToolByName(...args),
  resolveTenantToolHealthByName: vi.fn(async () => ({ found: false })),
}));
vi.mock('../services/toolSources/execute', () => ({
  executeTenantTool: vi.fn(),
  executeTenantToolDetailed: (...args: any[]) => mocks.executeTenantToolDetailed(...args),
}));
vi.mock('../services/toolSources/guardrails', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/toolSources/guardrails')>(),
  checkTenantToolRateLimit: async () => null,
}));

vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));

const __sessionStore = new Map<string, string>();
vi.mock('../services/redis', () => ({
  getRedis: () => redisState.available
    ? { setex: redisState.setex, get: redisState.get }
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
import { __resetMcpHeaderMismatchWindowForTests } from '../services/mcpModernResult';
import { API_VERSION } from '../version';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const INFO = 'io.modelcontextprotocol/clientInfo';
const SERVER_INFO = { name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION };

function app() {
  return new Hono().route('/mcp', mcpServerRoutes);
}

function modernMeta(extra: Record<string, unknown> = {}) {
  return { [PV]: '2026-07-28', [CAPS]: {}, [INFO]: { name: 'inspector', version: '1.0' }, ...extra };
}

function nameHeaderFor(method: string, params: Record<string, unknown>): string | undefined {
  if (method === 'tools/call' || method === 'prompts/get') return typeof params.name === 'string' ? params.name : undefined;
  if (method === 'resources/read') return typeof params.uri === 'string' ? params.uri : undefined;
  return undefined;
}

type ModernOpts = {
  id?: number | string | null;
  params?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  path?: string;
};

async function modern(method: string, opts: ModernOpts = {}) {
  const params = { ...(opts.params ?? {}), _meta: modernMeta() };
  const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
  if (opts.id !== null) body.id = opts.id ?? 1;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': 'k',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
  };
  const name = nameHeaderFor(method, params);
  if (name !== undefined) headers['Mcp-Name'] = name;
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return app().request(opts.path ?? '/mcp/sse', { method: 'POST', headers, body: JSON.stringify(body) });
}

async function legacyInit(): Promise<string> {
  const res = await app().request('/mcp/sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('mcp-session-id')!;
}

async function legacy(method: string, sessionId: string, params?: Record<string, unknown>) {
  return app().request('/mcp/sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, ...(params ? { params } : {}) }),
  });
}

function requestAuditRows() {
  return mocks.writeAuditEvent.mock.calls
    .map((call) => call[1] as Record<string, any>)
    .filter((e) => e.resourceType === 'mcp_request');
}

function toolAuditRows() {
  return mocks.writeAuditEvent.mock.calls
    .map((call) => call[1] as Record<string, any>)
    .filter((e) => e.resourceType === 'mcp_tool_execution');
}

function sessionStoreCalls() {
  return [...redisState.get.mock.calls, ...redisState.setex.mock.calls]
    .filter((call) => String(call[0]).startsWith('mcp-session:'));
}

beforeEach(() => {
  process.env.MCP_STATELESS_ENABLED = 'true';
  envState.oauthEnabled = true;
  envState.oauthIssuer = 'https://us.example.com';
  currentKey = {};
  redisState.available = true;
  __sessionStore.clear();
  redisState.setex.mockReset().mockImplementation(async (k: string, _ttl: number, v: string) => {
    __sessionStore.set(k, v);
    return 'OK';
  });
  redisState.get.mockReset().mockImplementation(async (k: string) => __sessionStore.get(k) ?? null);
  mocks.captureMessage.mockReset();
  mocks.executeTool.mockReset();
  mocks.getToolDefinitions.mockReset().mockReturnValue([]);
  mocks.getToolTier.mockReset().mockReturnValue(undefined);
  mocks.getToolDomain.mockReset().mockReturnValue('devices');
  mocks.writeAuditEvent.mockReset();
  mocks.ledgerBegin.mockReset().mockImplementation(async () => ({
    aiOrigin: { kind: 'ai_assistant', sessionId: 'ledger-session' },
    executionId: 'exec-1',
    sessionId: 'ledger-session',
    orgId: 'org-1',
  }));
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.resolveTenantToolByName.mockReset().mockResolvedValue(null);
  mocks.executeTenantToolDetailed.mockReset();
  mocks.getUserPermissionsNull.value = false;
  mocks.rateLimiter.mockReset().mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
  mocks.apiKeyAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => {
    setApiKeyContext(c);
    return next();
  });
  mocks.bearerTokenAuthMiddleware.mockReset().mockImplementation(async (c: any, next: any) => {
    setApiKeyContext(c);
    return next();
  });
  __resetMcpHeaderMismatchWindowForTests();
});

afterEach(() => {
  delete process.env.MCP_STATELESS_ENABLED;
  delete process.env.MCP_UNATTENDED_TIER3_PRINCIPALS;
});

describe('stateless 2026-07-28 on POST /sse', () => {
  it('server/discover returns supportedVersions, private cache hints and serverInfo', async () => {
    const res = await modern('server/discover');
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = await res.json();
    expect(body.id).toBe(1);
    expect(body.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {}, resources: {}, prompts: {} },
      ttlMs: 300_000,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    expect(typeof body.result.instructions).toBe('string');
  });

  it('modern tools/list carries resultType, ttlMs 60000 and cacheScope private, and no Mcp-Session-Id header', async () => {
    mocks.getToolDefinitions.mockReturnValue([
      { name: 'list_devices', description: 'List devices', input_schema: { type: 'object', properties: {} } } as any,
    ]);
    mocks.getToolTier.mockReturnValue(1);
    const res = await modern('tools/list');
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = await res.json();
    expect(body.result).toMatchObject({ resultType: 'complete', ttlMs: 60_000, cacheScope: 'private' });
    expect(body.result._meta['io.modelcontextprotocol/serverInfo']).toEqual(SERVER_INFO);
    expect(body.result.tools.map((t: { name: string }) => t.name)).toContain('list_devices');
  });

  it('modern path ignores and never echoes Mcp-Session-Id', async () => {
    const owned = await legacyInit();
    const storedBefore = [...__sessionStore.entries()];
    mocks.writeAuditEvent.mockReset();
    redisState.get.mockClear();
    redisState.setex.mockClear();
    const res = await modern('tools/list', { headers: { 'Mcp-Session-Id': owned } });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(redisState.get).not.toHaveBeenCalled();
    expect(redisState.setex).not.toHaveBeenCalled();
    expect([...__sessionStore.entries()]).toEqual(storedBefore);
    const [row] = requestAuditRows();
    expect(row!.details.correlation.sessionId).toBeNull();
    expect(row!.details.correlation.era).toBe('modern');
    expect(row!.details.hasSession).toBe(false);
    expect(row!.details).not.toHaveProperty('sessionId');
    expect(row!.resourceId).not.toBe(owned);
  });

  it('modern request never touches the session store', async () => {
    const list = await modern('tools/list', { headers: { 'Mcp-Session-Id': 'mcp-deadbeefdeadbeefdeadbeef' } });
    const discover = await modern('server/discover');
    expect(list.status).toBe(200);
    expect(discover.status).toBe(200);
    expect(sessionStoreCalls()).toEqual([]);
  });

  it('flag off: modern envelope gets 400 -32600, not a modern error, and the session store is not consulted', async () => {
    process.env.MCP_STATELESS_ENABLED = 'false';
    const res = await modern('tools/list');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
    expect(sessionStoreCalls()).toEqual([]);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('flag unset behaves as off', async () => {
    delete process.env.MCP_STATELESS_ENABLED;
    const res = await modern('server/discover');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it('initialize with modern _meta is rejected 400 -32600', async () => {
    const res = await modern('initialize');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
    expect(body.error.data.supported).toContain('2026-07-28');
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(sessionStoreCalls()).toEqual([]);
  });

  it('modern envelope on /message is rejected 400 -32600', async () => {
    const res = await modern('tools/list', { path: '/mcp/message' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('Mcp-Name mismatch → 400 -32020 and recordMcpHeaderMismatch called', async () => {
    // The threshold (default 50) is read at module load; drive the counter to
    // it and assert the tripwire fired exactly once.
    for (let i = 0; i < 50; i++) {
      const res = await modern('tools/call', { params: { name: 'list_devices', arguments: {} }, headers: { 'Mcp-Name': 'other_tool' } });
      expect(res.status).toBe(400);
      if (i === 0) expect((await res.json()).error.code).toBe(-32020);
    }
    const tripwire = mocks.captureMessage.mock.calls.filter((call) => call[1]?.eventCode === 'mcp_header_mismatch_rate_high');
    expect(tripwire).toHaveLength(1);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('a modern header without _meta → 400 -32020 (flag on)', async () => {
    const res = await app().request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'MCP-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
  });

  it('unsupported _meta version → 400 -32022 with data.supported and data.requested', async () => {
    const res = await app().request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: modernMeta({ [PV]: '2099-01-01' }) } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ id: 7, error: { code: -32022, data: { requested: '2099-01-01' } } });
    expect(body.error.data.supported).toEqual(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
  });

  it('legacy version inside a modern envelope → 400 -32600 (client falls back to initialize)', async () => {
    const res = await app().request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta({ [PV]: '2025-11-25' }) } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain('initialize');
  });

  it.each(['ping', 'notifications/initialized', 'logging/setLevel', 'resources/subscribe', 'subscriptions/listen'])(
    'modern %s → 404 -32601, audited',
    async (method) => {
      const res = await modern(method, { id: 3 });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toMatchObject({ id: 3, error: { code: -32601 } });
      const rows = requestAuditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details.method).toBe(method);
      expect(rows[0]!.result).toBe('failure');
    },
  );

  it('legacy server/discover → 200 -32601 (discover is modern-only)', async () => {
    const sid = await legacyInit();
    const res = await legacy('server/discover', sid);
    expect(res.status).toBe(200);
    expect((await res.json()).error.code).toBe(-32601);
  });

  it('modern notification (no id) → 202, handleJsonRpc not called', async () => {
    const res = await modern('notifications/cancelled', { id: null });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('JSON null body → 400 -32600 on both endpoints', async () => {
    for (const path of ['/mcp/sse', '/mcp/message']) {
      const res = await app().request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
        body: 'null',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
    }
  });

  it('buildCheckedAuthFromApiKey denial (creator has no access) is identical in both eras', async () => {
    const sid = await legacyInit();
    mocks.getUserPermissionsNull.value = true;
    const legacyRes = await legacy('tools/list', sid);
    const modernRes = await modern('tools/list');
    expect(legacyRes.status).toBe(403);
    expect(modernRes.status).toBe(403);
    expect(await modernRes.json()).toEqual(await legacyRes.json());
  });

  it('request audit resourceId is a UUID and details.correlation carries principalKey, era, protocolVersion, tokenJti', async () => {
    currentKey = { id: 'oauth:jti-123', oauthGrantId: 'grant-9' };
    await modern('tools/list');
    const [row] = requestAuditRows();
    expect(row!.resourceId).toMatch(UUID_RE);
    expect(row!.details.correlation).toEqual({
      requestId: row!.resourceId,
      era: 'modern',
      protocolVersion: '2026-07-28',
      transport: 'streamable_http',
      sessionId: null,
      principalKey: 'oauth-grant:grant-9',
      tokenJti: 'jti-123',
      clientInfo: { name: 'inspector', version: '1.0' },
    });
    expect(row!.details.clientInfoTrust).toBe('self_reported');
  });

  it('legacy request audit keeps details.sessionId and adds correlation with a UUID resourceId', async () => {
    const sid = await legacyInit();
    mocks.writeAuditEvent.mockReset();
    await legacy('tools/list', sid);
    const [row] = requestAuditRows();
    expect(row!.resourceId).toMatch(UUID_RE);
    expect(row!.details).toMatchObject({ sessionId: sid, hasSession: true });
    expect(row!.details.correlation).toMatchObject({
      requestId: row!.resourceId, era: 'legacy', protocolVersion: '2025-11-25', transport: 'streamable_http', sessionId: sid,
    });
  });

  it('POST /message audit row carries correlation.transport === \'http_sse\' and the verified sessionId', async () => {
    const sid = await legacyInit();
    mocks.writeAuditEvent.mockReset();
    const res = await app().request(`/mcp/message?sessionId=${sid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const [row] = requestAuditRows();
    expect(row!.details.correlation).toMatchObject({ transport: 'http_sse', sessionId: sid, era: 'legacy' });
    expect(row!.details.sessionId).toBe(sid);
  });

  it('POST /message with a forged sessionId records no sessionId', async () => {
    const res = await app().request('/mcp/message?sessionId=mcp-forged0000000000000000', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const [row] = requestAuditRows();
    expect(row!.details.correlation.sessionId).toBeNull();
    expect(row!.details.hasSession).toBe(false);
  });

  it('tool audit and both ledger representations carry the same requestId (tier-3 path)', async () => {
    currentKey = { scopes: ['ai:read', 'ai:write', 'ai:execute'] };
    process.env.MCP_UNATTENDED_TIER3_PRINCIPALS = `api_key:${KEY_A}`;
    mocks.getToolTier.mockReturnValue(3);
    mocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
    const res = await modern('tools/call', { params: { name: 'reboot_device', arguments: { deviceId: 'd1' } } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.resultType).toBe('complete');
    const [reqRow] = requestAuditRows();
    const [toolRow] = toolAuditRows();
    const requestId = reqRow!.resourceId;
    expect(requestId).toMatch(UUID_RE);
    expect(toolRow!.resourceId).toBe(requestId);
    expect(toolRow!.details.correlation.requestId).toBe(requestId);
    expect(mocks.ledgerBegin).toHaveBeenCalledTimes(1);
    expect(mocks.ledgerBegin.mock.calls[0]![0]).toMatchObject({ transportRequestId: requestId, era: 'modern', transportSessionId: null });
  });

  it('tool audit carries the same requestId on the tenant-tool path', async () => {
    mocks.resolveTenantToolByName.mockResolvedValue({ tier: 1, name: 'hudu__get_asset', sourceId: 's1' });
    mocks.executeTenantToolDetailed.mockResolvedValue({ isError: false, text: '{"ok":true}' });
    const res = await modern('tools/call', { params: { name: 'hudu__get_asset', arguments: {} } });
    expect(res.status).toBe(200);
    const [reqRow] = requestAuditRows();
    const [toolRow] = toolAuditRows();
    expect(toolRow!.resourceId).toBe(reqRow!.resourceId);
    expect(toolRow!.details.correlation).toMatchObject({ requestId: reqRow!.resourceId, era: 'modern' });
  });

  it('resources/templates/list lists breeze://devices/{id} only when the devices domain is granted (both eras)', async () => {
    const granted = await modern('resources/templates/list');
    expect(granted.status).toBe(200);
    const grantedBody = await granted.json();
    expect(grantedBody.result.resourceTemplates).toEqual([
      { uriTemplate: 'breeze://devices/{id}', name: 'Device Detail', mimeType: 'application/json' },
    ]);
    expect(grantedBody.result).toMatchObject({ ttlMs: 60_000, cacheScope: 'private' });

    currentKey = { mcpDomains: ['monitoring'] };
    const denied = await modern('resources/templates/list');
    expect((await denied.json()).result.resourceTemplates).toEqual([]);

    currentKey = {};
    const sid = await legacyInit();
    const legacyGranted = await legacy('resources/templates/list', sid);
    const legacyBody = await legacyGranted.json();
    expect(legacyBody.result).toEqual({
      resourceTemplates: [{ uriTemplate: 'breeze://devices/{id}', name: 'Device Detail', mimeType: 'application/json' }],
    });
  });
});

describe('legacy HTTP+SSE deprecation and Origin (B-W03 Task 6)', () => {
  const DEPRECATION = '@1742947200';
  const SUNSET = 'Sun, 31 Jan 2027 23:59:59 GMT';

  it('GET /sse sets Deprecation and Sunset and writes one mcp.transport.http_sse.open audit row', async () => {
    const res = await app().request('/mcp/sse', { method: 'GET', headers: { 'X-API-Key': 'k' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toBe(DEPRECATION);
    expect(res.headers.get('sunset')).toBe(SUNSET);
    await res.body?.cancel();
    const opens = mocks.writeAuditEvent.mock.calls
      .map((call) => call[1] as Record<string, any>)
      .filter((e) => e.action === 'mcp.transport.http_sse.open');
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      actorType: 'api_key', actorId: KEY_A, orgId: 'org-1', resourceType: 'mcp_transport',
      details: { transport: 'http_sse', sunset: SUNSET },
    });
    expect(opens[0]!.resourceId).toMatch(UUID_RE);
  });

  it('POST /message sets Deprecation and Sunset', async () => {
    const res = await app().request('/mcp/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toBe(DEPRECATION);
    expect(res.headers.get('sunset')).toBe(SUNSET);
  });

  it('POST /message error responses carry the headers too', async () => {
    const res = await app().request('/mcp/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: 'null',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('sunset')).toBe(SUNSET);
  });

  it('POST /sse (Streamable, either era) sets neither', async () => {
    const legacyRes = await app().request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    const modernRes = await modern('server/discover');
    for (const res of [legacyRes, modernRes]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('deprecation')).toBeNull();
      expect(res.headers.get('sunset')).toBeNull();
    }
  });

  it('modern request with a disallowed Origin → 403 with id-less -32600, not dispatched', async () => {
    const res = await modern('tools/list', { headers: { Origin: 'https://evil.example.net' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'Origin not allowed' } });
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('modern request with no Origin passes', async () => {
    expect((await modern('tools/list')).status).toBe(200);
  });

  it('legacy request with a disallowed Origin passes (log-only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sid = await legacyInit();
    const res = await app().request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': sid, Origin: 'https://evil.example.net' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    warn.mockRestore();
  });

  it('a disallowed Origin is 403 even when the stateless request is also malformed', async () => {
    const res = await modern('tools/call', {
      params: { name: 'list_devices', arguments: {} },
      headers: { Origin: 'https://evil.example.net', 'Mcp-Name': 'other_tool' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it('POST /message with a disallowed Origin is not enforced (log-only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await app().request('/mcp/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', Origin: 'https://evil.example.net' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    warn.mockRestore();
  });

  it('GET /sse open audit names the partner explicitly for partner-scoped keys', async () => {
    mocks.apiKeyAuthMiddleware.mockImplementation(async (c: any, next: any) => {
      setApiKeyContext(c);
      c.set('apiKey', { ...c.get('apiKey'), orgId: null, partnerId: '0d0d0d0d-0000-4000-8000-00000000000d' });
      return next();
    });
    const res = await app().request('/mcp/sse', { method: 'GET', headers: { 'X-API-Key': 'k' } });
    await res.body?.cancel();
    const open = mocks.writeAuditEvent.mock.calls
      .map((call) => call[1] as Record<string, any>)
      .find((e) => e.action === 'mcp.transport.http_sse.open');
    expect(open!.partnerId).toBe('0d0d0d0d-0000-4000-8000-00000000000d');
  });
});

describe('Mcp-Name base64 sentinel through the route (Review Focus 2)', () => {
  const b64 = (v: string) => `=?base64?${Buffer.from(v).toString('base64')}?=`;

  it('a correctly encoded non-ASCII Mcp-Name dispatches', async () => {
    mocks.getToolTier.mockReturnValue(1);
    mocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
    const res = await modern('tools/call', { params: { name: 'résumé_tool', arguments: {} }, headers: { 'Mcp-Name': b64('résumé_tool') } });
    expect(res.status).toBe(200);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(mocks.executeTool.mock.calls[0]![0]).toBe('résumé_tool');
  });

  it.each([
    ['bad base64', '=?base64?!!!?='],
    ['decoded mismatch', `=?base64?${Buffer.from('other_tool').toString('base64')}?=`],
  ])('%s → 400 -32020, not dispatched', async (_label, header) => {
    const res = await modern('tools/call', { params: { name: 'get_weather', arguments: {} }, headers: { 'Mcp-Name': header } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32020);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});

