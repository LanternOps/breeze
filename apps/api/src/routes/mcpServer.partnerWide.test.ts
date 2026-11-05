import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// #10930: partner-wide AI tools (handler gated on canManagePartnerWidePolicies)
// were listed in MCP tools/list but refused on every call, because an MCP
// credential's AuthContext (buildAuthFromApiKey) never carries partnerOrgAccess.
// The gate stays fail-closed; MCP stops advertising those tools to such a
// principal, and the refusal names the connection as the reason instead of
// telling a full-access partner admin they need orgAccess "all".

const testState = vi.hoisted(() => ({
  apiKey: null as Record<string, any> | null,
  // Merged over the REAL buildAuthFromApiKey result; null = the real context untouched.
  authPatch: null as Record<string, unknown> | null,
}));

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  writeAuditEvent: vi.fn(),
  checkToolPermission: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
  partnerPerms: vi.fn(),
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
vi.mock('../db/schema', async () => {
  const { pgTable, text, timestamp } = await import('drizzle-orm/pg-core');
  return {
    devices: pgTable('test_devices', { id: text('id'), orgId: text('org_id'), siteId: text('site_id') }),
    organizations: pgTable('test_organizations', { id: text('id'), partnerId: text('partner_id'), createdAt: timestamp('created_at') }),
    partners: pgTable('test_partners', { id: text('id'), billingEmail: text('billing_email') }),
  };
});
vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (c: any, next: any) => {
    if (!testState.apiKey) throw new Error('no test api key');
    c.set('apiKey', testState.apiKey);
    c.set('apiKeyOrgId', testState.apiKey.orgId);
    await next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

// Real registry names (the partner-wide classification is keyed by name); stub handlers.
const TEST_TOOLS = [
  { name: 'get_pax8_status', tier: 1, schema: { type: 'object', properties: {} } },
  { name: 'manage_access_reviews', tier: 1, schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'get'] } } } },
  { name: 'manage_patches', tier: 1, schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'approve'] } } } },
  { name: 'list_sites', tier: 1, schema: { type: 'object', properties: {} } },
  // Tier 3 here (not in the registry) so the intent-filing path is exercised.
  { name: 'sync_edr_data', tier: 3, schema: { type: 'object', properties: {} } },
  { name: 'run_script', tier: 3, schema: { type: 'object', properties: {} } },
];
const intentMocks = vi.hoisted(() => ({ createMcpActionIntent: vi.fn() }));
vi.mock('../services/mcpIntentCreation', () => ({
  createMcpActionIntent: (...args: any[]) => intentMocks.createMcpActionIntent(...args),
  resolveMcpClientLabel: vi.fn(async () => 'MCP · test'),
}));
vi.mock('../services/aiTools', () => ({
  aiTools: new Map(),
  getToolDefinitions: () => TEST_TOOLS.map((t) => ({ name: t.name, description: t.name, input_schema: t.schema })),
  executeTool: (...args: any[]) => mocks.executeTool(...args),
  getToolTier: (name: string) => TEST_TOOLS.find((t) => t.name === name)?.tier,
  getToolDomain: () => 'core',
  getAllRegisteredToolNames: () => TEST_TOOLS.map((t) => t.name),
  toolManagesDbContext: () => false,
}));
vi.mock('../services/aiToolAliases', () => ({ resolveDeprecatedToolAlias: (name: string) => name }));
vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  return {
    ...actual,
    checkToolPermission: (...args: any[]) => mocks.checkToolPermission(...args),
    checkToolRateLimit: vi.fn(async () => null),
    checkPermissionRequirement: vi.fn(async () => null),
    checkPermissionRequirements: vi.fn(async () => null),
  };
});
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return { ...actual, getUserPermissions: (...args: any[]) => mocks.partnerPerms(...args) };
});
vi.mock('../services/mcpPrincipalAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/mcpPrincipalAuth')>();
  return {
    ...actual,
    buildAuthFromApiKey: async (...args: Parameters<typeof actual.buildAuthFromApiKey>) => {
      const auth = await actual.buildAuthFromApiKey(...args);
      return auth && testState.authPatch ? { ...auth, ...testState.authPatch } : auth;
    },
  };
});
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));
vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => { throw new Error('no bearer in this suite'); },
  resolvePartnerAccessibleOrgIds: async () => ['org-1'],
}));
vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => null),
  assertActiveTenantContext: vi.fn(),
  TenantInactiveError: class TenantInactiveError extends Error {},
}));
vi.mock('../services/recoveryBootstrap', () => ({
  resolveServerUrl: (requestUrl?: string) => (requestUrl ? new URL(requestUrl).origin : 'http://localhost:3001'),
}));
vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));
vi.mock('../services/toolSources/resolver', () => ({
  resolveTenantTools: vi.fn(async () => []),
  resolveTenantToolByName: vi.fn(async () => null),
  resolveTenantToolHealthByName: vi.fn(async () => ({ found: false })),
}));
vi.mock('../services/toolSources/execute', () => ({ executeTenantTool: vi.fn(), executeTenantToolDetailed: vi.fn() }));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

import { __loadMcpBootstrapForTests, mcpServerRoutes } from './mcpServer';
import { PARTNER_WIDE_UNAVAILABLE_OVER_MCP_MESSAGE, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';

function setPartnerKey() {
  testState.apiKey = {
    id: 'key-1', orgId: null, partnerId: 'partner-1', name: 'test', keyPrefix: 'brz_test',
    scopes: ['ai:read', 'ai:write'], rateLimit: 1000, createdBy: 'user-1', mcpDomains: ['*'],
  };
  mocks.partnerPerms.mockResolvedValue({
    permissions: [{ resource: '*', action: '*' }], partnerId: 'partner-1', orgId: null, roleId: 'role-1',
    scope: 'partner' as const, orgAccess: 'all', allowedSiteIds: undefined,
  });
}
function setOrgKey() {
  testState.apiKey = {
    id: 'key-2', orgId: 'org-1', partnerId: 'partner-1', name: 'test', keyPrefix: 'brz_test',
    scopes: ['ai:read', 'ai:write'], rateLimit: 1000, createdBy: 'user-1', mcpDomains: ['*'],
  };
  mocks.partnerPerms.mockResolvedValue({
    permissions: [{ resource: '*', action: '*' }], partnerId: null, orgId: 'org-1', roleId: 'role-1',
    scope: 'organization' as const, allowedSiteIds: undefined,
  });
}

async function rpc(method: string, params?: Record<string, unknown>) {
  const res = await mcpServerRoutes.request('/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: await res.json() as any };
}
const listNames = async () => ((await rpc('tools/list')).body.result.tools as Array<{ name: string }>).map((t) => t.name);
const callText = async (name: string, args: Record<string, unknown> = {}) => {
  const { body } = await rpc('tools/call', { name, arguments: args });
  return { result: body.result, parsed: JSON.parse(body.result.content[0].text) };
};

beforeAll(async () => { await __loadMcpBootstrapForTests(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MCP_TOOLS_LIST_PAGE_SIZE', '0');
  testState.authPatch = null;
  setPartnerKey();
  mocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.checkToolPermission.mockResolvedValue(null);
  mocks.ledgerBegin.mockResolvedValue({ id: 'ledger-1' });
  mocks.ledgerComplete.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('#10930 partner-wide tools over MCP — tools/list', () => {
  it('a partner API-key principal (no partnerOrgAccess, even for an orgAccess:all creator) is not offered them', async () => {
    const names = await listNames();
    expect(names).not.toContain('get_pax8_status');
    expect(names).not.toContain('manage_access_reviews');
    // Ordinary tools and a mixed tool (some actions work) stay listed.
    expect(names).toContain('list_sites');
    expect(names).toContain('manage_patches');
  });

  it('a principal that carries partnerOrgAccess "all" is offered them', async () => {
    testState.authPatch = { principal: { kind: 'user_session' }, partnerOrgAccess: 'all' };
    const names = await listNames();
    expect(names).toContain('get_pax8_status');
    expect(names).toContain('manage_access_reviews');
  });

  it('a partnerOrgAccess "selected" principal is not offered them', async () => {
    testState.authPatch = { partnerOrgAccess: 'selected' };
    const names = await listNames();
    expect(names).not.toContain('get_pax8_status');
  });

  it('an org-scope key keeps a tool the gate only applies to at partner scope', async () => {
    setOrgKey();
    const names = await listNames();
    expect(names).not.toContain('get_pax8_status');
    expect(names).toContain('manage_access_reviews');
  });
});

describe('#10930 partner-wide tools over MCP — tools/call', () => {
  it('a direct call is refused before the handler, naming the MCP connection as the reason', async () => {
    const { result, parsed } = await callText('get_pax8_status');
    expect(result.isError).toBe(true);
    expect(parsed.error).toBe(PARTNER_WIDE_UNAVAILABLE_OVER_MCP_MESSAGE);
    expect(parsed.error).not.toMatch(/orgAccess must be/);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('a principal carrying partnerOrgAccess "all" reaches the handler', async () => {
    testState.authPatch = { partnerOrgAccess: 'all' };
    const { result } = await callText('get_pax8_status');
    expect(result.isError).toBeUndefined();
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(mocks.executeTool.mock.calls[0]?.[2]).toMatchObject({ partnerOrgAccess: 'all' });
  });

  it('a mixed tool\'s partner-wide refusal is rewritten to the same shared copy, keeping its code', async () => {
    mocks.executeTool.mockResolvedValue(JSON.stringify({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'ACCESS_DENIED' }));
    const { result, parsed } = await callText('manage_patches', { action: 'approve' });
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(parsed).toEqual({ error: PARTNER_WIDE_UNAVAILABLE_OVER_MCP_MESSAGE, code: 'ACCESS_DENIED' });
  });

  it('per-tool partner-wide phrasings are rewritten too', async () => {
    for (const legacy of [
      'Update rings are partner-wide and require full partner org access (orgAccess must be "all")',
      'Full partner organization access is required',
      'Full partner scope is required to manage the shared UniFi integration',
    ]) {
      mocks.executeTool.mockResolvedValueOnce(JSON.stringify({ error: legacy }));
      const { parsed } = await callText('manage_patches', { action: 'approve' });
      expect(parsed.error).toBe(PARTNER_WIDE_UNAVAILABLE_OVER_MCP_MESSAGE);
    }
  });

  it('with MCP intents on, a classified Tier-3 tool is refused before an intent is filed (an unclassified one still files)', async () => {
    vi.stubEnv('MCP_TIER3_INTENTS_ENABLED', 'true');
    testState.apiKey!.scopes = ['ai:read', 'ai:write', 'ai:execute'];
    intentMocks.createMcpActionIntent.mockRejectedValue(new Error('stop after filing'));

    // Control: the harness reaches intent filing for a Tier-3 tool.
    await rpc('tools/call', { name: 'run_script', arguments: {} });
    expect(intentMocks.createMcpActionIntent).toHaveBeenCalledTimes(1);

    intentMocks.createMcpActionIntent.mockClear();
    const { result, parsed } = await callText('sync_edr_data');
    expect(result.isError).toBe(true);
    expect(parsed.error).toBe(PARTNER_WIDE_UNAVAILABLE_OVER_MCP_MESSAGE);
    expect(intentMocks.createMcpActionIntent).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(await listNames()).not.toContain('sync_edr_data');
  });

  it('only a pure returned error is rewritten: data mentioning the phrase and non-JSON pass through byte-identical', async () => {
    const data = JSON.stringify({ items: [], note: 'Full partner scope is required to manage the shared UniFi integration' });
    mocks.executeTool.mockResolvedValueOnce(data);
    const { body } = await rpc('tools/call', { name: 'manage_patches', arguments: { action: 'approve' } });
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0].text).toBe(data);

    mocks.executeTool.mockResolvedValueOnce('Full partner org access required (orgAccess must be "all")');
    const plain = await rpc('tools/call', { name: 'manage_patches', arguments: { action: 'approve' } });
    expect(plain.body.result.content[0].text).toBe('Full partner org access required (orgAccess must be "all")');
  });

  it('leaves unrelated errors and full-access callers\' results untouched', async () => {
    mocks.executeTool.mockResolvedValueOnce(JSON.stringify({ error: 'Patch not found' }));
    expect((await callText('manage_patches', { action: 'approve' })).parsed).toEqual({ error: 'Patch not found' });

    testState.authPatch = { partnerOrgAccess: 'all' };
    mocks.executeTool.mockResolvedValueOnce(JSON.stringify({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }));
    expect((await callText('manage_patches', { action: 'approve' })).parsed).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  });
});
