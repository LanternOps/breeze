/**
 * #12427 W01 T6: call_tool is a dispatcher, not a tool. The inner call IS a
 * direct tools/call (every gate on the inner name), and the one request audit
 * row names the real tool.
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
// One extra deprecated alias that resolves to a meta-tool, to prove the
// meta-target refusal runs after canonicalization.
vi.mock('../services/aiToolAliases', async (orig) => {
  const actual = await orig<typeof import('../services/aiToolAliases')>();
  return { ...actual, resolveDeprecatedToolAlias: (name: string) => (name === 'find_tools' ? 'search_tools' : actual.resolveDeprecatedToolAlias(name)) };
});

import { mcpServerRoutes } from './mcpServer';
import { createMcpHarness, harnessState, resetHarnessState, UNRESTRICTED_KEY } from './mcpServerToolList.testHarness';

const mcp = createMcpHarness(mcpServerRoutes, harnessState.writeAuditEvent);
const wrap = (name: string, args: Record<string, unknown> = {}) => ({ name: 'call_tool', arguments: { name, arguments: args } });
const META_KEYS = ['metaTool', 'toolName', 'requestedToolName', 'toolIsError'];
const audit = (res: { requestAudits: Array<Record<string, any>> }) => {
  expect(res.requestAudits).toHaveLength(1);
  return res.requestAudits[0]!.details as Record<string, unknown>;
};

beforeEach(() => {
  resetHarnessState();
  process.env.MCP_STATELESS_ENABLED = 'true';
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env.MCP_STATELESS_ENABLED;
});

describe('dispatch', () => {
  it.each(['legacy', 'modern'] as const)('%s: call_tool → get_alert_summary returns the direct call\'s result', async (era) => {
    harnessState.executeTool.mockResolvedValue(JSON.stringify({ alerts: 3 }));
    const direct = await mcp[era]('tools/call', { name: 'get_alert_summary', arguments: { severity: 'high' } });
    const wrapped = await mcp[era]('tools/call', wrap('get_alert_summary', { severity: 'high' }));
    expect(wrapped.status).toBe(direct.status);
    expect(wrapped.body).toEqual(direct.body);
    expect(harnessState.executeTool).toHaveBeenNthCalledWith(2, 'get_alert_summary', { severity: 'high' });
  });

  it('an inner alias dispatches as the canonical name; the warning names the alias; the row carries both', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await mcp.legacy('tools/call', wrap('get_fleet_status'));
    expect(res.body.result.isError).toBeUndefined();
    expect(harnessState.executeTool).toHaveBeenCalledWith('get_invite_funnel', {});
    expect(warn.mock.calls.some((call) => String(call[0]).includes('"get_fleet_status"'))).toBe(true);
    expect(audit(res)).toMatchObject({ metaTool: 'call_tool', toolName: 'get_invite_funnel', requestedToolName: 'get_fleet_status' });
  });

  it.each(['call_tool', 'search_tools', 'get_tool_details', 'find_tools'])('inner %s → -32602 meta_tool_target', async (inner) => {
    const res = await mcp.legacy('tools/call', wrap(inner, { query: 'x' }));
    expect(res.body.error).toEqual({ code: -32602, message: 'Invalid params', data: { reason: 'meta_tool_target' } });
  });

  it('a direct search_tools stays callable (the refusal is surface-dependent)', async () => {
    const res = await mcp.legacy('tools/call', { name: 'search_tools', arguments: { query: 'alerts' } });
    expect(res.body.result.structuredContent.tools.length).toBeGreaterThan(0);
  });

  it.each([
    [{ name: 'call_tool' }], [{ name: 'call_tool', arguments: { arguments: {} } }], [{ name: 'call_tool', arguments: { name: 'x', arguments: [] } }],
  ])('bad wrapper arguments %j → -32602 invalid_call_tool_arguments, audited as a call_tool failure', async (params) => {
    const res = await mcp.legacy('tools/call', params);
    expect(res.body.error).toEqual({ code: -32602, message: 'Invalid params', data: { reason: 'invalid_call_tool_arguments' } });
    expect(audit(res)).toMatchObject({ metaTool: 'call_tool' });
    expect(res.requestAudits[0]!.result).toBe('failure');
  });

  it('inner tool outside the grant → -32003, and the row\'s canonicalTool is the inner name', async () => {
    harnessState.context = { ...UNRESTRICTED_KEY, mcpDomains: ['devices'] };
    const res = await mcp.legacy('tools/call', wrap('get_alert_summary'));
    expect(res.body.error.code).toBe(-32003);
    expect(audit(res)).toMatchObject({ canonicalTool: 'get_alert_summary', domain: 'monitoring', deniedReason: 'domain_not_granted', metaTool: 'call_tool' });
  });

  it('inner unknown tool → -32602 Unknown tool', async () => {
    expect((await mcp.legacy('tools/call', wrap('no_such_tool'))).body.error).toEqual({ code: -32602, message: 'Unknown tool: no_such_tool' });
  });

  it('a direct call to an unlisted real name in progressive mode works (OD-5 A)', async () => {
    const res = await mcp.legacy('tools/call', { name: 'get_alert_summary', arguments: {} }, { headers: { 'Mcp-Tool-List': 'progressive' } });
    expect(res.body.result.isError).toBeUndefined();
    expect(harnessState.executeTool).toHaveBeenCalledWith('get_alert_summary', {});
  });

  it('a Tier 3 inner call meets the approval gate exactly as a direct call does', async () => {
    const direct = await mcp.legacy('tools/call', { name: 'reboot_device', arguments: {} });
    const wrapped = await mcp.legacy('tools/call', wrap('reboot_device'));
    expect(wrapped.body).toEqual(direct.body);
    expect(JSON.stringify(direct.body)).toContain('MCP_APPROVAL_REQUIRED');
    expect(harnessState.executeTool).not.toHaveBeenCalled();
  });
});

describe('the request audit row', () => {
  it('wrapped: metaTool call_tool and the inner toolName; a successful direct call carries none of the four keys', async () => {
    expect(audit(await mcp.legacy('tools/call', wrap('get_alert_summary')))).toMatchObject({ metaTool: 'call_tool', toolName: 'get_alert_summary' });
    const direct = audit(await mcp.legacy('tools/call', { name: 'get_alert_summary', arguments: {} }));
    for (const key of META_KEYS) expect(direct, key).not.toHaveProperty(key);
  });

  it('toolIsError for a wrapped and a direct isError result; a direct one carries only toolIsError', async () => {
    harnessState.executeTool.mockResolvedValue(JSON.stringify({ error: 'boom' }));
    const wrapped = await mcp.legacy('tools/call', wrap('get_alert_summary'));
    expect(wrapped.body.result.isError).toBe(true);
    expect(audit(wrapped)).toMatchObject({ metaTool: 'call_tool', toolName: 'get_alert_summary', toolIsError: true });
    const direct = audit(await mcp.legacy('tools/call', { name: 'get_alert_summary', arguments: {} }));
    expect(direct.toolIsError).toBe(true);
    for (const key of ['metaTool', 'toolName', 'requestedToolName']) expect(direct, key).not.toHaveProperty(key);
  });

  it('the inner name is bounded on the row', async () => {
    const res = await mcp.legacy('tools/call', wrap('x'.repeat(128)));
    expect(String(audit(res).toolName).length).toBeLessThanOrEqual(129);
  });

  it('the MCP Apps counter counts the inner name', async () => {
    vi.stubEnv('MCP_APPS_ENABLED', 'true');
    expect(audit(await mcp.legacy('tools/call', wrap('get_fleet_health')))).toMatchObject({ mcpApp: 'fleet-health/v1', toolName: 'get_fleet_health' });
  });

  it('one request row and one tool-execution row, the same as a direct call', async () => {
    const direct = await mcp.legacy('tools/call', { name: 'get_alert_summary', arguments: {} });
    const wrapped = await mcp.legacy('tools/call', wrap('get_alert_summary'));
    expect(wrapped.requestAudits).toHaveLength(1);
    expect(wrapped.toolAudits.length).toBe(direct.toolAudits.length);
    expect(wrapped.toolAudits.map((r) => r.action)).toEqual(direct.toolAudits.map((r) => r.action));
  });
});

describe('rate limits', () => {
  it('11 wrapped calls of one tool under a limit of 10: the 11th is -32000, keyed on the inner name', async () => {
    let count = 0;
    harnessState.checkToolRateLimit.mockImplementation(async () => (++count > 10 ? 'Rate limit exceeded for get_alert_summary' : null));
    let last: Awaited<ReturnType<typeof mcp.legacy>> | undefined;
    for (let i = 0; i < 11; i++) last = await mcp.legacy('tools/call', wrap('get_alert_summary'));
    expect(last!.body.error).toEqual({ code: -32000, message: 'Rate limit exceeded for get_alert_summary' });
    expect(harnessState.checkToolRateLimit).toHaveBeenCalledTimes(11);
    for (const call of harnessState.checkToolRateLimit.mock.calls) expect(call[0]).toBe('get_alert_summary');
  });
});

describe('the pre-auth DB-context classifier', () => {
  const flag = async (params: Record<string, unknown>) => {
    harnessState.observedSkipFlags = [];
    await mcp.legacy('tools/call', params);
    // [initialize, the call]
    return harnessState.observedSkipFlags.at(-1);
  };
  it('call_tool wrapping a tenant tool → true', async () => {
    expect(await flag(wrap('acme__lookup_widget'))).toBe(true);
    expect(await flag({ name: 'acme__lookup_widget', arguments: {} })).toBe(true);
  });
  it('call_tool wrapping a self-managed-context tool → true', async () => {
    expect(await flag(wrap('propose_script', { deviceIds: [] }))).toBe(true);
  });
  it('call_tool wrapping query_devices → false; a bad wrapper → false', async () => {
    expect(await flag(wrap('query_devices'))).toBe(false);
    expect(await flag({ name: 'call_tool', arguments: { name: 7 } })).toBe(false);
  });
});
