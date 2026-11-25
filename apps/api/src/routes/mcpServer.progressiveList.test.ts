/**
 * #12427 W01 T3: the progressive tools/list and its instructions.
 *
 * Progressive lists the registry's alwaysLoad core that this caller can list,
 * the intrinsics listed today, and the three meta-tools; nothing else. The
 * instructions name no domain and no tool outside what the caller could list
 * in `full` mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', async (orig) => (await import('./mcpServerToolList.testHarness')).envMock(orig as never));
vi.mock('../middleware/apiKeyAuth', async () => (await import('./mcpServerToolList.testHarness')).apiKeyAuthMock());
vi.mock('../middleware/bearerTokenAuth', async () => (await import('./mcpServerToolList.testHarness')).bearerMock());
vi.mock('../db', async (orig) => (await import('./mcpServerToolList.testHarness')).dbMock(orig as never));
vi.mock('../services/permissions', async (orig) => (await import('./mcpServerToolList.testHarness')).permissionsMock(orig as never));
vi.mock('../services/aiTools', async (orig) => (await import('./mcpServerToolList.testHarness')).aiToolsMock(orig as never));
vi.mock('../services/aiGuardrails', async (orig) => (await import('./mcpServerToolList.testHarness')).guardrailsMock(orig as never));
vi.mock('../services/auditEvents', async () => (await import('./mcpServerToolList.testHarness')).auditMock());
vi.mock('../services/toolSources/resolver', async () => (await import('./mcpServerToolList.testHarness')).resolverMock());
vi.mock('../services/flows/mcpFlowTools', async () => (await import('./mcpServerToolList.testHarness')).flowToolsMock());
vi.mock('./mcpExecutionOrg', async () => (await import('./mcpServerToolList.testHarness')).executionOrgMock());
vi.mock('../services/redis', async () => (await import('./mcpServerToolList.testHarness')).redisMock());
vi.mock('../services/mcpToolExecutionLedger', async () => (await import('./mcpServerToolList.testHarness')).ledgerMock());
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));

import { mcpServerRoutes, buildToolsListEntries } from './mcpServer';
import { ALL_FLAGS_ON, createMcpHarness, harnessState, resetHarnessState, UNRESTRICTED_KEY } from './mcpServerToolList.testHarness';
import { aiTools, getToolSearchHint } from '../services/aiTools';
import { NO_MCP_CLIENT_EXTENSIONS } from '../services/mcpClientExtensions';
import { MCP_SERVER_INSTRUCTIONS } from '../services/mcpGuidance';
import { UNTRUSTED_TOOL_OUTPUT_RULE } from '../services/aiAgentSystemPrompt';
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS } from '@breeze/shared';

const mcp = createMcpHarness(mcpServerRoutes, harnessState.writeAuditEvent);
const PROGRESSIVE = { headers: { 'Mcp-Tool-List': 'progressive' } };
const APPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
const META_TOOLS = ['call_tool', 'get_tool_details', 'search_tools'];
const INTRINSICS = ['cancel_action', 'get_action_status', 'whoami'];
const ALWAYS_LOAD = [
  'analyze_metrics', 'execute_command', 'get_device_details', 'get_fleet_health', 'get_security_posture', 'list_organizations',
  'list_scripts', 'manage_alerts', 'manage_patches', 'query_change_log', 'query_devices', 'resolve_device_context',
  'search_documentation', 'search_logs',
];
type Entry = { name: string; title: string; description: string; annotations: unknown; inputSchema: unknown; _meta: Record<string, unknown> };
const names = (res: { body: any }) => (res.body.result.tools as Entry[]).map((t) => t.name);

beforeEach(() => {
  resetHarnessState();
  harnessState.realRegistry = true;
  harnessState.tenantTools = [{ tier: 1, definition: { name: 'acme__lookup_widget', description: 'Look up a widget.', input_schema: { type: 'object', properties: {} } } }];
  harnessState.flowTools = [{ name: 'flow__weekly_report', description: 'Run the weekly report flow.', tier: 1, inputSchema: { type: 'object', properties: {} } }];
  process.env.MCP_STATELESS_ENABLED = 'true';
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.MCP_STATELESS_ENABLED;
});

describe('the progressive list', () => {
  it('unrestricted ai:execute principal (intents on): the 14 alwaysLoad tools + the three intrinsics + the three meta-tools, in name order', async () => {
    vi.stubEnv('MCP_TIER3_INTENTS_ENABLED', 'true');
    const expected = [...ALWAYS_LOAD, ...INTRINSICS, ...META_TOOLS].sort((a, b) => a.localeCompare(b, 'en'));
    // The 14 are the registry's alwaysLoad declarations; the fixture above names them.
    expect([...aiTools.values()].filter((t) => t.alwaysLoad === true).map((t) => t.definition.name).sort()).toEqual([...ALWAYS_LOAD].sort());
    for (const era of ['legacy', 'modern'] as const) {
      expect(names(await mcp[era]('tools/list', undefined, PROGRESSIVE)), era).toEqual(expected);
    }
  });

  it('ai:read only: no cancel_action, and execute_command (wholly gated) is absent', async () => {
    vi.stubEnv('MCP_TIER3_INTENTS_ENABLED', 'true');
    harnessState.context = { ...UNRESTRICTED_KEY, scopes: ['ai:read'] };
    const listed = names(await mcp.legacy('tools/list', undefined, PROGRESSIVE));
    expect(listed).not.toContain('cancel_action');
    expect(listed).not.toContain('execute_command');
    expect(listed).toEqual(expect.arrayContaining(['whoami', 'get_action_status', ...META_TOOLS]));
  });

  it('a core+devices grant lists only core and devices alwaysLoad tools', async () => {
    harnessState.context = { ...UNRESTRICTED_KEY, mcpDomains: ['devices'] };
    const tools = (await mcp.legacy('tools/list', undefined, PROGRESSIVE)).body.result.tools as Entry[];
    for (const tool of tools) expect(['core', 'devices'], tool.name).toContain(tool._meta['app.breeze/domain']);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['query_devices', 'get_device_details', 'get_fleet_health']));
    expect(tools.map((t) => t.name)).not.toContain('manage_alerts');
  });

  it('every progressive entry but the meta-tools equals its full-list entry; registry entries add the two hint keys', async () => {
    vi.stubEnv('MCP_TIER3_INTENTS_ENABLED', 'true');
    const full = new Map(((await mcp.legacy('tools/list')).body.result.tools as Entry[]).map((t) => [t.name, t]));
    const progressive = (await mcp.legacy('tools/list', undefined, PROGRESSIVE)).body.result.tools as Entry[];
    for (const entry of progressive) {
      if (META_TOOLS.includes(entry.name)) {
        expect(full.has(entry.name), entry.name).toBe(false);
        continue;
      }
      const { _meta, ...rest } = entry;
      const { _meta: fullMeta, ...fullRest } = full.get(entry.name)!;
      expect(rest, entry.name).toEqual(fullRest);
      // Same key order as the full entry, hints appended.
      expect(Object.keys(rest)).toEqual(Object.keys(fullRest));
      if (INTRINSICS.includes(entry.name)) {
        expect(_meta, entry.name).toEqual(fullMeta);
      } else {
        expect(_meta, entry.name).toEqual({ ...fullMeta, 'anthropic/searchHint': getToolSearchHint(entry.name), 'anthropic/alwaysLoad': true });
      }
    }
  });

  it('_meta.ui on get_fleet_health only for an Apps-declaring streamable client', async () => {
    vi.stubEnv('MCP_APPS_ENABLED', 'true');
    const fleet = (res: { body: any }) => (res.body.result.tools as Entry[]).find((t) => t.name === 'get_fleet_health')!;
    expect(fleet(await mcp.modern('tools/list', undefined, { ...PROGRESSIVE, clientCapabilities: APPS }))._meta.ui).toBeDefined();
    expect(fleet(await mcp.legacy('tools/list', undefined, { ...PROGRESSIVE, clientCapabilities: APPS }))._meta.ui).toBeDefined();
    expect(fleet(await mcp.modern('tools/list', undefined, PROGRESSIVE))._meta.ui).toBeUndefined();
  });

  it('tenant and flow tools: present in full, absent in progressive', async () => {
    const full = names(await mcp.legacy('tools/list'));
    expect(full).toEqual(expect.arrayContaining(['acme__lookup_widget', 'flow__weekly_report']));
    const progressive = names(await mcp.legacy('tools/list', undefined, PROGRESSIVE));
    expect(progressive).not.toContain('acme__lookup_widget');
    expect(progressive).not.toContain('flow__weekly_report');
  });

  it('progressive tools/list in the stateless era keeps the private cache hints', async () => {
    const res = await mcp.modern('tools/list', undefined, PROGRESSIVE);
    expect(res.body.result).toMatchObject({ ttlMs: 60000, cacheScope: 'private' });
  });
});

describe('buildToolsListEntries', () => {
  it('{ dynamicTools: false } never resolves tenant or flow tools', async () => {
    const auth = { scope: 'organization', orgId: 'org-1', partnerId: 'partner-1', user: { id: 'user-1' }, principal: { kind: 'api_key', id: 'k' } } as never;
    const { entries } = await buildToolsListEntries({
      scopes: ['ai:read'], auth, apiKey: UNRESTRICTED_KEY as never, clientExtensions: NO_MCP_CLIENT_EXTENSIONS, dynamicTools: false,
    });
    expect(entries.length).toBeGreaterThan(100);
    expect(harnessState.resolveTenantTools).not.toHaveBeenCalled();
    expect(harnessState.listMcpFlowTools).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

const TOOL_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
/** Every name that is a tool somewhere: registry, intrinsics and meta-tools. */
const ANY_TOOL_NAME = new Set([...aiTools.keys(), ...INTRINSICS, ...META_TOOLS]);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

async function instructionsAndCatalog(era: 'legacy' | 'modern') {
  const init = era === 'legacy'
    ? (await mcp.initialize(PROGRESSIVE)).response.body.result
    : (await mcp.modern('server/discover', undefined, PROGRESSIVE)).body.result;
  const catalog = new Set([...names(await mcp.legacy('tools/list')), ...META_TOOLS]);
  return { text: init.instructions as string, catalog };
}

function namedTools(text: string): string[] {
  return [...new Set(text.match(TOOL_TOKEN) ?? [])].filter((t) => ANY_TOOL_NAME.has(t));
}

describe('progressive instructions', () => {
  const PRINCIPALS: Array<[string, Record<string, unknown>, Record<string, string>]> = [
    ['unrestricted', UNRESTRICTED_KEY, {}],
    ['core-only grant', { ...UNRESTRICTED_KEY, mcpDomains: [] }, {}],
    ['ai:read only', { ...UNRESTRICTED_KEY, scopes: ['ai:read'] }, {}],
    ['intents on, caller owns none (partner service principal)', { ...UNRESTRICTED_KEY, orgId: null, partnerServicePrincipalId: 'psp-1' }, { MCP_TIER3_INTENTS_ENABLED: 'true' }],
  ];

  it.each(PRINCIPALS)('%s: no named tool outside the listable set', async (_label, context, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    harnessState.context = context;
    for (const era of ['legacy', 'modern'] as const) {
      const { text, catalog } = await instructionsAndCatalog(era);
      expect(namedTools(text).filter((t) => !catalog.has(t)), era).toEqual([]);
      for (const meta of META_TOOLS) expect(text).toContain(meta);
    }
  });

  it('intents on, caller owns none: neither get_action_status nor cancel_action is named', async () => {
    vi.stubEnv('MCP_TIER3_INTENTS_ENABLED', 'true');
    harnessState.context = { ...UNRESTRICTED_KEY, orgId: null, partnerServicePrincipalId: 'psp-1' };
    const { text } = await instructionsAndCatalog('legacy');
    expect(text).not.toContain('get_action_status');
    expect(text).not.toContain('cancel_action');
  });

  it('a core+devices grant names no other domain', async () => {
    harnessState.context = { ...UNRESTRICTED_KEY, mcpDomains: ['devices'] };
    const { text } = await instructionsAndCatalog('legacy');
    for (const domain of AI_TOOL_DOMAINS) {
      const line = `- **${AI_TOOL_DOMAIN_LABELS[domain]}**:`;
      if (domain === 'core' || domain === 'devices') expect(text, domain).toContain(line);
      else expect(text, domain).not.toContain(line);
    }
  });

  it('carries the recipe and the untrusted-output rule verbatim, and no tool count', async () => {
    const { text } = await instructionsAndCatalog('legacy');
    expect(text).toContain('Start with search_tools({ query }) to find a tool, get_tool_details({ names }) to read its schema, then call_tool({ name, arguments }) or call the tool by name.');
    expect(text).toContain(UNTRUSTED_TOOL_OUTPUT_RULE);
    expect(text).not.toMatch(/~\d+ tools/);
  });

  it('≤ 4096 UTF-8 bytes with every flag on, for the unrestricted principal', async () => {
    for (const [k, v] of Object.entries(ALL_FLAGS_ON)) vi.stubEnv(k, v);
    for (const era of ['legacy', 'modern'] as const) {
      const { text } = await instructionsAndCatalog(era);
      expect(bytes(text), era).toBeLessThanOrEqual(4096);
    }
  });

  it('full instructions are unchanged', async () => {
    expect((await mcp.initialize()).response.body.result.instructions).toBe(MCP_SERVER_INSTRUCTIONS);
  });
});
