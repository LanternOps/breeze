/**
 * #12427 W01 T0: the `full` tool list is byte-identical to what it was before
 * progressive disclosure existed. This suite was committed on unchanged code
 * and must stay green through the feature.
 *
 * Pinned per era, with MCP Apps declared and not: the whole tools/list result,
 * the initialize result and the server/discover result. Two checks run on the
 * REAL registry, so a hint key or a listed meta-tool cannot hide behind the
 * fixture catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  realRegistry: false,
  context: {} as Record<string, unknown>,
  writeAuditEvent: vi.fn(),
}));

const FIXTURE = vi.hoisted(() => ({
  catalog: {
    get_fleet_health: { tier: 1, domain: 'devices' },
    get_alert_summary: { tier: 1, domain: 'monitoring' },
    // The canonical target of a deprecated alias (aiToolAliases.ts).
    get_invite_funnel: { tier: 1, domain: 'admin' },
    acknowledge_alert: { tier: 2, domain: 'monitoring' },
    reboot_device: { tier: 3, domain: 'devices' },
  } as Record<string, { tier: number; domain: string }>,
}));

vi.mock('../config/env', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/env')>(),
  MCP_OAUTH_ENABLED: false,
  OAUTH_ISSUER: 'https://us.example.com',
}));
vi.mock('../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: async (c: any, next: any) => {
    c.set('apiKey', { name: 'test', keyPrefix: 'brz_test', rateLimit: 1000, createdBy: 'user-1', ...mocks.context });
    return next();
  },
  requireApiKeyScope: () => async (_c: any, next: any) => next(),
}));
vi.mock('../middleware/bearerTokenAuth', () => ({
  bearerTokenAuthMiddleware: async (_c: any, next: any) => next(),
  resolvePartnerAccessibleOrgIds: async () => ['org-1'],
}));
vi.mock('../db', async (importOriginal) => {
  const rows = [{ partnerId: 'partner-1', orgAccess: 'all', orgIds: null, id: 'org-1' }];
  const where = () => Object.assign(Promise.resolve(rows), { limit: async () => rows, orderBy: () => ({ limit: async () => rows }) });
  return {
    ...await importOriginal<typeof import('../db')>(),
    db: { select: () => ({ from: () => ({ where }) }) },
    withDbAccessContext: async (_ctx: unknown, fn: () => any) => fn(),
    withSystemDbAccessContext: async (fn: () => any) => fn(),
    runOutsideDbContext: (fn: () => any) => fn(),
  };
});
vi.mock('../services/permissions', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/permissions')>(),
  getUserPermissions: async () => ({
    permissions: [{ resource: '*', action: '*' }], partnerId: 'partner-1', orgId: 'org-1', roleId: 'role-1', scope: 'organization',
  }),
}));
vi.mock('../services/aiTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiTools')>();
  return {
    ...actual,
    getToolDefinitions: () => (mocks.realRegistry
      ? actual.getToolDefinitions()
      : Object.keys(FIXTURE.catalog).map((name) => ({ name, description: `${name} description.`, input_schema: { type: 'object', properties: {} } }))),
    getToolTier: (name: string) => (mocks.realRegistry ? actual.getToolTier(name) : FIXTURE.catalog[name]?.tier),
    getToolDomain: (name: string) => (mocks.realRegistry ? actual.getToolDomain(name) : FIXTURE.catalog[name]?.domain),
  };
});
vi.mock('../services/aiGuardrails', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/aiGuardrails')>(),
  checkPermissionRequirement: async () => null,
}));
vi.mock('../services/auditEvents', () => ({ writeAuditEvent: mocks.writeAuditEvent, requestLikeFromSnapshot: vi.fn() }));
vi.mock('../services/toolSources/resolver', () => ({
  resolveTenantTools: async () => [{
    tier: 1,
    definition: { name: 'acme__lookup_widget', description: 'Look up a widget.', input_schema: { type: 'object', properties: { id: { type: 'string' } } } },
  }],
}));
vi.mock('../services/flows/mcpFlowTools', () => ({
  listMcpFlowTools: async () => [{ name: 'flow__weekly_report', description: 'Run the weekly report flow.', tier: 1, inputSchema: { type: 'object', properties: {} } }],
  callMcpFlowTool: vi.fn(),
}));
vi.mock('./mcpExecutionOrg', () => ({
  resolveMcpExecutionOrgId: () => 'org-1',
  resolveMcpExecutionContext: async () => ({ orgId: 'org-1' }),
  McpExecutionOrgError: class McpExecutionOrgError extends Error {},
}));
const sessions = new Map<string, string>();
vi.mock('../services/redis', () => ({
  getRedis: () => ({
    setex: async (k: string, _t: number, v: string) => { sessions.set(k, v); return 'OK'; },
    get: async (k: string) => sessions.get(k) ?? null,
  }),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

import { mcpServerRoutes } from './mcpServer';
import { API_VERSION } from '../version';
import { createMcpHarness } from './__tests__/mcpServerToolList.testHarness';

const mcp = createMcpHarness(mcpServerRoutes, mocks.writeAuditEvent);
const APPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const UNRESTRICTED = {
  id: '0a0a0a0a-0000-4000-8000-00000000000a', orgId: 'org-1', partnerId: 'partner-1',
  scopes: ['ai:read', 'ai:write', 'ai:execute'], mcpDomains: null,
};

/**
 * The exact result as serialized, with the two release-varying values
 * normalised (the deployed version and the rounded tool count in the
 * instructions); key order is kept.
 */
function pinned(result: unknown): string {
  const normalized = JSON.stringify(result, null, 2)
    .replaceAll(JSON.stringify(API_VERSION), '"<version>"')
    .replace(/~\d+ tools/g, '~<count> tools');
  return `${normalized}\n`;
}

beforeEach(() => {
  process.env.MCP_STATELESS_ENABLED = 'true';
  process.env.MCP_APPS_ENABLED = 'true';
  mocks.realRegistry = false;
  mocks.context = UNRESTRICTED;
  mocks.writeAuditEvent.mockReset();
  sessions.clear();
});
afterEach(() => {
  delete process.env.MCP_STATELESS_ENABLED;
  delete process.env.MCP_APPS_ENABLED;
  delete process.env.MCP_TIER3_INTENTS_ENABLED;
});

describe('full output is byte-identical (fixture catalog)', () => {
  it.each([
    ['full-tools-list.json', false, undefined],
    ['full-tools-list.apps.json', false, APPS],
    ['full-tools-list.intents.json', true, undefined],
  ] as const)('legacy tools/list matches %s', async (file, intents, caps) => {
    if (intents) process.env.MCP_TIER3_INTENTS_ENABLED = 'true';
    const res = await mcp.legacy('tools/list', undefined, { clientCapabilities: caps });
    expect(res.status).toBe(200);
    await expect(pinned(res.body.result)).toMatchFileSnapshot(`__snapshots__/legacy-${file}`);
  });

  it.each([
    ['full-tools-list.json', false, undefined],
    ['full-tools-list.apps.json', false, APPS],
    ['full-tools-list.intents.json', true, undefined],
  ] as const)('modern tools/list matches %s', async (file, intents, caps) => {
    if (intents) process.env.MCP_TIER3_INTENTS_ENABLED = 'true';
    const res = await mcp.modern('tools/list', undefined, { clientCapabilities: caps ?? {} });
    expect(res.status).toBe(200);
    await expect(pinned(res.body.result)).toMatchFileSnapshot(`__snapshots__/modern-${file}`);
  });

  it('the initialize result matches its snapshot', async () => {
    const { response } = await mcp.initialize();
    await expect(pinned(response.body.result)).toMatchFileSnapshot('__snapshots__/full-initialize.json');
  });

  it('the server/discover result matches its snapshot', async () => {
    const res = await mcp.modern('server/discover');
    await expect(pinned(res.body.result)).toMatchFileSnapshot('__snapshots__/full-discover.json');
  });
});

describe('full output on the real registry', () => {
  beforeEach(() => { mocks.realRegistry = true; });

  async function realEntries() {
    const res = await mcp.legacy('tools/list');
    const tools = res.body.result.tools as Array<{ name: string; _meta: Record<string, unknown> }>;
    expect(tools.length).toBeGreaterThan(200);
    return tools;
  }

  it('no full list entry carries an anthropic/* hint key', async () => {
    for (const tool of await realEntries()) {
      expect(tool._meta, tool.name).not.toHaveProperty(['anthropic/searchHint']);
      expect(tool._meta, tool.name).not.toHaveProperty(['anthropic/alwaysLoad']);
    }
  });

  it('no full list entry is a meta-tool', async () => {
    const names = (await realEntries()).map((t) => t.name);
    for (const name of ['search_tools', 'get_tool_details', 'call_tool']) expect(names).not.toContain(name);
  });
});
