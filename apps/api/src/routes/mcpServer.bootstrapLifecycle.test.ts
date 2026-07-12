import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z as zod } from 'zod';

// ---------------------------------------------------------------------------
// Task 7 — MCP-OAUTH-11 (bootstrap RBAC) + MCP-OAUTH-12 (shared Tier 3
// ledger/audit lifecycle for bootstrap tools).
//
// These tests exercise the REAL aiGuardrails service (so the real
// TOOL_PERMISSIONS map + checkToolPermission gate the bootstrap tools by name)
// and REAL checkGuardrails, with the heavy module-graph leaves stubbed. The
// bootstrap tools are replaced by fakes named exactly send_deployment_invites /
// configure_defaults so the real permission mapping applies without dragging in
// the handlers' DB logic.
// ---------------------------------------------------------------------------

const ledgerBegin = vi.fn(async (..._args: any[]) => ({
  executionId: 'exec-1',
  sessionId: 'sess-1',
  orgId: 'org-1',
}));
const ledgerComplete = vi.fn(async (..._args: any[]) => undefined);

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...args: any[]) => ledgerBegin(...args),
  completeMcpToolExecutionLedger: (...args: any[]) => ledgerComplete(...args),
}));

const writeAuditEvent = vi.fn();
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: (...args: any[]) => writeAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(() => ({})),
}));

// Truthy stub: production preflight requires a non-null Redis for the message
// rate-limit gate; rateLimiter itself is mocked below to always allow.
vi.mock('../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));
vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => {
    throw new Error('should not be called without a Bearer header');
  },
  resolvePartnerAccessibleOrgIds: async () => ['org-1'],
}));

// Bootstrap dispatch never calls the execution-org resolver, but the module
// imports these symbols — provide both so the import resolves.
vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: () => [],
  executeTool: vi.fn(),
  getToolTier: () => undefined,
}));

// Fake bootstrap authTools, per-test configurable handlers. Referenced lazily
// inside the mock factory so beforeEach can reset them.
// Typed `any` so per-test reassignments with differing result shapes (partial
// failures, throws) don't fight the inferred signature of the initial value.
let sendHandler: any = vi.fn(async () => ({ invites_sent: 1, invite_ids: ['i1'], skipped_duplicates: 0 }));
let configureHandler: any = vi.fn(async () => ({
  applied: {
    device_group: { created: true },
    alert_policy: { created: true },
    risk_profile: { created: true },
    notification_channel: { created: true },
  },
}));

vi.mock('../modules/mcpInvites', () => ({
  initMcpBootstrap: () => ({
    unauthTools: [],
    authTools: [
      {
        definition: {
          name: 'send_deployment_invites',
          description: 'fake',
          inputSchema: zod.object({}).passthrough(),
        },
        handler: (...args: any[]) => sendHandler(...(args as [any, any])),
      },
      {
        definition: {
          name: 'configure_defaults',
          description: 'fake',
          inputSchema: zod.object({}).passthrough(),
        },
        handler: (...args: any[]) => configureHandler(...(args as [any, any])),
      },
    ],
  }),
}));

const ORIG = {
  NODE_ENV: process.env.NODE_ENV,
  EXEC_ADMIN: process.env.MCP_REQUIRE_EXECUTE_ADMIN,
  ALLOWLIST: process.env.MCP_EXECUTE_TOOL_ALLOWLIST,
};

function restoreEnv() {
  for (const [k, v] of [
    ['NODE_ENV', ORIG.NODE_ENV],
    ['MCP_REQUIRE_EXECUTE_ADMIN', ORIG.EXEC_ADMIN],
    ['MCP_EXECUTE_TOOL_ALLOWLIST', ORIG.ALLOWLIST],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  vi.resetModules();
  ledgerBegin.mockClear();
  ledgerComplete.mockClear();
  writeAuditEvent.mockClear();
  sendHandler = vi.fn(async () => ({ invites_sent: 1, invite_ids: ['i1'], skipped_duplicates: 0 }));
  configureHandler = vi.fn(async () => ({
    applied: {
      device_group: { created: true },
      alert_policy: { created: true },
      risk_profile: { created: true },
      notification_channel: { created: true },
    },
  }));
  // Reproduce the MCP-OAUTH-11 scenario: production, execute-admin OFF, tool
  // allowlisted — so ONLY the new product RBAC can stop a low-privilege member.
  process.env.NODE_ENV = 'production';
  process.env.MCP_REQUIRE_EXECUTE_ADMIN = 'false';
  process.env.MCP_EXECUTE_TOOL_ALLOWLIST = '*';
});

afterEach(() => {
  restoreEnv();
  vi.doUnmock('../services/permissions');
  vi.doUnmock('../middleware/apiKeyAuth');
  vi.doUnmock('../db');
});

function mockDb() {
  // Bootstrap dispatch queries partners.billingEmail; ledger is mocked so no
  // insert path is exercised here.
  vi.doMock('../db', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ billingEmail: 'admin@acme.com' }] }),
        }),
      }),
    },
    withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
    withSystemDbAccessContext: vi.fn((fn: any) => fn()),
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  }));
}

function mockApiKey(scopes: string[]) {
  vi.doMock('../middleware/apiKeyAuth', () => ({
    apiKeyAuthMiddleware: async (c: any, next: any) => {
      c.set('apiKey', {
        id: 'key-1',
        orgId: 'org-1',
        partnerId: 'partner-1',
        name: 'test',
        keyPrefix: 'brz_test',
        scopes,
        rateLimit: 1000,
        createdBy: 'user-1',
      });
      c.set('apiKeyOrgId', 'org-1');
      await next();
    },
    requireApiKeyScope: () => async (_c: any, next: any) => next(),
  }));
}

function mockPerms(permissions: Array<{ resource: string; action: string }>, roleId: string | null = 'role-1') {
  vi.doMock('../services/permissions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/permissions')>();
    return {
      ...actual,
      getUserPermissions: vi.fn(async () =>
        roleId === null
          ? null
          : {
              permissions,
              partnerId: 'partner-1',
              orgId: 'org-1',
              roleId,
              scope: 'organization' as const,
            },
      ),
    };
  });
}

async function callBootstrap(
  toolName: string,
  opts: {
    scopes?: string[];
    perms?: Array<{ resource: string; action: string }>;
    args?: Record<string, unknown>;
  } = {},
) {
  const scopes = opts.scopes ?? ['ai:read', 'ai:execute'];
  mockApiKey(scopes);
  mockPerms(opts.perms ?? [{ resource: '*', action: '*' }]);
  mockDb();
  const mod = await import('./mcpServer');
  await mod.__loadMcpBootstrapForTests();
  const res = await mod.mcpServerRoutes.request('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: opts.args ?? {} },
    }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// MCP-OAUTH-11 — bootstrap RBAC
// ---------------------------------------------------------------------------

describe('bootstrap tool RBAC (MCP-OAUTH-11)', () => {
  it('send_deployment_invites: low-priv member (no devices.write) is DENIED even with execute-admin OFF + tool allowlisted', async () => {
    const body = await callBootstrap('send_deployment_invites', {
      perms: [{ resource: 'devices', action: 'read' }],
    });
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain('devices.write');
    // Reject precedes ledger: no ledger row, handler never ran.
    expect(ledgerBegin).not.toHaveBeenCalled();
    expect(sendHandler).not.toHaveBeenCalled();
  });

  it('send_deployment_invites: role WITH devices.write succeeds', async () => {
    const body = await callBootstrap('send_deployment_invites', {
      perms: [{ resource: 'devices', action: 'write' }],
      args: { emails: ['a@b.com'] },
    });
    expect(body.error).toBeUndefined();
    expect(sendHandler).toHaveBeenCalledTimes(1);
  });

  it('configure_defaults: role with organizations.write but MISSING devices.write extra is DENIED', async () => {
    const body = await callBootstrap('configure_defaults', {
      perms: [
        { resource: 'organizations', action: 'write' },
        { resource: 'alerts', action: 'write' },
      ],
    });
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain('devices.write');
    expect(ledgerBegin).not.toHaveBeenCalled();
    expect(configureHandler).not.toHaveBeenCalled();
  });

  it('configure_defaults: role with organizations.write + devices.write + alerts.write succeeds', async () => {
    const body = await callBootstrap('configure_defaults', {
      perms: [
        { resource: 'organizations', action: 'write' },
        { resource: 'devices', action: 'write' },
        { resource: 'alerts', action: 'write' },
      ],
    });
    expect(body.error).toBeUndefined();
    expect(configureHandler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// MCP-OAUTH-12 — shared Tier 3 ledger/audit lifecycle for bootstrap tools
// ---------------------------------------------------------------------------

describe('bootstrap Tier 3 ledger/audit lifecycle (MCP-OAUTH-12)', () => {
  const ALL: Array<{ resource: string; action: string }> = [{ resource: '*', action: '*' }];

  it('send_deployment_invites: ledger row is created BEFORE the handler runs', async () => {
    let ledgerCallsAtHandlerTime = -1;
    sendHandler = vi.fn(async () => {
      ledgerCallsAtHandlerTime = ledgerBegin.mock.calls.length;
      return { invites_sent: 1, invite_ids: ['i1'], skipped_duplicates: 0 };
    });
    await callBootstrap('send_deployment_invites', { perms: ALL, args: { emails: ['a@b.com'] } });
    expect(ledgerBegin).toHaveBeenCalledTimes(1);
    expect(ledgerCallsAtHandlerTime).toBe(1);
    const arg = (ledgerBegin.mock.calls[0] as any[])[0];
    expect(arg.toolName).toBe('send_deployment_invites');
    expect(arg.tier).toBe(3);
    expect(arg.orgId).toBe('org-1');
  });

  it('configure_defaults: ledger row is created BEFORE the handler runs', async () => {
    let ledgerCallsAtHandlerTime = -1;
    configureHandler = vi.fn(async () => {
      ledgerCallsAtHandlerTime = ledgerBegin.mock.calls.length;
      return { applied: {} };
    });
    await callBootstrap('configure_defaults', { perms: ALL });
    expect(ledgerBegin).toHaveBeenCalledTimes(1);
    expect(ledgerCallsAtHandlerTime).toBe(1);
    const arg = (ledgerBegin.mock.calls[0] as any[])[0];
    expect(arg.toolName).toBe('configure_defaults');
    expect(arg.tier).toBe(3);
  });

  it('ledger-creation failure prevents the handler from running (fail closed)', async () => {
    ledgerBegin.mockRejectedValueOnce(new Error('ledger insert boom'));
    const body = await callBootstrap('send_deployment_invites', { perms: ALL, args: { emails: ['a@b.com'] } });
    expect(body.error?.code).toBe(-32000);
    expect(sendHandler).not.toHaveBeenCalled();
    expect(ledgerComplete).not.toHaveBeenCalled();
  });

  it('success completes the ledger (success) and writes a uniform mcp.tool.<name> audit', async () => {
    await callBootstrap('send_deployment_invites', { perms: ALL, args: { emails: ['a@b.com'] } });
    expect(ledgerComplete).toHaveBeenCalledTimes(1);
    expect((ledgerComplete.mock.calls[0] as any[])[0].status).toBe('success');
    const toolAudit = writeAuditEvent.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p?.resourceType === 'mcp_tool_execution');
    expect(toolAudit).toBeDefined();
    expect(toolAudit.action).toBe('mcp.tool.send_deployment_invites');
    expect(toolAudit.result).toBe('success');
  });

  it('thrown BootstrapError completes the ledger (failure) and writes a failure audit', async () => {
    sendHandler = vi.fn(async () => {
      // Import the SAME (freshly reset) module instance the route uses, so the
      // route's `err instanceof BootstrapError` check matches.
      const { BootstrapError } = await import('../modules/mcpInvites/types');
      throw new BootstrapError('RATE_LIMITED', 'too many');
    });
    const body = await callBootstrap('send_deployment_invites', { perms: ALL, args: { emails: ['a@b.com'] } });
    expect(body.error?.code).toBe(-32000);
    expect(ledgerComplete).toHaveBeenCalledTimes(1);
    expect((ledgerComplete.mock.calls[0] as any[])[0].status).toBe('failure');
    const toolAudit = writeAuditEvent.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p?.resourceType === 'mcp_tool_execution');
    expect(toolAudit?.result).toBe('failure');
  });

  it('send_deployment_invites PARTIAL failure (per-invite failures) classifies the ledger as failure', async () => {
    sendHandler = vi.fn(async () => ({
      invites_sent: 1,
      invite_ids: ['i1'],
      skipped_duplicates: 0,
      failures: [{ email: 'bad@x.com', error: 'smtp down' }],
    }));
    const body = await callBootstrap('send_deployment_invites', {
      perms: ALL,
      args: { emails: ['a@b.com', 'bad@x.com'] },
    });
    // Handler result is still returned to the caller (not an RPC error).
    expect(body.error).toBeUndefined();
    expect(ledgerComplete).toHaveBeenCalledTimes(1);
    expect((ledgerComplete.mock.calls[0] as any[])[0].status).toBe('failure');
    const toolAudit = writeAuditEvent.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p?.resourceType === 'mcp_tool_execution');
    expect(toolAudit?.result).toBe('failure');
  });

  it('configure_defaults PARTIAL failure (step errors) classifies the ledger as failure', async () => {
    configureHandler = vi.fn(async () => ({
      applied: {},
      errors: [{ step: 'alert_policy', error: 'boom' }],
    }));
    await callBootstrap('configure_defaults', { perms: ALL });
    expect(ledgerComplete).toHaveBeenCalledTimes(1);
    expect((ledgerComplete.mock.calls[0] as any[])[0].status).toBe('failure');
  });

  it('handler-specific business audits still fire alongside the uniform audit', async () => {
    // Model configureDefaults writing its own bootstrap.configure_defaults audit.
    configureHandler = vi.fn(async (_input: any, _ctx: any) => {
      writeAuditEvent({} as any, {
        orgId: 'org-1',
        actorType: 'api_key',
        actorId: 'key-1',
        action: 'bootstrap.configure_defaults',
        resourceType: 'partner',
        resourceId: 'partner-1',
        result: 'success',
      });
      return { applied: {} };
    });
    await callBootstrap('configure_defaults', { perms: ALL });
    const actions = writeAuditEvent.mock.calls.map((c: any[]) => c[1]?.action);
    expect(actions).toContain('bootstrap.configure_defaults'); // business audit intact
    expect(actions).toContain('mcp.tool.configure_defaults'); // uniform audit added
  });
});

// ---------------------------------------------------------------------------
// Folded Task-6 review item: reject precedes ledger (pin the ordering)
// ---------------------------------------------------------------------------

describe('reject precedes ledger (ordering pin)', () => {
  it('an RBAC denial creates NO ledger row and never invokes the handler', async () => {
    const body = await callBootstrap('send_deployment_invites', {
      perms: [{ resource: 'devices', action: 'read' }],
    });
    expect(body.error).toBeDefined();
    expect(ledgerBegin).not.toHaveBeenCalled();
    expect(ledgerComplete).not.toHaveBeenCalled();
    expect(sendHandler).not.toHaveBeenCalled();
  });
});
