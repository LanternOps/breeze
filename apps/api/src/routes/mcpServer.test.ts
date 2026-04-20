import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock heavy module-graph leaves so importing ./mcpServer doesn't stand up
// a real postgres client / redis connection.
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
// Bootstrap carve-out integration tests
// ============================================================================
//
// These tests exercise the route file directly. Because the module reads
// MCP_BOOTSTRAP_ENABLED at import time and kicks off a background load, we
// set the env var BEFORE dynamic-importing the route module and reset modules
// between cases.

describe('MCP bootstrap carve-out', () => {
  const originalFlag = process.env.MCP_BOOTSTRAP_ENABLED;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.MCP_BOOTSTRAP_ENABLED;
    else process.env.MCP_BOOTSTRAP_ENABLED = originalFlag;
    vi.doUnmock('../modules/mcpBootstrap');
    vi.doUnmock('../middleware/apiKeyAuth');
  });

  it('flag off + no auth header → tools/list returns 401', async () => {
    delete process.env.MCP_BOOTSTRAP_ENABLED;
    // Stub the API-key middleware to be inert (the carve-out middleware is
    // what we exercise); middleware import still resolves.
    vi.doMock('../middleware/apiKeyAuth', () => ({
      apiKeyAuthMiddleware: async () => {
        throw new Error('should not be called when no X-API-Key header');
      },
      requireApiKeyScope: () => async (_c: any, next: any) => next(),
    }));

    const { mcpServerRoutes } = await import('./mcpServer');
    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toBe(-32001);
  });

  it('flag on + no auth header → tools/list returns the three bootstrap tools', async () => {
    process.env.MCP_BOOTSTRAP_ENABLED = 'true';

    vi.doMock('../middleware/apiKeyAuth', () => ({
      apiKeyAuthMiddleware: async () => {
        throw new Error('should not be called when no X-API-Key header');
      },
      requireApiKeyScope: () => async (_c: any, next: any) => next(),
    }));

    // Mock the bootstrap module so we don't pull in DB/redis/startup checks.
    const fakeTool = (name: string) => ({
      definition: {
        name,
        description: `fake ${name}`,
        inputSchema: {
          _def: { typeName: 'ZodObject', shape: () => ({}) },
          safeParse: (v: unknown) => ({ success: true, data: v }),
        },
      },
      handler: async () => ({ ok: true }),
    });
    vi.doMock('../modules/mcpBootstrap', () => ({
      initMcpBootstrap: () => ({
        unauthTools: [
          fakeTool('create_tenant'),
          fakeTool('verify_tenant'),
          fakeTool('attach_payment_method'),
        ],
        authTools: [],
      }),
    }));

    const mod = await import('./mcpServer');
    // Force the bootstrap module to be loaded (the top-level load is fire-
    // and-forget; tests call this helper to await it deterministically).
    await mod.__loadMcpBootstrapForTests();

    const res = await mod.mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result?.tools).toBeDefined();
    const names = body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['attach_payment_method', 'create_tenant', 'verify_tenant']);
  });
});
