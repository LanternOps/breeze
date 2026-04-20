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

  it('readonly scope backstop — allows tier-1 tool calls with readonly key', async () => {
    delete process.env.MCP_BOOTSTRAP_ENABLED;

    vi.doMock('../middleware/apiKeyAuth', () => ({
      apiKeyAuthMiddleware: async (c: any, next: any) => {
        c.set('apiKey', {
          id: 'key-1',
          orgId: 'org-1',
          name: 'test',
          keyPrefix: 'brz_test',
          scopes: ['ai:read'],
          rateLimit: 1000,
          createdBy: 'user-1',
          scopeState: 'readonly',
        });
        c.set('apiKeyOrgId', 'org-1');
        await next();
      },
      requireApiKeyScope: () => async (_c: any, next: any) => next(),
    }));

    vi.doMock('../services/aiTools', () => ({
      getToolDefinitions: () => [{ name: 'list_devices', description: '', input_schema: {} }],
      executeTool: async () => '{"ok":true}',
      getToolTier: (name: string) => (name === 'list_devices' ? 1 : undefined),
    }));

    // Stub DB select chain used by buildAuthFromApiKey.
    vi.doMock('../db', () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }),
          }),
        }),
      },
      withDbAccessContext: vi.fn(),
      withSystemDbAccessContext: vi.fn(),
      runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    }));

    const { mcpServerRoutes } = await import('./mcpServer');
    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_devices', arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  it('readonly scope backstop — blocks tier-2+ tool, returns 402 PAYMENT_REQUIRED', async () => {
    delete process.env.MCP_BOOTSTRAP_ENABLED;

    vi.doMock('../middleware/apiKeyAuth', () => ({
      apiKeyAuthMiddleware: async (c: any, next: any) => {
        c.set('apiKey', {
          id: 'key-1',
          orgId: 'org-1',
          name: 'test',
          keyPrefix: 'brz_test',
          scopes: ['ai:read', 'ai:write'],
          rateLimit: 1000,
          createdBy: 'user-1',
          scopeState: 'readonly',
        });
        c.set('apiKeyOrgId', 'org-1');
        await next();
      },
      requireApiKeyScope: () => async (_c: any, next: any) => next(),
    }));

    vi.doMock('../services/aiTools', () => ({
      getToolDefinitions: () => [{ name: 'restart_device', description: '', input_schema: {} }],
      executeTool: async () => '{"ok":true}',
      getToolTier: (name: string) => (name === 'restart_device' ? 2 : undefined),
    }));

    vi.doMock('../db', () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }),
          }),
        }),
      },
      withDbAccessContext: vi.fn(),
      withSystemDbAccessContext: vi.fn(),
      runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    }));

    const { mcpServerRoutes } = await import('./mcpServer');
    const res = await mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'restart_device', arguments: {} },
      }),
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error?.message).toBe('PAYMENT_REQUIRED');
    expect(body.error?.data?.code).toBe('PAYMENT_REQUIRED');
    expect(body.error?.data?.remediation?.tool).toBe('attach_payment_method');
    expect(body.error?.data?.remediation?.args?.tenant_id).toBe('partner-1');
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

  it('flag on + authed key → authTools surface in tools/list AND dispatch to handler', async () => {
    process.env.MCP_BOOTSTRAP_ENABLED = 'true';

    vi.doMock('../middleware/apiKeyAuth', () => ({
      apiKeyAuthMiddleware: async (c: any, next: any) => {
        c.set('apiKey', {
          id: 'key-authtool',
          orgId: 'org-1',
          name: 'test',
          keyPrefix: 'brz_test',
          scopes: ['ai:read', 'ai:execute'],
          rateLimit: 1000,
          createdBy: 'user-1',
          scopeState: 'full',
        });
        c.set('apiKeyOrgId', 'org-1');
        await next();
      },
      requireApiKeyScope: () => async (_c: any, next: any) => next(),
    }));

    vi.doMock('../services/aiTools', () => ({
      getToolDefinitions: () => [],
      executeTool: vi.fn(),
      getToolTier: () => undefined,
    }));

    vi.doMock('../db', () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [{ partnerId: 'partner-1', billingEmail: 'admin@acme.com' }] }),
          }),
        }),
      },
      withDbAccessContext: vi.fn(),
      withSystemDbAccessContext: vi.fn(),
      runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    }));

    const handlerMock = vi.fn(async () => ({ invites_sent: 2, invite_ids: ['i1', 'i2'], skipped_duplicates: 0 }));
    const fakeAuthTool = {
      definition: {
        name: 'send_deployment_invites',
        description: 'fake authTool',
        inputSchema: {
          _def: { typeName: 'ZodObject', shape: () => ({}) },
          safeParse: (v: unknown) => ({ success: true, data: v }),
        },
      },
      handler: handlerMock,
    };
    vi.doMock('../modules/mcpBootstrap', () => ({
      initMcpBootstrap: () => ({
        unauthTools: [],
        authTools: [fakeAuthTool],
      }),
    }));

    const mod = await import('./mcpServer');
    await mod.__loadMcpBootstrapForTests();

    // 1) tools/list surfaces send_deployment_invites for an ai:execute key.
    const listRes = await mod.mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const names = listBody.result.tools.map((t: any) => t.name);
    expect(names).toContain('send_deployment_invites');

    // 2) tools/call dispatches to the handler with parsed input + ctx.apiKey.
    const callRes = await mod.mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'send_deployment_invites', arguments: { emails: ['a@b.com'] } },
      }),
    });
    expect(callRes.status).toBe(200);
    const callBody = await callRes.json();
    expect(callBody.error).toBeUndefined();
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const call = handlerMock.mock.calls[0] as unknown as [any, any];
    const [calledInput, calledCtx] = call;
    expect(calledInput).toEqual({ emails: ['a@b.com'] });
    expect(calledCtx.apiKey.id).toBe('key-authtool');
    expect(calledCtx.apiKey.partnerId).toBe('partner-1');
    expect(calledCtx.apiKey.defaultOrgId).toBe('org-1');
    expect(calledCtx.apiKey.partnerAdminEmail).toBe('admin@acme.com');
    expect(calledCtx.apiKey.scopeState).toBe('full');
    const contentText = callBody.result.content[0].text;
    expect(JSON.parse(contentText)).toEqual({
      invites_sent: 2,
      invite_ids: ['i1', 'i2'],
      skipped_duplicates: 0,
    });
  });

  it('unauth bootstrap dispatch runs tool handler inside withSystemDbAccessContext', async () => {
    // Regression test: unauth bootstrap tools (create_tenant, verify_tenant,
    // attach_payment_method) write to RLS-enabled tables (partner_activations,
    // api_keys) with no request-scoped DB context, so the dispatcher must wrap
    // the handler in withSystemDbAccessContext or production will fail with
    // "new row violates row-level security policy" on every create_tenant call.
    process.env.MCP_BOOTSTRAP_ENABLED = 'true';

    vi.doMock('../middleware/apiKeyAuth', () => ({
      apiKeyAuthMiddleware: async () => {
        throw new Error('should not be called when no X-API-Key header');
      },
      requireApiKeyScope: () => async (_c: any, next: any) => next(),
    }));

    // Spy: the system-context wrapper should be invoked with a function that,
    // when called, drives the tool handler.
    const systemCtxSpy = vi.fn(async (fn: () => any) => await fn());
    vi.doMock('../db', () => ({
      db: {},
      withDbAccessContext: vi.fn(),
      withSystemDbAccessContext: systemCtxSpy,
      runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    }));

    const handlerMock = vi.fn(async () => ({ tenant_id: 'p-new', activation_status: 'pending_email' }));
    const fakeTool = {
      definition: {
        name: 'create_tenant',
        description: 'fake',
        inputSchema: {
          _def: { typeName: 'ZodObject', shape: () => ({}) },
          safeParse: (v: unknown) => ({ success: true, data: v }),
        },
      },
      handler: handlerMock,
    };
    vi.doMock('../modules/mcpBootstrap', () => ({
      initMcpBootstrap: () => ({
        unauthTools: [fakeTool],
        authTools: [],
      }),
    }));

    const mod = await import('./mcpServer');
    await mod.__loadMcpBootstrapForTests();

    const res = await mod.mcpServerRoutes.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_tenant',
          arguments: {
            org_name: 'Acme',
            admin_email: 'alex@acme-ops.com',
            admin_name: 'Alex',
            region: 'us',
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(systemCtxSpy).toHaveBeenCalledTimes(1);
    expect(systemCtxSpy).toHaveBeenCalledWith(expect.any(Function));
    expect(handlerMock).toHaveBeenCalledTimes(1);
    // The wrapper must be invoked strictly before the tool handler runs.
    const wrapperInvokedBeforeHandler =
      systemCtxSpy.mock.invocationCallOrder[0]! < handlerMock.mock.invocationCallOrder[0]!;
    expect(wrapperInvokedBeforeHandler).toBe(true);
  });
});
