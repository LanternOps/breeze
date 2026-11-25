import { describe, expect, it } from 'vitest';
import './aiTools';
import { buildMcpToolPresentation } from './mcpToolPresentation';
import { mcpToolDomain } from './mcpDomains';
import {
  MCP_CALL_TOOL_LIST_ENTRY,
  MCP_GET_TOOL_DETAILS_LIST_ENTRY,
  MCP_META_TOOL_DEFINITIONS,
  MCP_SEARCH_TOOLS_LIST_ENTRY,
  handleGetToolDetails,
  handleSearchTools,
  unwrapCallToolRequest,
  type McpToolListEntry,
} from './mcpMetaTools';

const entry = (name: string, domain: string, description: string, extra: Partial<McpToolListEntry> = {}): McpToolListEntry => ({
  title: name, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { 'app.breeze/domain': domain }, name, description, inputSchema: { type: 'object', properties: {} }, ...extra,
});
const CATALOG: McpToolListEntry[] = [
  entry('query_devices', 'core', 'Search devices by name, OS, status or site.'),
  entry('manage_alerts', 'monitoring', 'Query, view, acknowledge, resolve, or suppress alerts. (Actions "suppress" require approval.)'),
  entry('manage_patches', 'patching', 'List, approve and install patches.'),
  entry('acme__lookup_widget', 'integrations', 'Look up a widget.'),
];
const NOTES = new Map([['manage_alerts', '(Actions "suppress" require approval.)']]);
const rows = (o: ReturnType<typeof handleSearchTools>) => ('result' in o ? (o.result.structuredContent as { tools: Array<Record<string, unknown>> }).tools : null);
const invalid = { error: { code: -32602, message: 'Invalid params', data: { reason: 'invalid_arguments' } } };

describe('list entries', () => {
  it('search_tools and get_tool_details equal buildMcpToolPresentation(def, 1, core) (the whoami pattern)', () => {
    const [search, details] = MCP_META_TOOL_DEFINITIONS;
    for (const [def, listed] of [[search, MCP_SEARCH_TOOLS_LIST_ENTRY], [details, MCP_GET_TOOL_DETAILS_LIST_ENTRY]] as const) {
      expect(listed).toEqual({ ...buildMcpToolPresentation(def, 1, 'core'), name: def.name, description: def.description, inputSchema: def.input_schema });
    }
  });
  it('call_tool: title and domain from the shared presentation; annotations claim the worst case', () => {
    const def = MCP_META_TOOL_DEFINITIONS[2];
    const presentation = buildMcpToolPresentation(def, 1, 'core');
    expect(MCP_CALL_TOOL_LIST_ENTRY.title).toBe(presentation.title);
    expect(MCP_CALL_TOOL_LIST_ENTRY._meta).toEqual(presentation._meta);
    expect(MCP_CALL_TOOL_LIST_ENTRY.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
  it('mcpToolDomain is core for all three', () => {
    for (const name of ['search_tools', 'get_tool_details', 'call_tool']) expect(mcpToolDomain(name)).toBe('core');
  });
});

describe('handleSearchTools', () => {
  it.each([
    [{ query: 'alerts', limit: 0 }], [{ query: 'alerts', limit: 21 }], [{ query: 'alerts', limit: '8' }], [{ query: 'alerts', limit: 1.5 }],
    [{ query: '' }], [{ query: '   ' }], [{}], [null], [[]], [{ query: 'x'.repeat(201) }], [{ query: 'alerts', domain: 'nope' }],
    [{ query: 'alerts', extra: true }],
  ])('%j → Invalid params', (input) => {
    expect(handleSearchTools(CATALOG, input, NOTES)).toEqual(invalid);
  });
  it('default limit 8; domain filter restricts rows', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`list_widget_${i}`, 'admin', 'List widgets.'));
    expect(rows(handleSearchTools(many, { query: 'widgets' }, new Map()))).toHaveLength(8);
    expect(rows(handleSearchTools(many, { query: 'widgets', limit: 20 }, new Map()))).toHaveLength(12);
    expect(rows(handleSearchTools(CATALOG, { query: 'alerts patches devices', domain: 'patching' }, NOTES))!.map((r) => r.name)).toEqual(['manage_patches']);
  });
  it('an exact name is pinned first', () => {
    expect(rows(handleSearchTools(CATALOG, { query: 'manage_patches' }, NOTES))![0]!.name).toBe('manage_patches');
  });
  it('rows carry name, title, domain, hint, tier, readOnly; approvalNote only with a suffix', () => {
    const [alerts] = rows(handleSearchTools(CATALOG, { query: 'acknowledge alerts' }, NOTES))!;
    expect(alerts).toMatchObject({ name: 'manage_alerts', title: 'manage_alerts', domain: 'monitoring', readOnly: true, approvalNote: '(Actions "suppress" require approval.)' });
    expect(Object.keys(alerts!)).toEqual(['name', 'title', 'domain', 'hint', 'tier', 'readOnly', 'approvalNote']);
    const [patches] = rows(handleSearchTools(CATALOG, { query: 'manage_patches' }, NOTES))!;
    expect(patches).not.toHaveProperty('approvalNote');
    const [widget] = rows(handleSearchTools(CATALOG, { query: 'widget' }, NOTES))!;
    expect(widget).toMatchObject({ name: 'acme__lookup_widget', hint: null, tier: null });
  });
  it('the text block is the JSON of structuredContent', () => {
    const out = handleSearchTools(CATALOG, { query: 'alerts' }, NOTES);
    if (!('result' in out)) throw new Error('expected a result');
    expect(JSON.parse((out.result.content as Array<{ text: string }>)[0]!.text)).toEqual(out.result.structuredContent);
  });
  it('never names a tool outside the catalog', () => {
    const named = rows(handleSearchTools(CATALOG, { query: 'tickets invoices backups devices alerts', limit: 20 }, NOTES))!.map((r) => r.name);
    expect(named.every((n) => CATALOG.some((e) => e.name === n))).toBe(true);
  });
});

describe('handleGetToolDetails', () => {
  it.each([[{}], [{ names: [] }], [{ names: Array.from({ length: 11 }, (_, i) => `t${i}`) }], [{ names: [1] }], [{ names: 'query_devices' }], [{ names: [''] }]])('%j → Invalid params', (input) => {
    expect(handleGetToolDetails(CATALOG, input)).toEqual(invalid);
  });
  it('listed names → their catalog entries, in request order', () => {
    const out = handleGetToolDetails(CATALOG, { names: ['manage_patches', 'query_devices', 'acme__lookup_widget'] });
    if (!('result' in out)) throw new Error('expected a result');
    const tools = (out.result.structuredContent as { tools: McpToolListEntry[] }).tools;
    expect(tools).toEqual([CATALOG[2], CATALOG[0], CATALOG[3]]);
    expect(JSON.parse((out.result.content as Array<{ text: string }>)[0]!.text)).toEqual({ tools });
  });
  it('a name outside the catalog → isError Unknown tool, no partial details; the same shape whatever the reason', () => {
    const shape = (name: string) => handleGetToolDetails(CATALOG, { names: ['query_devices', name] });
    for (const name of ['manage_tickets', 'execute_command', 'made_up_tool']) {
      expect(shape(name)).toEqual({ result: { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] } });
    }
  });
  it('a long unknown name is bounded in the error', () => {
    const out = handleGetToolDetails(CATALOG, { names: ['x'.repeat(128)] });
    expect(JSON.stringify(out)).not.toContain('x'.repeat(129));
  });
});

describe('unwrapCallToolRequest', () => {
  it('a non-call_tool request is not wrapped', () => {
    const params = { name: 'query_devices', arguments: {} };
    expect(unwrapCallToolRequest(params)).toEqual({ wrapped: false, params });
    expect(unwrapCallToolRequest(undefined)).toEqual({ wrapped: false, params: undefined });
  });
  it('unwraps the inner call and carries the outer requestState / inputResponses', () => {
    expect(unwrapCallToolRequest({ name: 'call_tool', arguments: { name: 'x', arguments: { a: 1 } }, requestState: 's', inputResponses: { r: 1 } }))
      .toEqual({ wrapped: true, params: { name: 'x', arguments: { a: 1 }, requestState: 's', inputResponses: { r: 1 } } });
  });
  it('missing inner arguments are {} (a direct call defaults the same way)', () => {
    expect(unwrapCallToolRequest({ name: 'call_tool', arguments: { name: 'x' } })).toEqual({ wrapped: true, params: { name: 'x', arguments: {} } });
  });
  it.each([
    [{ name: 'call_tool' }], [{ name: 'call_tool', arguments: null }], [{ name: 'call_tool', arguments: { arguments: {} } }],
    [{ name: 'call_tool', arguments: { name: '' } }], [{ name: 'call_tool', arguments: { name: 7 } }],
    [{ name: 'call_tool', arguments: { name: 'x', arguments: [] } }], [{ name: 'call_tool', arguments: { name: 'x', arguments: 'a=1' } }],
    [{ name: 'call_tool', arguments: { name: 'x', arguments: null } }], [{ name: 'call_tool', arguments: { name: 'x'.repeat(129) } }],
  ])('%j → invalid', (params) => {
    expect(unwrapCallToolRequest(params as never)).toEqual({ wrapped: true, invalid: 'invalid_call_tool_arguments' });
  });
  it('only the exact outer name is a wrapper', () => {
    expect(unwrapCallToolRequest({ name: 'Call_Tool', arguments: { name: 'x' } }).wrapped).toBe(false);
  });
});
