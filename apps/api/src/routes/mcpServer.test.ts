import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from 'vitest';

const testState = vi.hoisted(() => {
  const originalAllowlist = process.env.MCP_EXECUTE_TOOL_ALLOWLIST;
  const originalMaxSseSessions = process.env.MCP_MAX_SSE_SESSIONS_PER_KEY;
  // The route parses this once. Individual production-gate cases use tools
  // that are respectively inside/outside this fixed harness allowlist.
  process.env.MCP_EXECUTE_TOOL_ALLOWLIST = 'execute_command,registry_operations';
  process.env.MCP_MAX_SSE_SESSIONS_PER_KEY = '2';
  return {
    originalAllowlist,
    originalMaxSseSessions,
    apiKey: null as Record<string, any> | null,
    db: {} as Record<string, any>,
    redis: null as Record<string, any> | null,
    bootstrap: { unauthTools: [], authTools: [] } as { unauthTools: any[]; authTools: any[] },
    oauthEnabled: true,
    oauthIssuer: 'https://us.example.com',
    aiTools: new Map<string, any>(),
    realCheckGuardrails: undefined as undefined | ((...args: any[]) => any),
  };
});

const routeMocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(),
  getToolTier: vi.fn(),
  verifyDeviceAccess: vi.fn(),
  checkGuardrails: vi.fn(),
  checkToolPermission: vi.fn(),
  checkToolRateLimit: vi.fn(),
  checkPermissionRequirement: vi.fn(),
  writeAuditEvent: vi.fn(),
  rateLimiter: vi.fn(),
  enforceIpAllowlist: vi.fn(),
  // A real vi.fn() (not a plain testState-backed factory) so individual tests
  // can reprogram it via mockReturnValueOnce/mockReturnValue without a
  // vi.doMock + vi.resetModules round trip — this suite's mcpServerRoutes is
  // a static top-level import (see below), so a post-load vi.doMock never
  // reaches it.
  getUserPermissions: vi.fn(),
}));

// SR2-15 (Task 3, scope re-clamp): buildAuthFromApiKey's org branch now routes
// through authorizeHumanApiKeyCreator, which re-validates the API key's
// STORED scopes against these live permissions (validateApiKeyScopeDelegation)
// before returning an AuthContext. This suite's tests are exercising
// transport/session/tier concerns, not scope delegation, so the default
// creator here must hold every non-admin permission the ai:read/ai:write/
// ai:execute policies require — otherwise every test whose mocked apiKey
// carries one of those scopes would be denied by the re-clamp guard before
// ever reaching the behavior under test. `ai:execute_admin` (which requires
// the wildcard ADMIN_ALL grant) is deliberately EXCLUDED so the "key lacks
// ai:execute_admin" tests still exercise a real denial.
const DEFAULT_PERMISSIONS_BASELINE = {
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
};

const WILDCARD_PERMISSIONS = {
  permissions: [{ resource: '*', action: '*' }],
  partnerId: null,
  orgId: 'org-1',
  roleId: 'role-1',
  scope: 'organization' as const,
};

vi.mock('../config/env', () => ({
  get MCP_OAUTH_ENABLED() { return testState.oauthEnabled; },
  get OAUTH_ISSUER() { return testState.oauthIssuer; },
}));

// Mock heavy module-graph leaves so importing ./mcpServer doesn't stand up
// a real postgres client / redis connection.
vi.mock('../db', () => ({
  db: new Proxy({}, {
    get: (_target, property) => testState.db[property as string],
  }),
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
  alerts: {},
  scripts: {},
  automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partnerUsers: {
    userId: 'partnerUsers.userId',
    partnerId: 'partnerUsers.partnerId',
    orgAccess: 'partnerUsers.orgAccess',
    orgIds: 'partnerUsers.orgIds',
  },
  aiSessions: { id: 'aiSessions.id' },
  aiToolExecutions: { id: 'aiToolExecutions.id' },
  apiKeys: {},
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
}));

// buildAuthFromApiKey now calls getUserPermissions for org keys (to inherit the
// creator's site allowlist). Keep every real export the route graph needs and
// stub only getUserPermissions to an unrestricted org perms object so these
// transport/bootstrap tests don't need to model the permissions DB queries.
// Routed through routeMocks.getUserPermissions (see DEFAULT_PERMISSIONS_BASELINE
// / WILDCARD_PERMISSIONS above) so individual tests can reprogram it.
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: (...args: any[]) => routeMocks.getUserPermissions(...args),
  };
});

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: (...args: any[]) => routeMocks.getToolDefinitions(...args),
  executeTool: (...args: any[]) => routeMocks.executeTool(...args),
  getToolTier: (...args: any[]) => routeMocks.getToolTier(...args),
  get aiTools() { return testState.aiTools; },
  verifyDeviceAccess: (...args: any[]) => routeMocks.verifyDeviceAccess(...args),
}));

vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  testState.realCheckGuardrails = actual.checkGuardrails;
  return {
    ...actual,
    checkGuardrails: (...args: any[]) => routeMocks.checkGuardrails(...args),
    checkToolPermission: (...args: any[]) => routeMocks.checkToolPermission(...args),
    checkToolRateLimit: (...args: any[]) => routeMocks.checkToolRateLimit(...args),
    checkPermissionRequirement: (...args: any[]) => routeMocks.checkPermissionRequirement(...args),
  };
});

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: (...args: any[]) => routeMocks.writeAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedis: () => testState.redis,
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: any[]) => routeMocks.rateLimiter(...args),
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (c: any, next: any) => {
    if (!testState.apiKey) throw new Error('API-key middleware called without test key state');
    c.set('apiKey', testState.apiKey);
    if (testState.apiKey.orgId) c.set('apiKeyOrgId', testState.apiKey.orgId);
    await next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => {
    throw new Error('should not be called without a Bearer header');
  },
  // mcpServer imports the canonical partner→org resolver from here (deduped
  // from its former inline copy). Reimplement the real query logic against the
  // mocked `db` so the per-case db shims (membership lookup via .limit, then org
  // enumeration via awaited .where) still drive the partner-scope path.
  resolvePartnerAccessibleOrgIds: async (partnerId: string, _userId: string) => {
    const { db } = await import('../db');
    const [membership] = await (db as any).select().from().where().limit(1);
    if (!membership) return [];
    if (membership.orgAccess === 'none') return [];
    if (membership.orgAccess === 'selected') {
      const selected = (membership.orgIds ?? []).filter(
        (v: unknown): v is string => typeof v === 'string' && v.length > 0,
      );
      if (selected.length === 0) return [];
      const rows = await (db as any).select().from().where();
      return rows.map((r: any) => r.id);
    }
    const rows = await (db as any).select().from().where();
    return rows.map((r: any) => r.id);
  },
}));

vi.mock('../services/ipAllowlist', () => ({
  enforceIpAllowlist: (...args: any[]) => routeMocks.enforceIpAllowlist(...args),
  IP_NOT_ALLOWED_BODY: { code: 'ip_not_allowed', error: 'Access denied from this IP address' },
  isBlocked: (decision: { decision: string }) => decision.decision === 'deny',
}));

vi.mock('../modules/mcpInvites', () => ({
  initMcpBootstrap: () => testState.bootstrap,
}));

import { __loadMcpBootstrapForTests, mcpServerRoutes } from './mcpServer';

function setTestApiKey(overrides: Record<string, unknown> = {}) {
  testState.apiKey = {
    id: 'key-1',
    orgId: 'org-1',
    partnerId: 'partner-1',
    name: 'test',
    keyPrefix: 'brz_test',
    scopes: ['ai:read'],
    rateLimit: 1000,
    createdBy: 'user-1',
    ...overrides,
  };
}

function useSessionRedis(store: Map<string, string>) {
  testState.redis = {
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
}

afterAll(() => {
  if (testState.originalAllowlist === undefined) delete process.env.MCP_EXECUTE_TOOL_ALLOWLIST;
  else process.env.MCP_EXECUTE_TOOL_ALLOWLIST = testState.originalAllowlist;
  if (testState.originalMaxSseSessions === undefined) delete process.env.MCP_MAX_SSE_SESSIONS_PER_KEY;
  else process.env.MCP_MAX_SSE_SESSIONS_PER_KEY = testState.originalMaxSseSessions;
});

// Test the pure utility functions extracted from mcpServer.ts
// These are not exported, so we test them via their behavior patterns

describe('MCP utility functions', () => {
  describe('parseCsvSet', () => {
    function parseCsvSet(raw: string | undefined): Set<string> {
      if (!raw) return new Set();
      return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    }

    it('returns empty set for undefined', () => {
      expect(parseCsvSet(undefined).size).toBe(0);
    });

    it('returns empty set for empty string', () => {
      expect(parseCsvSet('').size).toBe(0);
    });

    it('returns empty set for whitespace-only', () => {
      expect(parseCsvSet('  ,  , ').size).toBe(0);
    });

    it('parses single value', () => {
      const result = parseCsvSet('foo');
      expect(result.size).toBe(1);
      expect(result.has('foo')).toBe(true);
    });

    it('parses multiple values with whitespace', () => {
      const result = parseCsvSet(' foo , bar , baz ');
      expect(result.size).toBe(3);
      expect(result.has('foo')).toBe(true);
      expect(result.has('bar')).toBe(true);
      expect(result.has('baz')).toBe(true);
    });

    it('handles trailing comma', () => {
      const result = parseCsvSet('foo,bar,');
      expect(result.size).toBe(2);
    });

    it('deduplicates values', () => {
      const result = parseCsvSet('foo,foo,bar');
      expect(result.size).toBe(2);
    });
  });

  describe('envInt', () => {
    function envInt(name: string, fallback: number): number {
      const raw = process.env[name];
      if (!raw) return fallback;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    it('returns fallback when env var is not set', () => {
      delete process.env.__TEST_ENV_INT;
      expect(envInt('__TEST_ENV_INT', 42)).toBe(42);
    });

    it('parses valid integer', () => {
      process.env.__TEST_ENV_INT = '100';
      expect(envInt('__TEST_ENV_INT', 42)).toBe(100);
      delete process.env.__TEST_ENV_INT;
    });

    it('returns fallback for non-numeric string', () => {
      process.env.__TEST_ENV_INT = 'abc';
      expect(envInt('__TEST_ENV_INT', 42)).toBe(42);
      delete process.env.__TEST_ENV_INT;
    });

    it('returns fallback for empty string', () => {
      process.env.__TEST_ENV_INT = '';
      expect(envInt('__TEST_ENV_INT', 42)).toBe(42);
      delete process.env.__TEST_ENV_INT;
    });
  });

  describe('isExecuteToolAllowedInProd', () => {
    function isExecuteToolAllowedInProd(allowlist: Set<string>, toolName: string): boolean {
      if (allowlist.size === 0) return false;
      return allowlist.has('*') || allowlist.has(toolName);
    }

    it('denies all when allowlist is empty', () => {
      expect(isExecuteToolAllowedInProd(new Set(), 'any-tool')).toBe(false);
    });

    it('allows any tool with wildcard', () => {
      const allowlist = new Set(['*']);
      expect(isExecuteToolAllowedInProd(allowlist, 'delete-device')).toBe(true);
      expect(isExecuteToolAllowedInProd(allowlist, 'run-script')).toBe(true);
    });

    it('allows only listed tools', () => {
      const allowlist = new Set(['run-script', 'restart-service']);
      expect(isExecuteToolAllowedInProd(allowlist, 'run-script')).toBe(true);
      expect(isExecuteToolAllowedInProd(allowlist, 'restart-service')).toBe(true);
      expect(isExecuteToolAllowedInProd(allowlist, 'delete-device')).toBe(false);
    });
  });
});

// ============================================================================
// MCP transport integration tests
// ============================================================================
//
// The route no longer reads IS_HOSTED or starts bootstrap loading at import.
// This suite reuses one static route graph and changes only live mock state.

describe('MCP transport integration', () => {
  const originalFlag = process.env.IS_HOSTED;
  const originalExecuteAdmin = process.env.MCP_REQUIRE_EXECUTE_ADMIN;
  const originalAllowlist = process.env.MCP_EXECUTE_TOOL_ALLOWLIST;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;

  beforeEach(async () => {
    testState.apiKey = null;
    testState.db = {};
    testState.redis = null;
    testState.bootstrap = { unauthTools: [], authTools: [] };
    testState.oauthEnabled = true;
    testState.oauthIssuer = 'https://us.example.com';
    testState.aiTools = new Map();
    routeMocks.executeTool.mockReset();
    routeMocks.getToolDefinitions.mockReset().mockReturnValue([]);
    routeMocks.getToolTier.mockReset().mockReturnValue(undefined);
    routeMocks.verifyDeviceAccess.mockReset().mockResolvedValue({ device: { orgId: 'org-1', siteId: null } });
    routeMocks.checkGuardrails.mockReset().mockImplementation((...args: any[]) =>
      testState.realCheckGuardrails!(...args));
    routeMocks.checkToolPermission.mockReset().mockResolvedValue(null);
    routeMocks.checkToolRateLimit.mockReset().mockResolvedValue(null);
    routeMocks.checkPermissionRequirement.mockReset().mockResolvedValue(null);
    routeMocks.writeAuditEvent.mockReset();
    routeMocks.rateLimiter.mockReset().mockResolvedValue({
      allowed: true,
      remaining: 100,
      resetAt: new Date(Date.now() + 60_000),
    });
    routeMocks.enforceIpAllowlist.mockReset().mockResolvedValue({ decision: 'allow' });
    routeMocks.getUserPermissions.mockReset().mockResolvedValue(DEFAULT_PERMISSIONS_BASELINE);
    await __loadMcpBootstrapForTests();
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.IS_HOSTED;
    else process.env.IS_HOSTED = originalFlag;
    if (originalExecuteAdmin === undefined) delete process.env.MCP_REQUIRE_EXECUTE_ADMIN;
    else process.env.MCP_REQUIRE_EXECUTE_ADMIN = originalExecuteAdmin;
    if (originalAllowlist === undefined) delete process.env.MCP_EXECUTE_TOOL_ALLOWLIST;
    else process.env.MCP_EXECUTE_TOOL_ALLOWLIST = originalAllowlist;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalTrustProxyHeaders === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
  });

  it('partner-scoped API key is denied by the partner IP allowlist before MCP dispatch', async () => {
    delete process.env.IS_HOSTED;

    setTestApiKey({ id: 'key-partner', orgId: null, name: 'partner', keyPrefix: 'brz_partner' });

    const enforceMock = routeMocks.enforceIpAllowlist;
    enforceMock.mockResolvedValue({ decision: 'deny', reason: 'not_in_list' });

    let selectCall = 0;
    testState.db = {
        select: () => {
          selectCall += 1;
          if (selectCall === 1) {
            return {
              from: () => ({
                where: () => ({
                  limit: async () => [{ orgAccess: 'all', orgIds: null }],
                }),
              }),
            };
          }
          return {
            from: () => ({
              where: async () => [{ id: 'org-1' }],
            }),
          };
        },
      };

    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_partner' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: 'ip_not_allowed',
      error: 'Access denied from this IP address',
    });
    expect(enforceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        partnerId: 'partner-1',
        isPlatformAdmin: false,
        actorId: 'user-1',
        actorEmail: 'apikey-partner@breeze.local',
      }),
    );
  });


  it('rejects oversized authed MCP JSON-RPC bodies before parsing', async () => {
    delete process.env.IS_HOSTED;

    setTestApiKey();

    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { padding: 'x'.repeat(70 * 1024) },
      }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Request body too large' },
    });
  });

  it('keys production MCP message limits by stable OAuth grant when present', async () => {
    delete process.env.IS_HOSTED;
    process.env.NODE_ENV = 'production';

    setTestApiKey({
      id: 'oauth:access-jti-1',
      oauthGrantId: 'grant-stable-1',
      name: 'OAuth bearer',
      keyPrefix: 'oauth',
    });

    const rateLimiter = routeMocks.rateLimiter;
    rateLimiter.mockResolvedValue({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) });
    testState.redis = {};

    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'oauth-bearer-test' },
      body: '{',
    });

    expect(res.status).toBe(400);
    expect(rateLimiter).toHaveBeenCalledWith({}, 'mcp:msg:oauth-grant:grant-stable-1', 120, 60);
  });

  it('production defaults to requiring ai:execute_admin for tier-3 MCP calls', async () => {
    delete process.env.IS_HOSTED;
    process.env.NODE_ENV = 'production';
    delete process.env.MCP_REQUIRE_EXECUTE_ADMIN;

    setTestApiKey({ scopes: ['ai:read', 'ai:execute'] });

    const executeTool = routeMocks.executeTool;
    executeTool.mockResolvedValue('{"ok":true}');
    routeMocks.getToolDefinitions.mockReturnValue([{ name: 'execute_command', description: '', input_schema: {} }]);
    routeMocks.getToolTier.mockImplementation((name: string) => (name === 'execute_command' ? 3 : undefined));
    testState.aiTools = new Map([['execute_command', { deviceArgs: ['deviceId'] }]]);
    testState.redis = { get: vi.fn(async () => null) };

    const ledgerInsertValues: any[] = [];
    const ledgerUpdateSet = vi.fn();
    testState.db = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }),
          }),
        }),
        insert: () => ({
          values: (value: any) => {
            ledgerInsertValues.push(value);
            return { returning: async () => [{ id: 'mcp-exec-1' }] };
          },
        }),
        update: () => ({
          set: (value: any) => {
            ledgerUpdateSet(value);
            return { where: async () => undefined };
          },
        }),
      };

    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'execute_command', arguments: {} },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error?.message).toBe('Tool "execute_command" requires ai:execute_admin scope in production');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('production can explicitly opt out of the execute-admin requirement while keeping the allowlist gate', async () => {
    delete process.env.IS_HOSTED;
    process.env.NODE_ENV = 'production';
    process.env.MCP_REQUIRE_EXECUTE_ADMIN = 'false';

    setTestApiKey({ scopes: ['ai:read', 'ai:execute'] });

    const executeTool = routeMocks.executeTool;
    executeTool.mockResolvedValue('{"ok":true}');
    routeMocks.getToolDefinitions.mockReturnValue([{ name: 'execute_command', description: '', input_schema: {} }]);
    routeMocks.getToolTier.mockImplementation((name: string) => (name === 'execute_command' ? 3 : undefined));
    testState.aiTools = new Map([['execute_command', { deviceArgs: ['deviceId'] }]]);
    testState.redis = { get: vi.fn(async () => null) };

    const ledgerInsertValues: any[] = [];
    const ledgerUpdateSet = vi.fn();
    testState.db = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }),
          }),
        }),
        insert: () => ({
          values: (value: any) => {
            ledgerInsertValues.push(value);
            return { returning: async () => [{ id: 'mcp-exec-1' }] };
          },
        }),
        update: () => ({
          set: (value: any) => {
            ledgerUpdateSet(value);
            return { where: async () => undefined };
          },
        }),
      };

    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'execute_command', arguments: {} },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(executeTool).toHaveBeenCalledWith(
      'execute_command',
      {},
      expect.objectContaining({ partnerId: 'partner-1', orgId: 'org-1' }),
    );
  });

  it('writes a sanitized tool-level audit event for successful tier-3 MCP calls', async () => {
    delete process.env.IS_HOSTED;
    process.env.NODE_ENV = 'development';

    setTestApiKey({ oauthGrantId: 'grant-1', scopes: ['ai:read', 'ai:execute'] });

    routeMocks.getToolDefinitions.mockReturnValue([{ name: 'execute_command', description: '', input_schema: {} }]);
    routeMocks.executeTool.mockResolvedValue(JSON.stringify({ status: 'completed', stdout: 'token=raw-secret' }));
    routeMocks.getToolTier.mockImplementation((name: string) => (name === 'execute_command' ? 3 : undefined));
    testState.aiTools = new Map([['execute_command', { deviceArgs: ['deviceId'] }]]);
    testState.redis = { get: vi.fn(async () => null) };
    const ledgerInsertValues: any[] = [];
    const ledgerUpdateSet = vi.fn();
    testState.db = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }),
          }),
        }),
        insert: () => ({
          values: (value: any) => {
            ledgerInsertValues.push(value);
            return { returning: async () => [{ id: 'mcp-exec-1' }] };
          },
        }),
        update: () => ({
          set: (value: any) => {
            ledgerUpdateSet(value);
            return { where: async () => undefined };
          },
        }),
      };
    const writeAuditEvent = routeMocks.writeAuditEvent;

    // Pass an attacker-forged ?sessionId=. With MED-1 follow-through the
    // server now drops sessionIds the caller doesn't own — the audit row
    // MUST NOT echo `mcp-attacker-forged`. The sanitization assertions
    // below still pass because they don't depend on session id routing.
    const res = await mcpServerRoutes.request('/message?sessionId=mcp-attacker-forged', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'execute_command',
          arguments: {
            orgId: 'org-1',
            deviceId: 'device-1',
            command: 'do-work',
            token: 'raw-token',
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('raw-secret');
    expect(JSON.stringify(body)).toContain('[REDACTED]');
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-1',
        actorType: 'api_key',
        actorId: 'key-1',
        action: 'mcp.tool.execute_command',
        resourceType: 'mcp_tool_execution',
        result: 'success',
        details: expect.objectContaining({
          toolName: 'execute_command',
          tier: 3,
          oauthGrantId: 'grant-1',
          target: expect.objectContaining({ deviceId: 'device-1' }),
          arguments: expect.objectContaining({ token: '[REDACTED]' }),
          result: expect.objectContaining({
            resultKeys: expect.arrayContaining(['status', 'stdout']),
            resultBytes: expect.any(Number),
            resultSha256: expect.any(String),
          }),
        }),
      }),
    );
    expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toContain('raw-token');
    expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toContain('raw-secret');
    // MED-1 regression: the attacker-forged sessionId must not have landed
    // in the audit or ledger payloads.
    expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toContain('mcp-attacker-forged');
    expect(JSON.stringify(ledgerInsertValues)).not.toContain('mcp-attacker-forged');
    expect(ledgerInsertValues[1]).toMatchObject({
      toolName: 'execute_command',
      status: 'executing',
      toolInput: expect.objectContaining({
        source: 'mcp',
        orgId: 'org-1',
        toolName: 'execute_command',
        tier: 3,
        principal: expect.objectContaining({
          type: 'api_key',
          apiKeyId: 'key-1',
          oauthGrantId: 'grant-1',
          partnerId: 'partner-1',
        }),
        target: expect.objectContaining({ deviceId: 'device-1' }),
      }),
    });
    expect(ledgerUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      toolOutput: expect.objectContaining({
        source: 'mcp',
        status: 'success',
        result: expect.objectContaining({
          resultKeys: expect.arrayContaining(['status', 'stdout']),
        }),
      }),
    }));
    expect(JSON.stringify(ledgerInsertValues)).not.toContain('raw-token');
    expect(JSON.stringify(ledgerUpdateSet.mock.calls)).not.toContain('raw-secret');
  });

  it('writes a failed tool-level audit event when tier-3 MCP execution throws', async () => {
    delete process.env.IS_HOSTED;
    process.env.NODE_ENV = 'development';

    setTestApiKey({ scopes: ['ai:read', 'ai:execute'] });
    routeMocks.getToolDefinitions.mockReturnValue([{ name: 'execute_command', description: '', input_schema: {} }]);
    routeMocks.executeTool.mockRejectedValue(new TypeError('boom with token=raw-secret'));
    routeMocks.getToolTier.mockImplementation((name: string) => (name === 'execute_command' ? 3 : undefined));
    testState.aiTools = new Map([['execute_command', { deviceArgs: ['deviceId'] }]]);
    testState.redis = { get: vi.fn(async () => null) };
    const ledgerInsertValues: any[] = [];
    const ledgerUpdateSet = vi.fn();
    testState.db = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }),
          }),
        }),
        insert: () => ({
          values: (value: any) => {
            ledgerInsertValues.push(value);
            return { returning: async () => [{ id: 'mcp-exec-1' }] };
          },
        }),
        update: () => ({
          set: (value: any) => {
            ledgerUpdateSet(value);
            return { where: async () => undefined };
          },
        }),
      };
    const writeAuditEvent = routeMocks.writeAuditEvent;

    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'execute_command', arguments: { deviceId: 'device-1', password: 'hunter2' } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body)).not.toContain('raw-secret');
    expect(JSON.stringify(body)).toContain('[REDACTED]');
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'mcp.tool.execute_command',
        result: 'failure',
        errorMessage: 'boom with token=[REDACTED]',
        details: expect.objectContaining({
          errorClass: 'TypeError',
          arguments: expect.objectContaining({ password: '[REDACTED]' }),
        }),
      }),
    );
    expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toContain('hunter2');
    expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toContain('raw-secret');
    expect(ledgerInsertValues[1]).toMatchObject({
      toolName: 'execute_command',
      status: 'executing',
      toolInput: expect.objectContaining({
        source: 'mcp',
        orgId: 'org-1',
        toolName: 'execute_command',
        tier: 3,
        target: expect.objectContaining({ deviceId: 'device-1' }),
      }),
    });
    expect(ledgerUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorMessage: 'boom with token=[REDACTED]',
      toolOutput: expect.objectContaining({
        source: 'mcp',
        status: 'failure',
        errorClass: 'TypeError',
      }),
    }));
    expect(JSON.stringify(ledgerInsertValues)).not.toContain('hunter2');
    expect(JSON.stringify(ledgerUpdateSet.mock.calls)).not.toContain('raw-secret');
  });

  it('enforces stream-byte limit even when content-length is missing/lying', async () => {
    // The content-length pre-check in readJsonRpcBodyWithLimit is easy to
    // spoof (omit the header, or send a small lie). The real defense is the
    // bytesRead accumulator inside the read loop. Build a Request whose
    // ReadableStream emits chunks summing to MAX+1 bytes and whose
    // content-length header is omitted entirely — the loop must still 413.
    delete process.env.IS_HOSTED;

    setTestApiKey({ id: 'key-stream' });

    const MAX = 64 * 1024; // matches MCP_MESSAGE_MAX_BODY_BYTES default
    const chunkSize = 8 * 1024;
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted > MAX) {
          controller.close();
          return;
        }
        const remaining = MAX + 1 - emitted;
        const size = Math.min(chunkSize, remaining);
        controller.enqueue(new Uint8Array(size).fill(0x20)); // ASCII space
        emitted += size;
      },
    });

    // No content-length header — Hono reads the body via the stream, which is
    // exactly the spoofing case we're defending against.
    const req = new Request('http://localhost/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: stream,
      // @ts-expect-error — Node fetch needs duplex when sending a stream body
      duplex: 'half',
    });

    const res = await mcpServerRoutes.request(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error?.message).toBe('Request body too large');
  });

  it('keeps SSE queues partitioned per OAuth grant — distinct grants for the same user do NOT share a queue', async () => {
    // Regression test for mcpPrincipalKey() bucketing. Two access tokens
    // belonging to the same user but different OAuth grants must end up in
    // separate SSE queues. Keep each successful response open while asserting
    // the cap, then cancel every reader and prove the same principal can fill
    // its cap again without inheriting module-owned sessions from this phase.
    delete process.env.IS_HOSTED;
    process.env.NODE_ENV = 'production';

    testState.redis = { get: vi.fn(async () => null) };

    const grantA = {
      id: 'oauth:jti-a-1',
      oauthGrantId: 'grant-A',
      orgId: 'org-1',
      partnerId: 'partner-1',
      name: 'A',
      keyPrefix: 'oauth',
      scopes: ['ai:read'],
      rateLimit: 1000,
      createdBy: 'user-shared',
    };
    const grantB = { ...grantA, id: 'oauth:jti-b-1', oauthGrantId: 'grant-B', name: 'B' };

    async function openSse(
      apiKey: typeof grantA,
      readers: Array<ReadableStreamDefaultReader<Uint8Array>>,
    ) {
      testState.apiKey = apiKey;
      const response = await mcpServerRoutes.request('/sse', {
        method: 'GET',
        headers: { 'X-API-Key': 'whatever' },
      });
      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();

      const reader = response.body!.getReader();
      readers.push(reader);
      const firstChunk = await reader.read();
      expect(firstChunk.done).toBe(false);
      expect(new TextDecoder().decode(firstChunk.value)).toContain('event: endpoint');
    }

    async function cancelReaders(
      readers: Array<ReadableStreamDefaultReader<Uint8Array>>,
    ) {
      await Promise.all(readers.splice(0).map((reader) => reader.cancel()));
      // The route poll loop sleeps for 100ms. Give aborted callbacks one poll
      // turn to reach their finally blocks and clear keepalive intervals.
      await new Promise((resolve) => setTimeout(resolve, 125));
    }

    const liveReaders: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
    try {
      await openSse(grantA, liveReaders);
      await openSse(grantA, liveReaders);

      // Grant A has filled its per-principal cap.
      testState.apiKey = grantA;
      const overA = await mcpServerRoutes.request('/sse', {
        method: 'GET',
        headers: { 'X-API-Key': 'whatever' },
      });
      expect(overA.status).toBe(429);

      // A distinct grant for the same user owns a separate queue bucket.
      await openSse(grantB, liveReaders);

      const grantKey = (grant: { id: string; oauthGrantId?: string | null }) =>
        grant.oauthGrantId ? `oauth-grant:${grant.oauthGrantId}` : grant.id;
      expect(grantKey(grantA)).toBe('oauth-grant:grant-A');
      expect(grantKey(grantB)).toBe('oauth-grant:grant-B');
      expect(grantKey({ id: 'oauth:jti-a-1' })).toBe('oauth:jti-a-1');
      expect(grantKey({ id: 'oauth:jti-a-1' }).startsWith('oauth-grant:')).toBe(false);
    } finally {
      await cancelReaders(liveReaders);
    }

    // Cancellation must release both grant-A slots. Opening two fresh streams
    // proves no prior session remains in the module-owned cap map.
    const postCleanupReaders: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
    try {
      await openSse(grantA, postCleanupReaders);
      await openSse(grantA, postCleanupReaders);
    } finally {
      await cancelReaders(postCleanupReaders);
    }
  });

  it('SSE endpoint event uses the configured public base URL scheme/host, not the raw request URL', async () => {
    // Regression: behind a reverse proxy (Caddy) the inbound hop is plain http,
    // so deriving the message endpoint from c.req.url emitted an http:// URL on
    // an https deployment. The endpoint must come from resolveServerUrl
    // (BREEZE_SERVER || PUBLIC_API_URL) so it honors the external scheme/host.
    delete process.env.IS_HOSTED;
    const savedPublic = process.env.PUBLIC_API_URL;
    const savedServer = process.env.BREEZE_SERVER;
    delete process.env.BREEZE_SERVER;
    process.env.PUBLIC_API_URL = 'https://mcp.example.com';

    setTestApiKey({ id: 'key-sse-scheme' });
    testState.redis = null;

    try {
      const res = await mcpServerRoutes.request('/sse', {
        method: 'GET',
        headers: { 'X-API-Key': 'whatever' },
      });
      expect(res.status).toBe(200);

      // The endpoint event is the first thing written; read one chunk then
      // cancel so the handler's poll loop doesn't hang the test.
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      const chunk = new TextDecoder().decode(value);

      expect(chunk).toContain('event: endpoint');
      expect(chunk).toMatch(/data: https:\/\/mcp\.example\.com\/message\?sessionId=/);
      expect(chunk).not.toContain('data: http://');
    } finally {
      if (savedPublic === undefined) delete process.env.PUBLIC_API_URL;
      else process.env.PUBLIC_API_URL = savedPublic;
      if (savedServer === undefined) delete process.env.BREEZE_SERVER;
      else process.env.BREEZE_SERVER = savedServer;
    }
  });

  // ===========================================================================
  // MED-1: Mcp-Session-Id is server-minted and bound to the calling principal
  // ===========================================================================
  //
  // Audit finding: the streamable HTTP handler (POST /sse) previously echoed
  // the client-supplied `Mcp-Session-Id` header straight into the audit row
  // (resourceId) and tool-execution ledger (transportSessionId). An attacker
  // could stamp arbitrary UUIDs per call to muddy audit triage or merge their
  // activity into another principal's session.
  //
  // Fix: on `initialize` we ignore any client-supplied value and mint
  // `mcp-<hex>` server-side, persisting `(sessionId → principalKey)` to Redis.
  // On every subsequent JSON-RPC method we require the server-prefixed
  // `Mcp-Session-Id` header AND principal-equality, else 403.

  it('MED-1 initialize: ignores client-supplied Mcp-Session-Id, mints server-prefixed value', async () => {
    delete process.env.IS_HOSTED;

    setTestApiKey({ id: 'key-med1-init' });

    const sessionStore = new Map<string, string>();
    useSessionRedis(sessionStore);

    const res = await mcpServerRoutes.request('/sse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-Key': 'brz_test',
        'Mcp-Session-Id': 'attacker-chose-this',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get('Mcp-Session-Id');
    expect(sessionId).not.toBe('attacker-chose-this');
    expect(sessionId).toMatch(/^mcp-[a-f0-9]{20,}$/);
  });

  it('MED-1 reuse: rejects subsequent calls with a session-id owned by a different principal', async () => {
    delete process.env.IS_HOSTED;

    const sessionStore = new Map<string, string>();
    useSessionRedis(sessionStore);

    const keyA = {
      id: 'key-med1-A',
      orgId: 'org-1',
      partnerId: 'partner-1',
      name: 'A',
      keyPrefix: 'brz_a',
      scopes: ['ai:read'],
      rateLimit: 1000,
      createdBy: 'user-A',
    };
    const keyB = {
      id: 'key-med1-B',
      orgId: 'org-1',
      partnerId: 'partner-1',
      name: 'B',
      keyPrefix: 'brz_b',
      scopes: ['ai:read'],
      rateLimit: 1000,
      createdBy: 'user-B',
    };

    testState.apiKey = keyA;
    const initA = await mcpServerRoutes.request('/sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_a' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    });
    expect(initA.status).toBe(200);
    const sessionId = initA.headers.get('Mcp-Session-Id');
    expect(sessionId).toMatch(/^mcp-[a-f0-9]{20,}$/);

    // Principal B tries to ride principal A's session.
    testState.apiKey = keyB;
    const stolen = await mcpServerRoutes.request('/sse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-Key': 'brz_b',
        'Mcp-Session-Id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });
    expect(stolen.status).toBe(403);
    const stolenBody = await stolen.json();
    expect(stolenBody.error?.message).toMatch(/session/i);
  });

  it('MED-1 same-principal: originating caller can reuse the minted session id', async () => {
    delete process.env.IS_HOSTED;

    setTestApiKey({ id: 'key-med1-same' });

    const sessionStore = new Map<string, string>();
    useSessionRedis(sessionStore);

    const initRes = await mcpServerRoutes.request('/sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('Mcp-Session-Id');
    expect(sessionId).toMatch(/^mcp-[a-f0-9]{20,}$/);

    const followUp = await mcpServerRoutes.request('/sse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-Key': 'brz_test',
        'Mcp-Session-Id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });
    expect(followUp.status).toBe(200);
    const followUpBody = await followUp.json();
    expect(followUpBody.error).toBeUndefined();
    expect(followUpBody.result).toBeDefined();
  });

  it('MED-1 missing-or-malformed session id on non-initialize → 400', async () => {
    delete process.env.IS_HOSTED;

    setTestApiKey({ id: 'key-med1-noid' });

    const sessionStore = new Map<string, string>();
    useSessionRedis(sessionStore);

    // No Mcp-Session-Id at all.
    const noHeader = await mcpServerRoutes.request('/sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(noHeader.status).toBe(400);
    const noHeaderBody = await noHeader.json();
    expect(noHeaderBody.error?.message).toMatch(/session/i);

    // Client-shaped id without the `mcp-` server prefix.
    const badPrefix = await mcpServerRoutes.request('/sse', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-Key': 'brz_test',
        'Mcp-Session-Id': 'attacker-chose-this',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });
    expect(badPrefix.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // C2 — production gates apply to the ESCALATED effective tier, not the base
  // tier. Base-tier-1 registry/process tools with TIER3 actions escalate to
  // tier 3, so the prod allowlist + execute_admin levers must fire exactly as
  // they do for a statically-tier-3 tool. Uses the REAL aiGuardrails so the
  // escalation is genuine.
  // -------------------------------------------------------------------------

  function mockKeyWithScopes(scopes: string[]) {
    setTestApiKey({ scopes });
  }

  function mockRealGuardrailsWithEscalatedTier1Tools() {
    // Both tools are base tier 1; real aiGuardrails escalates their destructive
    // actions to tier 3. RBAC/rate-limit checks remain the shared benign stubs.
    routeMocks.getToolDefinitions.mockReturnValue([
      { name: 'registry_operations', description: '', input_schema: {} },
      { name: 'manage_processes', description: '', input_schema: {} },
    ]);
    routeMocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
    routeMocks.getToolTier.mockImplementation((name: string) =>
      name === 'registry_operations' || name === 'manage_processes' ? 1 : undefined);
    testState.db = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }),
          }),
        }),
        insert: () => ({
          values: () => ({ returning: async () => [{ id: 'mcp-exec-1' }] }),
        }),
        update: () => ({
          set: () => ({ where: async () => undefined }),
        }),
      };
    testState.redis = { get: vi.fn(async () => null) };
  }

  it('C2: escalated tier-3 action NOT in the prod allowlist is denied', async () => {
    delete process.env.IS_HOSTED;
    process.env.NODE_ENV = 'production';
    mockKeyWithScopes(['ai:read', 'ai:execute', 'ai:execute_admin']);
    // SR2-15 (Task 3, scope re-clamp): this key's stored scopes include
    // ai:execute_admin (requires the wildcard ADMIN_ALL grant). The default
    // getUserPermissions mock deliberately withholds that grant (so the
    // "key lacks ai:execute_admin" test below stays a real denial); override
    // it here with a wildcard-permissioned creator so the coarse scope
    // re-clamp passes and this test can exercise the ACTUAL concern under
    // test — the MCP_EXECUTE_TOOL_ALLOWLIST gate, not scope delegation.
    routeMocks.getUserPermissions.mockResolvedValue(WILDCARD_PERMISSIONS);
    mockRealGuardrailsWithEscalatedTier1Tools();

    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'manage_processes', arguments: { action: 'kill', pid: 7 } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error?.message).toContain('not in MCP_EXECUTE_TOOL_ALLOWLIST');
  });

  it('C2: escalated tier-3 action in the allowlist but key lacks ai:execute_admin is denied', async () => {
    delete process.env.IS_HOSTED;
    process.env.NODE_ENV = 'production';
    delete process.env.MCP_REQUIRE_EXECUTE_ADMIN;
    mockKeyWithScopes(['ai:read', 'ai:execute']); // no ai:execute_admin
    mockRealGuardrailsWithEscalatedTier1Tools();

    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'registry_operations', arguments: { action: 'delete_key', key: 'HKLM\\foo' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error?.message).toContain('requires ai:execute_admin');
  });

  // -------------------------------------------------------------------------
  // Fail-closed: a malformed (non-finite) guardrail tier must DENY, not drop
  // to the permissive base tier. checkGuardrails is stubbed to return a tier
  // of undefined so the route's Number.isFinite guard fires.
  // -------------------------------------------------------------------------
  it('fail-closed: a non-finite guardrail tier is DENIED, executeTool not called', async () => {
    delete process.env.IS_HOSTED;
    process.env.NODE_ENV = 'development';
    mockKeyWithScopes(['ai:read', 'ai:execute', 'ai:execute_admin']);
    // SR2-15 (Task 3, scope re-clamp): same override as the C2 allowlist test
    // above — this key's ai:execute_admin scope needs the wildcard ADMIN_ALL
    // grant to pass the coarse re-clamp; the concern under test here is the
    // non-finite-tier fail-closed guard, not scope delegation.
    routeMocks.getUserPermissions.mockResolvedValue(WILDCARD_PERMISSIONS);

    const executeTool = routeMocks.executeTool;
    executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
    routeMocks.getToolDefinitions.mockReturnValue([{ name: 'manage_tags', description: '', input_schema: {} }]);
    routeMocks.getToolTier.mockImplementation((name: string) => (name === 'manage_tags' ? 1 : undefined));
    routeMocks.checkGuardrails.mockReturnValue({ allowed: true, tier: undefined });
    testState.redis = { get: vi.fn(async () => null) };

    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'manage_tags', arguments: { action: 'list' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toContain('Unable to evaluate tool guardrails');
    expect(executeTool).not.toHaveBeenCalled();
    // No manual restore needed: the top-level beforeEach resets
    // routeMocks.getUserPermissions back to DEFAULT_PERMISSIONS_BASELINE
    // before every test, so this override never leaks forward.
  });

  // -------------------------------------------------------------------------
  // Task 7 — wire-level integration test for MCP instructions + prompts.
  //
  // Earlier tasks added an `instructions` field on the `initialize` result, a
  // `prompts` capability, and `prompts/list` + `prompts/get` handlers backed
  // by the pure functions in `../services/mcpGuidance` (unit-tested there).
  // Nothing previously exercised these over the real JSON-RPC transport
  // (HTTP → apiKeyAuthMiddleware → handleJsonRpc dispatch → handler →
  // response). These tests close that gap using the same /message harness
  // (mockKeyWithScopes + the shared static route) as the rest of this block.
  // -------------------------------------------------------------------------
  describe('MCP instructions + prompts over the wire', () => {
    it('initialize returns non-trivial instructions, the prompts capability, and the protocol version', async () => {
      delete process.env.IS_HOSTED;
      mockKeyWithScopes(['ai:read']);

      const res = await mcpServerRoutes.request('/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(typeof body.result.instructions).toBe('string');
      expect(body.result.instructions.length).toBeGreaterThan(100);
      expect(body.result.capabilities.prompts).toEqual({ listChanged: false });
      expect(body.result.protocolVersion).toBe('2024-11-05');
    });

    it('prompts/list surfaces all 5 guided workflow prompts', async () => {
      delete process.env.IS_HOSTED;
      mockKeyWithScopes(['ai:read']);

      const res = await mcpServerRoutes.request('/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'prompts/list' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result.prompts).toHaveLength(5);
      const names = body.result.prompts.map((p: any) => p.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'breeze-fleet-triage',
          'breeze-device-investigate',
          'breeze-patch-remediate',
          'breeze-incident-kickoff',
          'breeze-turnkey-setup',
        ]),
      );
    });

    it('prompts/get renders breeze-device-investigate with the supplied device argument', async () => {
      delete process.env.IS_HOSTED;
      mockKeyWithScopes(['ai:read']);

      const res = await mcpServerRoutes.request('/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/get',
          params: { name: 'breeze-device-investigate', arguments: { device: 'HOST-7' } },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result.messages[0].content.text).toContain('HOST-7');
    });

    it('prompts/get with an unknown prompt name returns a JSON-RPC invalid-params error', async () => {
      delete process.env.IS_HOSTED;
      mockKeyWithScopes(['ai:read']);

      const res = await mcpServerRoutes.request('/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'prompts/get',
          params: { name: 'does-not-exist' },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error?.code).toBe(-32602);
    });
  });
});
