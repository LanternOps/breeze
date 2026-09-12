import { describe, expect, it, vi, beforeEach } from 'vitest';

// #5362 — `get_fleet_status` was renamed to `get_invite_funnel` (the tool it
// always was; the old name got picked for "show fleet status" prompts and
// answered from funnel zeros on a real fleet). `services/aiToolAliases.ts`
// keeps `get_fleet_status` alive as a DISPATCH-ONLY deprecated alias so
// clients that cached the old name over MCP keep working for one release.
// `handleToolsCall` (routes/mcpServer.ts) resolves the alias to the canonical
// name ONCE, at the very top, before any name-keyed gate (tier lookup,
// guardrails, approval gate, RBAC, dispatch) — so an aliased call is
// authorized and executed exactly like the canonical name, and the audit
// trail records both the canonical name AND the fact that the deprecated
// name was the one actually requested (so "is anyone still calling the old
// name?" is a query, not a grep of ephemeral console output).
//
// This suite proves: (1) the alias dispatches as the canonical tool, (2) the
// audit event for an aliased call carries requestedToolName +
// deprecatedToolAlias, (3) an ordinary non-aliased call carries neither field,
// and (4) an unrelated unknown tool name still produces "Unknown tool" —
// alias resolution passes unknown names through untouched.

// ---------------------------------------------------------------------------
// Mocking harness — trimmed from mcpServer.effectiveTier.test.ts to only what
// a tools/call dispatch needs (no resources/read site-axis machinery).
// ---------------------------------------------------------------------------

const testState = vi.hoisted(() => ({
  scopes: ['ai:read'] as string[],
}));

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  getToolDefinitions: vi.fn(),
  getToolTier: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock('../services/mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerBegin(...args),
  completeMcpToolExecutionLedger: (...args: any[]) => mocks.ledgerComplete(...args),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: (...args: any[]) => mocks.writeAuditEvent(...args),
  requestLikeFromSnapshot: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(() => { throw new Error('Unexpected db.select call'); }) },
  withDbAccessContext: vi.fn((_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn((fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
}));

// mcpServer.ts imports these table objects at module scope even though this
// suite never touches the DB — give Drizzle real (if unused) table shapes.
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

vi.mock('../services/aiTools', () => ({
  getToolDefinitions: (...args: any[]) => mocks.getToolDefinitions(...args),
  executeTool: (...args: any[]) => mocks.executeTool(...args),
  getToolTier: (...args: any[]) => mocks.getToolTier(...args),
}));

vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));
vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => {
    throw new Error('should not be called without a Bearer header');
  },
  resolvePartnerAccessibleOrgIds: async () => [],
}));

vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => null),
  assertActiveTenantContext: vi.fn(),
  TenantInactiveError: class TenantInactiveError extends Error {},
}));

vi.mock('../services/recoveryBootstrap', () => ({
  resolveServerUrl: (requestUrl?: string) => requestUrl ? new URL(requestUrl).origin : 'http://localhost:3001',
}));

vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));

// Keep the REAL checkGuardrails (it re-derives the base tier from the mocked
// getToolTier above) but stub the RBAC + rate-limit checks so the mocked
// API-key auth context (no real RBAC grants) doesn't get denied for reasons
// orthogonal to alias resolution.
vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  return {
    ...actual,
    checkToolPermission: vi.fn(async () => null),
    checkToolRateLimit: vi.fn(async () => null),
    checkPermissionRequirement: vi.fn(async () => null),
  };
});

// Stub getUserPermissions so buildAuthFromApiKey's scope re-validation
// (SR2-15) doesn't hit the permissions DB. The baseline must satisfy
// validateApiKeyScopeDelegation for the 'ai:read' scope this suite uses
// (devices/alerts/scripts/automations read) — see the identical comment in
// mcpServer.effectiveTier.test.ts for why a fixed FULL baseline is safe here:
// the fine-grained RBAC it returns is stubbed out downstream (checkToolPermission
// is mocked to null) and unused by these alias-dispatch assertions.
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
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
      allowedSiteIds: undefined,
    })),
  };
});

import { mcpServerRoutes } from './mcpServer';

beforeEach(() => {
  vi.clearAllMocks();
  testState.scopes = ['ai:read'];
  mocks.executeTool.mockReset().mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.getToolDefinitions.mockReset().mockReturnValue([]);
  // get_invite_funnel is the ONLY registered tool for this suite; it is base
  // tier 1 (a plain read), so no scope/approval gate stands between alias
  // resolution and dispatch — keeping the mock minimal isolates exactly the
  // alias-resolution behavior under test.
  mocks.getToolTier.mockReset().mockImplementation((name: string) =>
    name === 'get_invite_funnel' ? 1 : undefined,
  );
  mocks.ledgerBegin.mockReset().mockResolvedValue({ id: 'ledger-1' });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.writeAuditEvent.mockReset();
});

async function callTool(toolName: string, args: Record<string, unknown> = {}) {
  const res = await mcpServerRoutes.request('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  return res;
}

function findToolExecutionAuditEvent(): any {
  const call = mocks.writeAuditEvent.mock.calls.find(
    (c: any[]) => c[1]?.resourceType === 'mcp_tool_execution',
  );
  return call?.[1];
}

describe('MCP tools/call deprecated alias dispatch (#5362)', () => {
  it('dispatches a call for the deprecated name "get_fleet_status" as the canonical tool "get_invite_funnel"', async () => {
    const res = await callTool('get_fleet_status', { orgId: 'org-1' });
    expect(res.status).toBe(200);
    const body = await res.json();

    // No "Unknown tool" JSON-RPC error — the alias resolved before the
    // tier/unknown-tool gate.
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeFalsy();

    // executeTool is called with the CANONICAL name, never the deprecated one.
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    const dispatchedName = mocks.executeTool.mock.calls[0]?.[0];
    expect(dispatchedName).toBe('get_invite_funnel');
    expect(dispatchedName).not.toBe('get_fleet_status');
  });

  it('records the canonical tool name plus requestedToolName + deprecatedToolAlias on the audit event for an aliased call', async () => {
    await callTool('get_fleet_status', { orgId: 'org-1' });

    const event = findToolExecutionAuditEvent();
    expect(event).toBeDefined();
    expect(event.action).toBe('mcp.tool.get_invite_funnel');
    expect(event.details.toolName).toBe('get_invite_funnel');
    expect(event.details.requestedToolName).toBe('get_fleet_status');
    expect(event.details.deprecatedToolAlias).toBe(true);
  });

  it('does not carry requestedToolName or deprecatedToolAlias on the audit event for an ordinary, non-aliased call', async () => {
    await callTool('get_invite_funnel', { orgId: 'org-1' });

    const event = findToolExecutionAuditEvent();
    expect(event).toBeDefined();
    expect(event.action).toBe('mcp.tool.get_invite_funnel');
    expect(event.details.toolName).toBe('get_invite_funnel');
    expect('requestedToolName' in event.details).toBe(false);
    expect('deprecatedToolAlias' in event.details).toBe(false);
  });

  it('still returns "Unknown tool" for a name that is not a registered tool or a known alias', async () => {
    const res = await callTool('not_a_tool', {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain('Unknown tool');
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});
