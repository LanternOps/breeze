/**
 * #12427 W01 T2: the tool list mode is resolved once per request, from that
 * request only, and a contradictory or misspelt override is refused.
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

import { mcpServerRoutes } from './mcpServer';
import { createMcpHarness, harnessState, resetHarnessState } from './mcpServerToolList.testHarness';

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
    const call = (headers: Record<string, string>) => mcp.app().request('/mcp/sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': sessionId!, 'MCP-Protocol-Version': '2025-11-25', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: WHOAMI }),
    }).then(async (r) => (await r.json()).result.structuredContent.toolListMode);
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

describe('T2-temporary', () => {
  it('T2-temporary: progressive still lists full', async () => {
    const full = await mcp.legacy('tools/list');
    const progressive = await mcp.legacy('tools/list', undefined, PROGRESSIVE);
    expect(progressive.body.result).toEqual(full.body.result);
  });
});
