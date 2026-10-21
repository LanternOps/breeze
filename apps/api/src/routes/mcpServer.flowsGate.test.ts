import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Tool Catalog W03 (#5218), quorum P3. Breeze's MCP server enumerates the
// tool registry directly, so the chat factory's FLOWS_ENABLED gate does not
// cover it: with the flag off the four flow tools must be absent from
// tools/list and answer tools/call exactly like an unknown tool (no existence
// oracle). Harness trimmed from mcpServer.deprecatedAlias.test.ts.
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
      mcpDomains: null,
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
  getToolDomain: (name: string) => (name === 'get_invite_funnel' ? 'core' : 'scripts'),
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

const FLOW_TOOLS = ['draft_flow', 'validate_flow', 'get_flow', 'list_flows'];
const def = (name: string) => ({ name, description: name, input_schema: { type: 'object', properties: {} } });

beforeEach(() => {
  vi.clearAllMocks();
  testState.scopes = ['ai:read', 'ai:write'];
  mocks.executeTool.mockReset().mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.getToolDefinitions.mockReset().mockReturnValue([def('get_invite_funnel'), ...FLOW_TOOLS.map(def)]);
  mocks.getToolTier.mockReset().mockImplementation((name: string) =>
    name === 'get_invite_funnel' ? 1 : name === 'draft_flow' ? 2 : FLOW_TOOLS.includes(name) ? 1 : undefined,
  );
  mocks.ledgerBegin.mockReset().mockResolvedValue({ id: 'ledger-1' });
  mocks.ledgerComplete.mockReset().mockResolvedValue(undefined);
  mocks.writeAuditEvent.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

async function rpc(method: string, params: Record<string, unknown>) {
  const res = await mcpServerRoutes.request('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
}

const listedNames = async () => ((await rpc('tools/list', {})).result?.tools ?? []).map((t: { name: string }) => t.name);

describe('MCP flow tools gate (FLOWS_ENABLED)', () => {
  it('flag off: tools/list omits the four flow tools', async () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    const names = await listedNames();
    expect(names).toContain('get_invite_funnel');
    for (const n of FLOW_TOOLS) expect(names).not.toContain(n);
  });

  it('flag off: tools/call draft_flow is answered exactly like an unknown tool', async () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    const gated = await rpc('tools/call', { name: 'draft_flow', arguments: { document: {} } });
    const unknown = await rpc('tools/call', { name: 'not_a_tool', arguments: {} });
    expect(gated.error?.code).toBe(-32602);
    expect(gated.error?.message).toBe('Unknown tool: draft_flow');
    expect(unknown.error?.message).toBe('Unknown tool: not_a_tool');
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('flag on: the flow tools are listed and callable', async () => {
    vi.stubEnv('FLOWS_ENABLED', 'true');
    const names = await listedNames();
    for (const n of FLOW_TOOLS) expect(names).toContain(n);
    const r = await rpc('tools/call', { name: 'get_flow', arguments: { flowId: '33333333-3333-4333-8333-333333333333' } });
    expect(r.error).toBeUndefined();
    expect(mocks.executeTool).toHaveBeenCalled();
    expect(mocks.executeTool.mock.calls[0]?.[0]).toBe('get_flow');
  });
});
