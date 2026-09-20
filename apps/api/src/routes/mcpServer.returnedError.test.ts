import { describe, expect, it, vi, beforeEach } from 'vitest';

// #6408 — core AI tools signal most failures by RETURNING
// `JSON.stringify({ error: '…' })` rather than throwing. Before this fix the
// core `handleToolsCall` path only set `isError` when a tool threw (or when a
// gate denied the call), so a returned error went out as an ordinary result
// with no `isError` and was ledgered/audited as `success`. Clients that branch
// on `isError` (as MCP intends) read "device not found" as a successful call.
//
// This suite pins the fixed behavior: a PURE returned error (top-level string
// `error` and no other key except the `_chat` compaction marker) is an MCP
// tool-execution error — `isError: true` on the result, `failure` on the
// ledger and the audit event. Anything carrying real data alongside an
// `error` field stays a success, because many tools report partial state that
// way.

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


async function callAndParse(resultText: string) {
  mocks.executeTool.mockResolvedValue(resultText);
  const res = await callTool('get_invite_funnel', { orgId: 'org-1' });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.result as {
    content: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
}

describe('MCP tools/call returned-error signalling (#6408)', () => {
  it.each([
    { error: 'Device not found' },
    { error: 'Access denied', _chat: { outputCompacted: true } },
  ])('marks a pure returned error as isError and audits it as a failure: %j', async (value) => {
    const result = await callAndParse(JSON.stringify(value));

    expect(result.isError).toBe(true);
    // The text block is unchanged — clients still see the tool's own message.
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }]);
    expect(result.structuredContent).toBeUndefined();

    const event = findToolExecutionAuditEvent();
    expect(event.result).toBe('failure');
    expect(event.errorMessage).toContain(value.error);
    // Failures record no `result` on the audit event (mirrors the thrown path).
    expect('result' in event.details).toBe(false);
  });

  it.each([
    { devices: [{ id: 'd1' }], error: null },
    { items: [1], error: 'partial' },
    { ok: true },
  ])('leaves a result carrying real data as a success: %j', async (value) => {
    const result = await callAndParse(JSON.stringify(value));

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(value);
    expect(findToolExecutionAuditEvent().result).toBe('success');
  });

  it.each(['plain text failure', '"error"', '[{"error":"x"}]', '{"error":123}'])(
    'leaves a non-pure-error payload as a success: %s',
    async (text) => {
      const result = await callAndParse(text);
      expect(result.isError).toBeUndefined();
      expect(findToolExecutionAuditEvent().result).toBe('success');
    },
  );
});
