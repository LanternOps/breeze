import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z as zod } from 'zod';
// Type-only imports — erased at compile time, so importing them here has no
// runtime effect on module resolution/mocking order below. Used to tie the
// classifier regression test to the REAL handler output shapes rather than
// hand-written literals, so a future field rename fails this test instead of
// silently degrading ledger/audit classification to 'success'.
import type { SendDeploymentInvitesOutput } from '../modules/mcpInvites/tools/sendDeploymentInvites';
import type { ConfigureDefaultsOutput } from '../modules/mcpInvites/tools/configureDefaults';
import { BootstrapError } from '../modules/mcpInvites/types';
import {
  __loadMcpBootstrapForTests,
  classifyBootstrapToolResult,
  mcpServerRoutes,
} from './mcpServer';

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

const testState = vi.hoisted(() => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    EXEC_ADMIN: process.env.MCP_REQUIRE_EXECUTE_ADMIN,
    ALLOWLIST: process.env.MCP_EXECUTE_TOOL_ALLOWLIST,
  };

  // mcpServer parses the execute-tool allowlist once at module import time.
  process.env.NODE_ENV = 'production';
  process.env.MCP_REQUIRE_EXECUTE_ADMIN = 'false';
  process.env.MCP_EXECUTE_TOOL_ALLOWLIST = '*';

  return {
    originalEnv,
    scopes: ['ai:read', 'ai:execute'] as string[],
    permissions: [{ resource: '*', action: '*' }] as Array<{ resource: string; action: string }>,
    roleId: 'role-1' as string | null,
    billingEmail: 'admin@acme.com',
  };
});

const mocks = vi.hoisted(() => ({
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  writeAuditEvent: vi.fn(),
  sendHandler: vi.fn() as any,
  configureHandler: vi.fn() as any,
  // SR2-15: getUserPermissions is called TWICE per bootstrap request (see the
  // FULL_AI_READ_EXECUTE_BASELINE comment below) — a plain testState-backed
  // return can't express "first call differs from every later call", so this
  // is a real vi.fn() whose per-call behavior callBootstrap programs fresh
  // for each request via mockResolvedValueOnce + mockResolvedValue.
  getUserPermissions: vi.fn(),
}));

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerBegin(...args),
  completeMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerComplete(...args),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: (...args: any[]) => mocks.writeAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(() => ({})),
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ billingEmail: testState.billingEmail }] }),
      }),
    }),
  },
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
  alerts: {},
  scripts: {},
  automations: {},
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partners: { id: 'partners.id', billingEmail: 'partners.billingEmail' },
}));

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (c: any, next: any) => {
    c.set('apiKey', {
      id: 'key-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      name: 'test',
      keyPrefix: 'brz_test',
      scopes: testState.scopes,
      rateLimit: 1000,
      createdBy: 'user-1',
    });
    c.set('apiKeyOrgId', 'org-1');
    await next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: (...args: any[]) => mocks.getUserPermissions(...args),
  };
});

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
        handler: (...args: any[]) => mocks.sendHandler(...(args as [any, any])),
      },
      {
        definition: {
          name: 'configure_defaults',
          description: 'fake',
          inputSchema: zod.object({}).passthrough(),
        },
        handler: (...args: any[]) => mocks.configureHandler(...(args as [any, any])),
      },
    ],
  }),
}));

function restoreEnv() {
  for (const [k, v] of [
    ['NODE_ENV', testState.originalEnv.NODE_ENV],
    ['MCP_REQUIRE_EXECUTE_ADMIN', testState.originalEnv.EXEC_ADMIN],
    ['MCP_EXECUTE_TOOL_ALLOWLIST', testState.originalEnv.ALLOWLIST],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  testState.scopes = ['ai:read', 'ai:execute'];
  testState.permissions = [{ resource: '*', action: '*' }];
  testState.roleId = 'role-1';
  testState.billingEmail = 'admin@acme.com';
  mocks.ledgerBegin.mockReset().mockResolvedValue({
    executionId: 'exec-1',
    sessionId: 'sess-1',
    orgId: 'org-1',
  });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.writeAuditEvent.mockReset();
  mocks.sendHandler = vi.fn(async () => ({ invites_sent: 1, invite_ids: ['i1'], skipped_duplicates: 0 }));
  mocks.configureHandler = vi.fn(async () => ({
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
});

// SR2-15 (Task 3, scope re-clamp): buildAuthFromApiKey's org branch now calls
// getUserPermissions ONCE via authorizeHumanApiKeyCreator to re-validate the
// key's coarse scopes (callBootstrap always drives ['ai:read', 'ai:execute'],
// which bundles devices/alerts/scripts/automations read + devices/scripts
// execute as a single all-or-nothing unit) BEFORE the REAL aiGuardrails
// checkToolPermission runs its OWN, separate getUserPermissions call to
// enforce the bootstrap tool's actual RBAC requirement (MCP-OAUTH-11 — the
// concern this suite tests). So: the FIRST call (the coarse ceiling) gets a
// full baseline that always satisfies 'ai:read' + 'ai:execute', and every
// SUBSEQUENT call (the real per-tool RBAC gate) returns the scenario's actual
// `permissions`, preserving every test's premise (including the "missing
// devices.write" denial cases) without loosening any assertion.
//
// The hoisted, module-level `services/permissions` mock above just forwards
// to `mocks.getUserPermissions` — callBootstrap (below) reprograms that vi.fn
// fresh on every call via mockResolvedValueOnce + mockResolvedValue, since a
// single testState-backed return value can't express "first call differs
// from every later call".
const FULL_AI_READ_EXECUTE_BASELINE = [
  { resource: 'devices', action: 'read' },
  { resource: 'alerts', action: 'read' },
  { resource: 'scripts', action: 'read' },
  { resource: 'automations', action: 'read' },
  { resource: 'devices', action: 'execute' },
  { resource: 'scripts', action: 'execute' },
];

function buildPermsResult(permissions: Array<{ resource: string; action: string }>) {
  return testState.roleId === null
    ? null
    : {
        permissions,
        partnerId: 'partner-1',
        orgId: 'org-1',
        roleId: testState.roleId,
        scope: 'organization' as const,
      };
}

async function callBootstrap(
  toolName: string,
  opts: {
    scopes?: string[];
    perms?: Array<{ resource: string; action: string }>;
    args?: Record<string, unknown>;
  } = {},
) {
  testState.scopes = opts.scopes ?? ['ai:read', 'ai:execute'];
  testState.permissions = opts.perms ?? [{ resource: '*', action: '*' }];
  mocks.getUserPermissions.mockReset();
  if (testState.roleId !== null) {
    mocks.getUserPermissions.mockResolvedValueOnce(buildPermsResult(FULL_AI_READ_EXECUTE_BASELINE));
  }
  mocks.getUserPermissions.mockResolvedValue(buildPermsResult(testState.permissions));
  await __loadMcpBootstrapForTests();
  const res = await mcpServerRoutes.request('/message', {
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
    expect(mocks.ledgerBegin).not.toHaveBeenCalled();
    expect(mocks.sendHandler).not.toHaveBeenCalled();
  });

  it('send_deployment_invites: role WITH devices.write succeeds', async () => {
    const body = await callBootstrap('send_deployment_invites', {
      perms: [{ resource: 'devices', action: 'write' }],
      args: { emails: ['a@b.com'] },
    });
    expect(body.error).toBeUndefined();
    expect(mocks.sendHandler).toHaveBeenCalledTimes(1);
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
    expect(mocks.ledgerBegin).not.toHaveBeenCalled();
    expect(mocks.configureHandler).not.toHaveBeenCalled();
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
    expect(mocks.configureHandler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// MCP-OAUTH-12 — shared Tier 3 ledger/audit lifecycle for bootstrap tools
// ---------------------------------------------------------------------------

describe('bootstrap Tier 3 ledger/audit lifecycle (MCP-OAUTH-12)', () => {
  const ALL: Array<{ resource: string; action: string }> = [{ resource: '*', action: '*' }];

  it('send_deployment_invites: ledger row is created BEFORE the handler runs', async () => {
    let ledgerCallsAtHandlerTime = -1;
    mocks.sendHandler = vi.fn(async () => {
      ledgerCallsAtHandlerTime = mocks.ledgerBegin.mock.calls.length;
      return { invites_sent: 1, invite_ids: ['i1'], skipped_duplicates: 0 };
    });
    await callBootstrap('send_deployment_invites', { perms: ALL, args: { emails: ['a@b.com'] } });
    expect(mocks.ledgerBegin).toHaveBeenCalledTimes(1);
    expect(ledgerCallsAtHandlerTime).toBe(1);
    const arg = (mocks.ledgerBegin.mock.calls[0] as any[])[0];
    expect(arg.toolName).toBe('send_deployment_invites');
    expect(arg.tier).toBe(3);
    expect(arg.orgId).toBe('org-1');
  });

  it('configure_defaults: ledger row is created BEFORE the handler runs', async () => {
    let ledgerCallsAtHandlerTime = -1;
    mocks.configureHandler = vi.fn(async () => {
      ledgerCallsAtHandlerTime = mocks.ledgerBegin.mock.calls.length;
      return { applied: {} };
    });
    await callBootstrap('configure_defaults', { perms: ALL });
    expect(mocks.ledgerBegin).toHaveBeenCalledTimes(1);
    expect(ledgerCallsAtHandlerTime).toBe(1);
    const arg = (mocks.ledgerBegin.mock.calls[0] as any[])[0];
    expect(arg.toolName).toBe('configure_defaults');
    expect(arg.tier).toBe(3);
  });

  it('ledger-creation failure prevents the handler from running (fail closed)', async () => {
    mocks.ledgerBegin.mockRejectedValueOnce(new Error('ledger insert boom'));
    const body = await callBootstrap('send_deployment_invites', { perms: ALL, args: { emails: ['a@b.com'] } });
    expect(body.error?.code).toBe(-32000);
    expect(mocks.sendHandler).not.toHaveBeenCalled();
    expect(mocks.ledgerComplete).not.toHaveBeenCalled();
  });

  it('success completes the ledger (success) and writes a uniform mcp.tool.<name> audit', async () => {
    await callBootstrap('send_deployment_invites', { perms: ALL, args: { emails: ['a@b.com'] } });
    expect(mocks.ledgerComplete).toHaveBeenCalledTimes(1);
    expect((mocks.ledgerComplete.mock.calls[0] as any[])[0].status).toBe('success');
    const toolAudit = mocks.writeAuditEvent.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p?.resourceType === 'mcp_tool_execution');
    expect(toolAudit).toBeDefined();
    expect(toolAudit.action).toBe('mcp.tool.send_deployment_invites');
    expect(toolAudit.result).toBe('success');
  });

  it('thrown BootstrapError completes the ledger (failure) and writes a failure audit', async () => {
    mocks.sendHandler = vi.fn(async () => {
      throw new BootstrapError('RATE_LIMITED', 'too many');
    });
    const body = await callBootstrap('send_deployment_invites', { perms: ALL, args: { emails: ['a@b.com'] } });
    expect(body.error?.code).toBe(-32000);
    expect(mocks.ledgerComplete).toHaveBeenCalledTimes(1);
    expect((mocks.ledgerComplete.mock.calls[0] as any[])[0].status).toBe('failure');
    const toolAudit = mocks.writeAuditEvent.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p?.resourceType === 'mcp_tool_execution');
    expect(toolAudit?.result).toBe('failure');
  });

  it('send_deployment_invites PARTIAL failure (per-invite failures) classifies the ledger as failure', async () => {
    mocks.sendHandler = vi.fn(async () => ({
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
    expect(mocks.ledgerComplete).toHaveBeenCalledTimes(1);
    expect((mocks.ledgerComplete.mock.calls[0] as any[])[0].status).toBe('failure');
    const toolAudit = mocks.writeAuditEvent.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p?.resourceType === 'mcp_tool_execution');
    expect(toolAudit?.result).toBe('failure');
  });

  it('configure_defaults PARTIAL failure (step errors) classifies the ledger as failure', async () => {
    mocks.configureHandler = vi.fn(async () => ({
      applied: {},
      errors: [{ step: 'alert_policy', error: 'boom' }],
    }));
    await callBootstrap('configure_defaults', { perms: ALL });
    expect(mocks.ledgerComplete).toHaveBeenCalledTimes(1);
    expect((mocks.ledgerComplete.mock.calls[0] as any[])[0].status).toBe('failure');
  });

  it('classifyBootstrapToolResult treats REAL-shaped handler output as failure (regression against field-name drift)', async () => {
    // The tests above hand-write `{failures:[...]}` / `{errors:[...]}` object
    // literals. That passes even if a future rename of the real handler
    // fields (`SendDeploymentInvitesOutput.failures`,
    // `ConfigureDefaultsOutput.errors`) silently breaks classification —
    // the literal wouldn't be renamed along with it. Anchor the classifier
    // to the ACTUAL exported types via `satisfies`: if either field is ever
    // renamed, this fails to typecheck (caught at build/CI time) rather than
    // silently degrading every partial-failure result to 'success'.
    const sendResult = {
      invites_sent: 1,
      invite_ids: ['i1'],
      skipped_duplicates: 0,
      failures: [{ email: 'bad@x.com', error: 'smtp down' }],
    } satisfies SendDeploymentInvitesOutput;

    const configureResult = {
      applied: {
        device_group: { created: true },
        alert_policy: { created: true },
        risk_profile: { created: true },
        notification_channel: { created: true },
      },
      errors: [{ step: 'alert_policy', error: 'boom' }],
    } satisfies ConfigureDefaultsOutput;

    expect(classifyBootstrapToolResult(sendResult)).toBe('failure');
    expect(classifyBootstrapToolResult(configureResult)).toBe('failure');
  });

  it('handler-specific business audits still fire alongside the uniform audit', async () => {
    // Model configureDefaults writing its own bootstrap.configure_defaults audit.
    mocks.configureHandler = vi.fn(async (_input: any, _ctx: any) => {
      mocks.writeAuditEvent({} as any, {
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
    const actions = mocks.writeAuditEvent.mock.calls.map((c: any[]) => c[1]?.action);
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
    expect(mocks.ledgerBegin).not.toHaveBeenCalled();
    expect(mocks.ledgerComplete).not.toHaveBeenCalled();
    expect(mocks.sendHandler).not.toHaveBeenCalled();
  });
});
