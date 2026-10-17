import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// B-W02 (#6156): per-grant MCP tool domains. The domain gate runs AFTER the
// tier / approval / MFA / allowlist / RBAC gates and never instead of them;
// listed ⇒ callable holds per principal; a missing mcpDomains fails closed.

const testState = vi.hoisted(() => ({
  apiKey: null as Record<string, any> | null,
  bootstrap: { unauthTools: [] as any[], authTools: [] as any[] },
}));

const mocks = vi.hoisted(() => ({
  executeTool: vi.fn(),
  writeAuditEvent: vi.fn(),
  checkToolPermission: vi.fn(),
  checkPermissionRequirement: vi.fn(),
  checkPermissionRequirements: vi.fn(),
  resolveTenantTools: vi.fn(),
  resolveTenantToolByName: vi.fn(),
  resolveTenantToolHealthByName: vi.fn(),
  executeTenantToolDetailed: vi.fn(),
  bootstrapHandler: vi.fn(),
  ledgerBegin: vi.fn(),
  ledgerComplete: vi.fn(),
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
    alerts: pgTable('test_alerts', { id: text('id'), orgId: text('org_id') }),
    scripts: pgTable('test_scripts', { id: text('id'), orgId: text('org_id') }),
    automations: pgTable('test_automations', { id: text('id'), orgId: text('org_id') }),
    organizations: pgTable('test_organizations', { id: text('id'), partnerId: text('partner_id'), createdAt: timestamp('created_at') }),
    partners: pgTable('test_partners', { id: text('id'), billingEmail: text('billing_email') }),
  };
});

vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (c: any, next: any) => {
    if (!testState.apiKey) throw new Error('no test api key');
    c.set('apiKey', testState.apiKey);
    c.set('apiKeyOrgId', 'org-1');
    await next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));

vi.mock('../services/aiTools', async () => {
  const fx = await import('./__fixtures__/mcpDomainTools');
  return {
    aiTools: new Map(),
    getToolDefinitions: () => fx.DOMAIN_TEST_TOOLS.map((t) => ({ ...t })),
    executeTool: (...args: any[]) => mocks.executeTool(...args),
    getToolTier: (name: string) => fx.DOMAIN_TEST_TIERS[name],
    getToolDomain: (name: string) => fx.DOMAIN_TEST_DOMAINS[name],
    getAllRegisteredToolNames: () => Object.keys(fx.DOMAIN_TEST_TIERS),
  };
});

vi.mock('../services/aiToolAliases', () => ({
  resolveDeprecatedToolAlias: (name: string) => (name === 'get_fleet_status' ? 'get_invite_funnel' : name),
}));

vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));
vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async () => { throw new Error('no bearer in this suite'); },
  resolvePartnerAccessibleOrgIds: async () => [],
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
  resolveTenantTools: (...args: any[]) => mocks.resolveTenantTools(...args),
  resolveTenantToolByName: (...args: any[]) => mocks.resolveTenantToolByName(...args),
  resolveTenantToolHealthByName: (...args: any[]) => mocks.resolveTenantToolHealthByName(...args),
}));
vi.mock('../services/toolSources/execute', () => ({
  executeTenantTool: vi.fn(),
  executeTenantToolDetailed: (...args: any[]) => mocks.executeTenantToolDetailed(...args),
}));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => testState.bootstrap }));

vi.mock('../services/aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiGuardrails')>();
  return {
    ...actual,
    checkToolPermission: (...args: any[]) => mocks.checkToolPermission(...args),
    checkToolRateLimit: vi.fn(async () => null),
    checkPermissionRequirement: (...args: any[]) => mocks.checkPermissionRequirement(...args),
    checkPermissionRequirements: (...args: any[]) => mocks.checkPermissionRequirements(...args),
  };
});

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: [{ resource: '*', action: '*' }],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization' as const,
      allowedSiteIds: undefined,
    })),
  };
});

import { z } from 'zod';
import { __loadMcpBootstrapForTests, mcpServerRoutes } from './mcpServer';
import { DOMAIN_TEST_DOMAINS, DOMAIN_TEST_TOOLS, makeTenantDescriptor } from './__fixtures__/mcpDomainTools';
import { MCP_GRANTABLE_DOMAINS } from '@breeze/shared';
import { mcpResourceDomain } from '../services/mcpDomains';
// Captured ONCE from origin/main 0ef0aec17b (before any B-W02 route edit) with
// this file's mocks and an unrestricted key. Never regenerate it from a branch
// that carries the domain gate — that would make the golden test vacuous.
import mainUnrestrictedToolsList from './__fixtures__/mcpToolsListUnrestricted.main.json';

const ALL_AI_SCOPES = ['ai:read', 'ai:write', 'ai:execute'];

function setKey(overrides: Record<string, unknown> = {}) {
  testState.apiKey = {
    id: 'key-1',
    orgId: 'org-1',
    partnerId: 'partner-1',
    name: 'test',
    keyPrefix: 'brz_test',
    scopes: ['ai:read', 'ai:write'],
    rateLimit: 1000,
    createdBy: 'user-1',
    mcpDomains: null,
    ...overrides,
  };
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

beforeAll(async () => {
  testState.bootstrap = {
    unauthTools: [],
    authTools: [{
      definition: { name: 'send_deployment_invites', description: 'invites', inputSchema: z.object({}).passthrough() },
      handler: (...args: any[]) => mocks.bootstrapHandler(...args),
    }],
  };
  await __loadMcpBootstrapForTests();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MCP_TOOLS_LIST_PAGE_SIZE', '0');
  setKey();
  mocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
  mocks.checkToolPermission.mockResolvedValue(null);
  mocks.checkPermissionRequirement.mockResolvedValue(null);
  mocks.checkPermissionRequirements.mockResolvedValue(null);
  mocks.resolveTenantTools.mockResolvedValue([makeTenantDescriptor()]);
  mocks.resolveTenantToolByName.mockImplementation(async (_auth: unknown, name: string) =>
    name === 'hudu__get_asset' ? makeTenantDescriptor() : null);
  mocks.resolveTenantToolHealthByName.mockResolvedValue({ found: false });
  mocks.executeTenantToolDetailed.mockResolvedValue({ isError: false, text: JSON.stringify({ ok: true }) });
  mocks.ledgerBegin.mockResolvedValue({ id: 'ledger-1' });
  mocks.ledgerComplete.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

const domainOf = (name: string): string | undefined =>
  name === 'whoami' ? 'core' : name.includes('__') ? 'integrations' : DOMAIN_TEST_DOMAINS[name];

// The ONE intended difference from main's unrestricted tools/list: B-W02 adds
// the server-intrinsic `whoami` tool (tier 1, core) for every principal.
// Hand-written, not built with the production presentation helper.
const WHOAMI_LIST_ENTRY = {
  title: 'Whoami',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { 'app.breeze/domain': 'core' },
  name: 'whoami',
  description: "Describe this connection's Breeze access: who it acts as, tenant scope, granted scopes and tool domains, and which actions need the Breeze web app. Call it before assuming a tool is missing.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/** main's golden with whoami inserted in the sorted core block (tenant tools stay last). */
function expectedUnrestrictedList() {
  const golden = structuredClone(mainUnrestrictedToolsList) as { result: { tools: Array<{ name: string }> } };
  const tools = golden.result.tools;
  const firstTenant = tools.findIndex((t) => t.name.includes('__'));
  const core = [...tools.slice(0, firstTenant), WHOAMI_LIST_ENTRY].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  golden.result.tools = [...core, ...tools.slice(firstTenant)];
  return golden;
}

describe('B-W02 domain gate — tools/list', () => {
  it('unrestricted principal lists exactly what main lists (plus whoami)', async () => {
    const { body } = await rpc('tools/list');
    const expected = expectedUnrestrictedList();
    expect(body).toEqual(expected);
    // Byte-identical, not just deep-equal: key order and every field of every
    // tool main already listed.
    expect(JSON.stringify(body)).toBe(JSON.stringify(expected));
    const withoutWhoami = { ...body, result: { tools: body.result.tools.filter((t: { name: string }) => t.name !== 'whoami') } };
    expect(JSON.stringify(withoutWhoami)).toBe(JSON.stringify(mainUnrestrictedToolsList));
  });

  it('missing mcpDomains on the context fails closed to core', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setKey();
    delete testState.apiKey!.mcpDomains;
    expect(await listNames()).toEqual(['query_devices', 'whoami']);
    const { body } = await rpc('tools/call', { name: 'list_tickets', arguments: {} });
    expect(body.error).toMatchObject({ code: -32003, data: { reason: 'domain_not_granted', domain: 'tickets' } });
    expect(err).toHaveBeenCalledWith('[MCP] principal context missing mcpDomains');
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('restricted principal lists only granted domains plus core', async () => {
    setKey({ mcpDomains: ['tickets'] });
    const names = await listNames();
    expect(names).toEqual(['create_ticket', 'list_tickets', 'query_devices', 'whoami']);
    for (const name of names) expect(['core', 'tickets']).toContain(domainOf(name));
    expect(names).not.toContain('get_device_details');
  });

  it('a cursor issued before a domain edit is rejected as stale', async () => {
    vi.stubEnv('MCP_TOOLS_LIST_PAGE_SIZE', '2');
    const page1 = await rpc('tools/list');
    const cursor = page1.body.result.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    setKey({ mcpDomains: ['tickets'] });
    const page2 = await rpc('tools/list', { cursor });
    expect(page2.body.error).toMatchObject({ code: -32602 });
    expect(page2.body.error.message).toMatch(/^Tools list changed/);
  });

  it('domain gate never loosens the tier gate', async () => {
    setKey({ mcpDomains: ['devices'], scopes: ['ai:read'] });
    expect(await listNames()).toEqual(['get_device_details', 'query_devices', 'whoami']);
    const { body } = await rpc('tools/call', { name: 'manage_services', arguments: { action: 'list' } });
    expect(body.error).toMatchObject({ code: -32603, message: 'Tool "manage_services" requires ai:write scope' });
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});

describe('B-W02 domain gate — tools/call', () => {
  it('listed ⇒ callable, unlisted ⇒ domain_not_granted', async () => {
    const candidates = [
      ...DOMAIN_TEST_TOOLS.map((t) => t.name),
      'hudu__get_asset',
      'send_deployment_invites',
      'whoami',
    ];
    for (const d of MCP_GRANTABLE_DOMAINS) {
      setKey({ mcpDomains: [d], scopes: ALL_AI_SCOPES });
      const listed = new Set(await listNames());
      for (const name of candidates) {
        const { body } = await rpc('tools/call', { name, arguments: name === 'manage_services' ? { action: 'list' } : {} });
        const code = body.error?.code;
        const domain = name === 'send_deployment_invites' ? undefined : domainOf(name);
        if (listed.has(name)) {
          expect(code, `${d}: listed ${name} must not be domain-denied`).not.toBe(-32003);
        } else if (domain !== 'core' && domain !== d) {
          expect(code, `${d}: unlisted ${name} (domain ${domain}) must be domain-denied`).toBe(-32003);
          expect(body.error.data.reason).toBe('domain_not_granted');
        }
      }
    }
  });

  it('domain denial is audited with canonical tool and domain', async () => {
    setKey({ mcpDomains: ['tickets'] });
    const { body } = await rpc('tools/call', { name: 'get_device_details', arguments: {} });
    expect(body.error.code).toBe(-32003);
    const audit = mocks.writeAuditEvent.mock.calls.map((c: any[]) => c[1]).find((e: any) => e?.resourceType === 'mcp_request');
    expect(audit).toBeDefined();
    expect(audit.result).toBe('failure');
    expect(audit.details).toMatchObject({
      method: 'tools/call',
      canonicalTool: 'get_device_details',
      domain: 'devices',
      deniedReason: 'domain_not_granted',
    });
  });

  it("a deprecated alias is gated on its canonical tool's domain", async () => {
    setKey({ mcpDomains: ['tickets'] });
    const { body } = await rpc('tools/call', { name: 'get_fleet_status', arguments: {} });
    expect(body.error).toMatchObject({ code: -32003, data: { reason: 'domain_not_granted', domain: 'accounts' } });
    expect(body.error.message).toContain('"get_invite_funnel"');
    expect(mocks.executeTool).not.toHaveBeenCalled();
    const audit = mocks.writeAuditEvent.mock.calls.map((c: any[]) => c[1]).find((e: any) => e?.resourceType === 'mcp_request');
    expect(audit.details.canonicalTool).toBe('get_invite_funnel');
  });

  it('unknown tool names stay Unknown tool, never domain_not_granted', async () => {
    setKey({ mcpDomains: ['tickets'] });
    const { body } = await rpc('tools/call', { name: 'not_a_tool', arguments: {} });
    expect(body.error).toMatchObject({ code: -32602, message: 'Unknown tool: not_a_tool' });
  });

  it('tenant tools follow integrations; unclassified tools need an unrestricted grant', async () => {
    setKey({ mcpDomains: ['tickets'] });
    expect(await listNames()).not.toContain('hudu__get_asset');
    expect((await rpc('tools/call', { name: 'hudu__get_asset', arguments: {} })).body.error)
      .toMatchObject({ code: -32003, data: { domain: 'integrations' } });
    expect(mocks.resolveTenantToolByName).not.toHaveBeenCalled();

    setKey({ mcpDomains: ['integrations'] });
    const names = await listNames();
    expect(names).toContain('hudu__get_asset');
    expect(names).not.toContain('ext_vendor_lookup');
    const tenantCall = await rpc('tools/call', { name: 'hudu__get_asset', arguments: {} });
    expect(tenantCall.body.error).toBeUndefined();
    expect((await rpc('tools/call', { name: 'ext_vendor_lookup', arguments: {} })).body.error)
      .toMatchObject({ code: -32003, data: { domain: 'unclassified' } });

    setKey({ mcpDomains: ['accounts'], scopes: ALL_AI_SCOPES });
    expect((await rpc('tools/call', { name: 'send_deployment_invites', arguments: {} })).body.error)
      .toMatchObject({ code: -32003, data: { domain: 'unclassified' } });

    // Unrestricted: the bootstrap tool is still approval-gated exactly as on main.
    setKey({ mcpDomains: null, scopes: ALL_AI_SCOPES });
    const bootstrap = await rpc('tools/call', { name: 'send_deployment_invites', arguments: {} });
    expect(bootstrap.body.error).toBeUndefined();
    expect(bootstrap.body.result.isError).toBe(true);
    expect(JSON.parse(bootstrap.body.result.content[0].text).code).toBe('MCP_APPROVAL_REQUIRED');
    expect(mocks.bootstrapHandler).not.toHaveBeenCalled();
  });
});

describe('B-W02 domain gate — resources', () => {
  const DEVICE_URI = 'breeze://devices/3f6c2a1e-1b2c-4d5e-8f90-123456789abc';
  const listUris = async () => ((await rpc('resources/list')).body.result.resources as Array<{ uri: string }>).map((r) => r.uri);

  it('every listed resource URI has a domain', async () => {
    const uris = await listUris();
    expect(uris).toEqual(['breeze://devices', 'breeze://alerts', 'breeze://scripts', 'breeze://automations']);
    for (const uri of [...uris, DEVICE_URI]) expect(mcpResourceDomain(uri), uri).toBeDefined();
  });

  it('resources/list and resources/read follow resource domains', async () => {
    setKey({ mcpDomains: ['tickets'] });
    expect(await listUris()).toEqual(['breeze://devices']);
    for (const uri of ['breeze://alerts', 'breeze://scripts', DEVICE_URI]) {
      const { body } = await rpc('resources/read', { uri });
      expect(body.error, uri).toMatchObject({ code: -32003, data: { reason: 'domain_not_granted' } });
    }
    expect(mocks.checkPermissionRequirement).not.toHaveBeenCalled();

    setKey({ mcpDomains: ['monitoring', 'scripts'] });
    expect(await listUris()).toEqual(['breeze://devices', 'breeze://alerts', 'breeze://scripts', 'breeze://automations']);
  });

  it('an unknown resource URI stays Unknown resource for a restricted principal', async () => {
    setKey({ mcpDomains: ['tickets'] });
    const { body } = await rpc('resources/read', { uri: 'breeze://secrets' });
    expect(body.error).toMatchObject({ code: -32602, message: 'Unknown resource URI: breeze://secrets' });
  });
});

describe('B-W02 whoami', () => {
  const callWhoami = async () => {
    const { body } = await rpc('tools/call', { name: 'whoami', arguments: {} });
    expect(body.error).toBeUndefined();
    expect(body.result.structuredContent).toEqual(JSON.parse(body.result.content[0].text));
    return body.result.structuredContent;
  };

  it('whoami is listed and callable for every principal kind, including a core-only grant', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const principals: Array<[Record<string, unknown>, string, string]> = [
      [{ mcpDomains: null }, 'api_key', 'key-1'],
      [{ mcpDomains: ['tickets'] }, 'api_key', 'key-1'],
      [{ id: 'oauth:jti-1', oauthGrantId: 'grant-9', oauthClientId: 'client-9', name: 'OAuth bearer' }, 'oauth', 'grant-9'],
      [{ id: 'psp-key-1', orgId: null, partnerServicePrincipalId: 'psp-1' }, 'partner_service_principal', 'psp-1'],
    ];
    for (const [overrides, kind, id] of principals) {
      setKey(overrides);
      expect(await listNames()).toContain('whoami');
      expect(await callWhoami()).toMatchObject({ kind, id });
    }
    // A context that lost mcpDomains (core-only) still gets whoami.
    setKey();
    delete testState.apiKey!.mcpDomains;
    expect(await listNames()).toContain('whoami');
    expect((await callWhoami()).domains).toMatchObject({ restricted: true, granted: ['core'] });
    err.mockRestore();
  });

  it('whoami result matches the live gate', async () => {
    setKey({ mcpDomains: ['tickets'], scopes: ['ai:read', 'ai:write'] });
    const listed = (await rpc('tools/list')).body.result.tools as Array<{ _meta: Record<string, string> }>;
    const listedDomains = new Set(listed.map((t) => t._meta['app.breeze/domain']));
    const who = await callWhoami();
    expect(new Set(who.domains.granted)).toEqual(listedDomains);
    expect(who).toMatchObject({ capability: 'write', scopes: ['ai:read', 'ai:write'], tenant: { orgId: 'org-1' } });
  });

  it('whoami never dispatches to the registry or the tier-3 ledger', async () => {
    await callWhoami();
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(mocks.ledgerBegin).not.toHaveBeenCalled();
  });
});
