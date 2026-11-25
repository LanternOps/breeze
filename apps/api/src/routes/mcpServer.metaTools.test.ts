/**
 * #12427 W01 T4: search_tools and get_tool_details over the route.
 *
 * Discovery never reveals a tool the caller could not list in `full` mode:
 * the catalog is the caller's own full list, whatever the mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', async (orig) => (await import('./__tests__/mcpServerToolList.testHarness')).envMock(orig as never));
vi.mock('../middleware/apiKeyAuth', async () => (await import('./__tests__/mcpServerToolList.testHarness')).apiKeyAuthMock());
vi.mock('../middleware/bearerTokenAuth', async () => (await import('./__tests__/mcpServerToolList.testHarness')).bearerMock());
vi.mock('../db', async (orig) => (await import('./__tests__/mcpServerToolList.testHarness')).dbMock(orig as never));
vi.mock('../services/permissions', async (orig) => (await import('./__tests__/mcpServerToolList.testHarness')).permissionsMock(orig as never));
vi.mock('../services/aiTools', async (orig) => (await import('./__tests__/mcpServerToolList.testHarness')).aiToolsMock(orig as never));
vi.mock('../services/aiGuardrails', async (orig) => (await import('./__tests__/mcpServerToolList.testHarness')).guardrailsMock(orig as never));
vi.mock('../services/auditEvents', async () => (await import('./__tests__/mcpServerToolList.testHarness')).auditMock());
vi.mock('../services/toolSources/resolver', async () => (await import('./__tests__/mcpServerToolList.testHarness')).resolverMock());
vi.mock('../services/flows/mcpFlowTools', async () => (await import('./__tests__/mcpServerToolList.testHarness')).flowToolsMock());
vi.mock('./mcpExecutionOrg', async () => (await import('./__tests__/mcpServerToolList.testHarness')).executionOrgMock());
vi.mock('../services/redis', async () => (await import('./__tests__/mcpServerToolList.testHarness')).redisMock());
vi.mock('../services/mcpToolExecutionLedger', async () => (await import('./__tests__/mcpServerToolList.testHarness')).ledgerMock());
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

import { mcpServerRoutes } from './mcpServer';
import { createMcpHarness, harnessState, resetHarnessState, UNRESTRICTED_KEY } from './__tests__/mcpServerToolList.testHarness';
import { aiTools } from '../services/aiTools';

const mcp = createMcpHarness(mcpServerRoutes, harnessState.writeAuditEvent);
const PROGRESSIVE = { headers: { 'Mcp-Tool-List': 'progressive' } };
const APPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const RESTRICTED = { ...UNRESTRICTED_KEY, mcpDomains: ['devices'] };
/** The same core+devices grant held by an OAuth grant (oauth_grants.mcp_domains). */
const RESTRICTED_OAUTH = {
  id: 'oauth:jti-devices', orgId: null, partnerId: 'partner-1', scopes: ['ai:read', 'ai:write', 'ai:execute'],
  mcpDomains: ['devices'], oauthGrantId: 'grant-devices', keyPrefix: 'oauth',
};
const RESTRICTED_PRINCIPALS: Array<[string, Record<string, unknown>]> = [['API key', RESTRICTED], ['OAuth grant', RESTRICTED_OAUTH]];
type Entry = { name: string; _meta: Record<string, unknown> };

async function fullNames(): Promise<Set<string>> {
  return new Set(((await mcp.legacy('tools/list')).body.result.tools as Entry[]).map((t) => t.name));
}
const search = (query: string, extra: Record<string, unknown> = {}, opts = {}) =>
  mcp.legacy('tools/call', { name: 'search_tools', arguments: { query, limit: 20, ...extra } }, opts);
const details = (names: string[], opts = {}, era: 'legacy' | 'modern' = 'legacy') =>
  mcp[era]('tools/call', { name: 'get_tool_details', arguments: { names } }, opts);
const rowNames = (res: { body: any }) => (res.body.result.structuredContent.tools as Entry[]).map((t) => t.name);

beforeEach(() => {
  resetHarnessState();
  harnessState.realRegistry = true;
  harnessState.tenantTools = [{ tier: 1, definition: { name: 'acme__lookup_widget', description: 'Look up a widget.', input_schema: { type: 'object', properties: {} } } }];
  process.env.MCP_STATELESS_ENABLED = 'true';
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.MCP_STATELESS_ENABLED;
});

describe('non-disclosure', () => {
  it.each(RESTRICTED_PRINCIPALS)('%s with a core+devices grant: search over every registry name returns only names its full list contains', async (_label, context) => {
    harnessState.context = context;
    const listable = await fullNames();
    const surfaced = new Set<string>();
    for (const name of aiTools.keys()) {
      for (const query of [name, name.replace(/_/g, ' '), `${name.split('_').pop()} status`]) {
        for (const row of rowNames(await search(query))) surfaced.add(row);
      }
    }
    expect(surfaced.size).toBeGreaterThan(10);
    expect([...surfaced].filter((n) => !listable.has(n))).toEqual([]);
    // And the grant really does hide registry tools (the set above is not vacuous).
    expect([...aiTools.keys()].filter((n) => !listable.has(n)).length).toBeGreaterThan(50);
  }, 120_000);

  it.each(RESTRICTED_PRINCIPALS)('%s: get_tool_details for an ungranted, a wholly gated and a made-up tool: one answer, differing only in the name', async (_label, context) => {
    harnessState.context = { ...context, scopes: ['ai:read'] };
    const answers = await Promise.all(['manage_tickets', 'execute_command', 'made_up_tool'].map(async (name) => (await details([name])).body));
    const normalized = answers.map((body, i) => JSON.stringify(body).replace(['manage_tickets', 'execute_command', 'made_up_tool'][i]!, '<name>'));
    expect(new Set(normalized).size).toBe(1);
    expect(answers[0].result).toEqual({ isError: true, content: [{ type: 'text', text: 'Unknown tool: manage_tickets' }] });
  });

  it.each(RESTRICTED_PRINCIPALS)('%s: a direct tools/call keeps its split, and call_tool gives the same -32003', async (_label, context) => {
    harnessState.context = context;
    expect((await mcp.legacy('tools/call', { name: 'call_tool', arguments: { name: 'manage_tickets', arguments: {} } })).body.error.code).toBe(-32003);
    expect((await mcp.legacy('tools/call', { name: 'manage_tickets', arguments: {} })).body.error.code).toBe(-32003);
    expect((await mcp.legacy('tools/call', { name: 'made_up_tool', arguments: {} })).body.error.code).toBe(-32602);
  });

  it('search catalog includes tenant tools the caller can list (and only then)', async () => {
    expect(rowNames(await search('widget lookup'))).toContain('acme__lookup_widget');
    harnessState.context = RESTRICTED;
    expect(rowNames(await search('widget lookup'))).not.toContain('acme__lookup_widget');
  });
});

describe('gated tools are invisible to discovery (Review Focus 3)', () => {
  it.each([
    ['partner-wide refused for an org caller', 'get_partner_settings_inheritance'],
    ['wholly MFA-gated for a caller without an MFA session', 'apply_configuration_policy'],
  ])('%s: %s is absent from full, unknown to get_tool_details, never surfaced by search', async (_label, name) => {
    expect((await fullNames()).has(name)).toBe(false);
    const res = await details([name]);
    expect(res.body.result).toEqual({ isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] });
    for (const query of [name, name.replace(/_/g, ' ')]) expect(rowNames(await search(query))).not.toContain(name);
  });
});

describe('an incomplete catalog', () => {
  it('a tenant-tool resolution failure is flagged on search_tools and named on get_tool_details', async () => {
    harnessState.resolveTenantTools.mockRejectedValue(new Error('tool source down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await search('widget lookup')).body.result.structuredContent.catalogIncomplete).toEqual(['tenant']);
    expect((await details(['acme__lookup_widget'])).body.result.content[0].text)
      .toBe('Unknown tool: acme__lookup_widget. Some integration tools could not be loaded right now; retry.');
    // tools/list keeps today's shape: no new key.
    expect(Object.keys((await mcp.legacy('tools/list')).body.result)).toEqual(['tools']);
  });
});

describe('get_tool_details', () => {
  it('returns the identical entry object the full list emits (modern Apps client: _meta.ui included)', async () => {
    vi.stubEnv('MCP_APPS_ENABLED', 'true');
    const listed = ((await mcp.modern('tools/list', undefined, { clientCapabilities: APPS })).body.result.tools as Entry[]);
    const want = ['get_fleet_health', 'query_devices', 'acme__lookup_widget'];
    const res = await details(want, { clientCapabilities: APPS }, 'modern');
    const got = res.body.result.structuredContent.tools as Entry[];
    expect(got).toEqual(want.map((n) => listed.find((t) => t.name === n)));
    expect(got[0]!._meta.ui).toBeDefined();
  });
});

describe('modes', () => {
  it('search_tools and get_tool_details are callable in full mode, and no meta-tool is listed there', async () => {
    const full = await fullNames();
    for (const name of ['search_tools', 'get_tool_details', 'call_tool']) expect(full.has(name)).toBe(false);
    expect(rowNames(await search('offline devices'))).toContain('query_devices');
    expect(rowNames(await details(['query_devices']))).toEqual(['query_devices']);
  });

  it('the catalog is mode-independent: progressive search finds tools progressive does not list', async () => {
    const res = await search('time entries timesheet', {}, PROGRESSIVE);
    expect(rowNames(res).length).toBeGreaterThan(0);
    const listed = ((await mcp.legacy('tools/list', undefined, PROGRESSIVE)).body.result.tools as Entry[]).map((t) => t.name);
    expect(rowNames(res).some((n) => !listed.includes(n))).toBe(true);
  });

  it('invalid arguments → -32602 Invalid params', async () => {
    const res = await mcp.legacy('tools/call', { name: 'search_tools', arguments: { query: 'x', limit: 99 } });
    expect(res.body.error).toEqual({ code: -32602, message: 'Invalid params', data: { reason: 'invalid_arguments' } });
  });
});
