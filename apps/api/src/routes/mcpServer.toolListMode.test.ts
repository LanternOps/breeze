/**
 * #12427 W01 T2: the tool list mode is resolved once per request, from that
 * request only, and a contradictory or misspelt override is refused.
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
import { createMcpHarness, harnessState, resetHarnessState } from './__tests__/mcpServerToolList.testHarness';

const mcp = createMcpHarness(mcpServerRoutes, harnessState.writeAuditEvent);
const PROGRESSIVE = { headers: { 'Mcp-Tool-List': 'progressive' } };
const WHOAMI = { name: 'whoami', arguments: {} };
const whoamiMode = (res: { body: any }) => res.body.result.structuredContent.toolListMode;

beforeEach(() => {
  resetHarnessState();
  process.env.MCP_STATELESS_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.MCP_STATELESS_ENABLED;
  delete process.env.MCP_TOOL_LIST_DEFAULT;
});

describe('refusals', () => {
  it('modern: header full + _meta progressive → -32602 tool_list_mode_conflict, audited as a failed tools/list', async () => {
    const res = await mcp.modern('tools/list', undefined, { headers: { 'Mcp-Tool-List': 'full' }, meta: { 'app.breeze/toolList': 'progressive' } });
    expect(res.body.error).toEqual({ code: -32602, message: 'Invalid params', data: { reason: 'tool_list_mode_conflict' } });
    expect(res.requestAudits).toHaveLength(1);
    expect(res.requestAudits[0]).toMatchObject({ action: 'mcp.tools.list', result: 'failure', details: { method: 'tools/list' } });
  });

  it.each(['legacy', 'modern'] as const)('%s: header Progressive (case) → tool_list_mode_invalid', async (era) => {
    const res = await mcp[era]('tools/list', undefined, { headers: { 'Mcp-Tool-List': 'Progressive' } });
    expect(res.body.error).toEqual({ code: -32602, message: 'Invalid params', data: { reason: 'tool_list_mode_invalid' } });
    expect(res.requestAudits[0]).toMatchObject({ result: 'failure' });
  });

  it('modern: a non-string _meta value → tool_list_mode_invalid', async () => {
    const res = await mcp.modern('tools/list', undefined, { meta: { 'app.breeze/toolList': true } });
    expect(res.body.error.data).toEqual({ reason: 'tool_list_mode_invalid' });
  });

  it('a refused override refuses tools/call too: nothing runs', async () => {
    const res = await mcp.legacy('tools/call', { name: 'get_alert_summary', arguments: {} }, { headers: { 'Mcp-Tool-List': 'all' } });
    expect(res.body.error.data).toEqual({ reason: 'tool_list_mode_invalid' });
    expect(harnessState.executeTool).not.toHaveBeenCalled();
  });
});

describe('resolution', () => {
  it('whoami reports the deployment default with no override', async () => {
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI))).toEqual({ mode: 'full', source: 'deployment_default' });
    expect(whoamiMode(await mcp.modern('tools/call', WHOAMI))).toEqual({ mode: 'full', source: 'deployment_default' });
  });

  it.each(['legacy', 'modern'] as const)('%s: header progressive on tools/call whoami → progressive/request', async (era) => {
    expect(whoamiMode(await mcp[era]('tools/call', WHOAMI, PROGRESSIVE))).toEqual({ mode: 'progressive', source: 'request' });
  });

  it('modern: _meta progressive alone is an override; header and _meta agreeing is one override', async () => {
    const meta = { 'app.breeze/toolList': 'progressive' };
    expect(whoamiMode(await mcp.modern('tools/call', WHOAMI, { meta }))).toEqual({ mode: 'progressive', source: 'request' });
    expect(whoamiMode(await mcp.modern('tools/call', WHOAMI, { meta, ...PROGRESSIVE }))).toEqual({ mode: 'progressive', source: 'request' });
  });

  it('legacy era: params._meta toolList is ignored, even when it disagrees with the header', async () => {
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI, { meta: { 'app.breeze/toolList': 'progressive' } })))
      .toEqual({ mode: 'full', source: 'deployment_default' });
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI, { meta: { 'app.breeze/toolList': 'bogus' }, headers: { 'Mcp-Tool-List': 'full' } })))
      .toEqual({ mode: 'full', source: 'request' });
  });

  it('the override is not session-persisted: the next request on the same session resolves from the default', async () => {
    const { sessionId } = await mcp.initialize(PROGRESSIVE);
    const call = (headers: Record<string, string>) => Promise.resolve(mcp.app().request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': sessionId!, 'MCP-Protocol-Version': '2025-11-25', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: WHOAMI }),
    })).then(async (r: Response) => ((await r.json()) as any).result.structuredContent.toolListMode);
    expect(await call({ 'Mcp-Tool-List': 'progressive' })).toEqual({ mode: 'progressive', source: 'request' });
    expect(await call({})).toEqual({ mode: 'full', source: 'deployment_default' });
  });

  it('MCP_TOOL_LIST_DEFAULT=progressive with no header → progressive/deployment_default', async () => {
    process.env.MCP_TOOL_LIST_DEFAULT = 'progressive';
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI))).toEqual({ mode: 'progressive', source: 'deployment_default' });
  });

  it('a partner service principal key resolves full/credential under a progressive default, and may opt in per request', async () => {
    process.env.MCP_TOOL_LIST_DEFAULT = 'progressive';
    harnessState.context = { ...harnessState.context, orgId: null, partnerServicePrincipalId: 'psp-1' };
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI))).toEqual({ mode: 'full', source: 'credential' });
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI, PROGRESSIVE))).toEqual({ mode: 'progressive', source: 'request' });
  });
});

describe("the credential's stored mode (#12429)", () => {
  const storing = (mcpToolListMode: unknown) => { harnessState.context = { ...harnessState.context, mcpToolListMode }; };

  it.each(['legacy', 'modern'] as const)('%s: stored progressive with no override → progressive/credential', async (era) => {
    storing('progressive');
    expect(whoamiMode(await mcp[era]('tools/call', WHOAMI))).toEqual({ mode: 'progressive', source: 'credential' });
    const names = (await mcp[era]('tools/list')).body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search_tools', 'get_tool_details', 'call_tool']));
    expect(names).not.toContain('get_invite_funnel');
  });

  it('stored progressive: header full overrides it for that request', async () => {
    storing('progressive');
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI, { headers: { 'Mcp-Tool-List': 'full' } })))
      .toEqual({ mode: 'full', source: 'request' });
  });

  it('stored full ignores MCP_TOOL_LIST_DEFAULT=progressive (grandfathered), and may still opt in per request', async () => {
    process.env.MCP_TOOL_LIST_DEFAULT = 'progressive';
    storing('full');
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI))).toEqual({ mode: 'full', source: 'credential' });
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI, PROGRESSIVE))).toEqual({ mode: 'progressive', source: 'request' });
  });

  it('stored null follows the deployment default', async () => {
    storing(null);
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI))).toEqual({ mode: 'full', source: 'deployment_default' });
    process.env.MCP_TOOL_LIST_DEFAULT = 'progressive';
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI))).toEqual({ mode: 'progressive', source: 'deployment_default' });
  });

  it('a context missing the field resolves like null and logs once per request; a stored null logs nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = () => error.mock.calls.filter(([m]) => m === '[MCP] principal context missing mcpToolListMode').length;
    storing(null);
    await mcp.modern('tools/call', WHOAMI);
    expect(missing()).toBe(0);
    storing(undefined);
    expect(whoamiMode(await mcp.modern('tools/call', WHOAMI))).toEqual({ mode: 'full', source: 'deployment_default' });
    expect(missing()).toBe(1);
    error.mockRestore();
  });

  it('a stored mode does not soften a refusal: a misspelt header is still refused', async () => {
    storing('progressive');
    const res = await mcp.legacy('tools/list', undefined, { headers: { 'Mcp-Tool-List': 'Full' } });
    expect(res.body.error.data).toEqual({ reason: 'tool_list_mode_invalid' });
    expect(res.requestAudits[0]).toMatchObject({ result: 'failure' });
  });

  it('a partner service principal key is full even if a mode reached its context', async () => {
    process.env.MCP_TOOL_LIST_DEFAULT = 'progressive';
    harnessState.context = { ...harnessState.context, orgId: null, partnerServicePrincipalId: 'psp-1', mcpToolListMode: 'progressive' };
    expect(whoamiMode(await mcp.legacy('tools/call', WHOAMI))).toEqual({ mode: 'full', source: 'credential' });
  });

  it('initialize under a stored progressive reports it; under a stored full it is the same bytes as nothing stored', async () => {
    storing(null);
    const unset = (await mcp.initialize()).response.text;
    storing('full');
    expect((await mcp.initialize()).response.text).toBe(unset);
    storing('progressive');
    expect((await mcp.initialize()).response.body.result.toolListMode).toEqual({ mode: 'progressive', source: 'credential' });
  });
});

describe('reporting in initialize and server/discover', () => {
  it('initialize carries toolListMode only when progressive', async () => {
    expect((await mcp.initialize()).response.body.result).not.toHaveProperty('toolListMode');
    expect((await mcp.initialize(PROGRESSIVE)).response.body.result.toolListMode).toEqual({ mode: 'progressive', source: 'request' });
  });

  it('server/discover carries toolListMode only when progressive', async () => {
    expect((await mcp.modern('server/discover')).body.result).not.toHaveProperty('toolListMode');
    expect((await mcp.modern('server/discover', undefined, PROGRESSIVE)).body.result.toolListMode)
      .toEqual({ mode: 'progressive', source: 'request' });
  });
});

describe('envelope classification stays on the outer request', () => {
  it('modern call_tool: Mcp-Name call_tool passes classification; Mcp-Name <inner> is MCP_HEADER_MISMATCH', async () => {
    const params = { name: 'call_tool', arguments: { name: 'get_alert_summary', arguments: {} } };
    const outer = await mcp.modern('tools/call', params);
    expect(outer.status).toBe(200);
    expect(outer.body.error?.code).not.toBe(-32020);
    const inner = await mcp.modern('tools/call', params, { mcpName: 'get_alert_summary' });
    expect(inner.status).toBe(400);
    expect(inner.body.error.code).toBe(-32020);
  });
});
