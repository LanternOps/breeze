/**
 * #12427 W01 T7: approval continuations and Tasks through call_tool.
 *
 * A wrapped Tier 3 call's sealed state binds to the REAL tool and arguments
 * (so a client retrying the wrapper verbatim continues) and to the surface
 * that issued it (so a state cannot move between a direct and a wrapped retry).
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
vi.mock('../services/toolSources/execute', async (orig) => (await import('./__tests__/mcpServerToolList.testHarness')).tenantExecuteMock(orig as never));
vi.mock('../services/toolSources/guardrails', async (orig) => (await import('./__tests__/mcpServerToolList.testHarness')).tenantGuardrailsMock(orig as never));
vi.mock('../services/rate-limit', async () => (await import('./__tests__/mcpServerToolList.testHarness')).rateLimitMock());
const intentMocks = vi.hoisted(() => ({ createMcpActionIntent: vi.fn(), loadOwnedMcpIntent: vi.fn(), countLiveMcpIntentsForOrigin: vi.fn(async (..._a: unknown[]) => 0), cancelOwnedMcpIntent: vi.fn() }));
vi.mock('../services/mcpIntentCreation', () => ({
  createMcpActionIntent: (...a: unknown[]) => intentMocks.createMcpActionIntent(...a),
  loadOwnedMcpIntent: (...a: unknown[]) => intentMocks.loadOwnedMcpIntent(...a),
  countLiveMcpIntentsForOrigin: (...a: unknown[]) => intentMocks.countLiveMcpIntentsForOrigin(...a),
  cancelOwnedMcpIntent: (...a: unknown[]) => intentMocks.cancelOwnedMcpIntent(...a),
  resolveMcpClientLabel: vi.fn(async () => 'MCP · test'),
}));
const waits = vi.hoisted(() => ({ waitForIntentTerminalOutcome: vi.fn(async () => null) }));
vi.mock('../services/actionIntents/intentService', () => ({
  waitForIntentTerminalOutcome: (...a: unknown[]) => (waits.waitForIntentTerminalOutcome as (...x: unknown[]) => unknown)(...a),
}));

import { mcpServerRoutes } from './mcpServer';
import { createMcpHarness, harnessState, resetHarnessState, UNRESTRICTED_KEY } from './__tests__/mcpServerToolList.testHarness';
import { mcpRequestStateKey, openMcpRequestState, sealMcpRequestState } from '../services/mcpRequestState';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';

const mcp = createMcpHarness(mcpServerRoutes, harnessState.writeAuditEvent);
const ID = '77777777-7777-4777-8777-777777777777';
const ARGS = { deviceId: 'd1' };
const URL_CAPS = { elicitation: { url: {} } };
const TASK_CAPS = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
const REF = `api_key:${UNRESTRICTED_KEY.id}`;
const wrap = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ name: 'call_tool', arguments: { name, arguments: args }, ...extra });

function intentRow(status: string) {
  return {
    id: ID, status, actionName: 'run_widget_job', approvalScope: 'four_eyes',
    createdAt: new Date('2026-10-24T10:00:00.000Z'), expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    decidedAt: null, executionStartedAt: null, executedAt: null, statusChangedAt: new Date('2026-10-24T10:00:01.000Z'),
    result: null, errorCode: null,
  };
}

async function firstCall(surface: 'direct' | 'call_tool', args = ARGS): Promise<string> {
  const params = surface === 'direct' ? { name: 'run_widget_job', arguments: args } : wrap('run_widget_job', args);
  const res = await mcp.modern('tools/call', params, { clientCapabilities: URL_CAPS });
  expect(res.body.result.resultType).toBe('input_required');
  return res.body.result.requestState as string;
}

function retry(surface: 'direct' | 'call_tool', state: string, opts: { name?: string; args?: Record<string, unknown>; action?: string } = {}) {
  const name = opts.name ?? 'run_widget_job';
  const args = opts.args ?? ARGS;
  const continuation = { requestState: state, inputResponses: { breeze_approval: { action: opts.action ?? 'accept' } } };
  const params = surface === 'direct' ? { name, arguments: args, ...continuation } : wrap(name, args, continuation);
  return mcp.modern('tools/call', params, { clientCapabilities: URL_CAPS });
}

const INVALID_STATE = { code: -32602, message: 'Invalid params', data: { reason: 'invalid_request_state' } };

beforeEach(() => {
  resetHarnessState();
  harnessState.catalog = { ...harnessState.catalog, run_widget_job: { tier: 3, domain: 'devices' } };
  process.env.MCP_STATELESS_ENABLED = 'true';
  vi.stubEnv('MCP_TIER3_INTENTS_ENABLED', 'true');
  intentMocks.createMcpActionIntent.mockReset().mockResolvedValue({
    kind: 'pending', isNew: true,
    status: {
      actionId: ID, status: 'pending_approval', toolName: 'run_widget_job', approvalScope: 'four_eyes',
      expiresAt: '2027-01-01T00:00:00.000Z', approvalUrl: `https://app.example.com/approvals#intent-${ID}`,
    },
  });
  intentMocks.loadOwnedMcpIntent.mockReset().mockResolvedValue(intentRow('pending_approval'));
  waits.waitForIntentTerminalOutcome.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.MCP_STATELESS_ENABLED;
});

describe('the sealed surface byte', () => {
  it('a direct call seals w 0, a wrapped call w 1; both bind the real tool and argument digest', async () => {
    const open = (state: string) => {
      const opened = openMcpRequestState(state, mcpRequestStateKey(), Math.floor(Date.now() / 1000));
      if (!opened.ok) throw new Error('unopenable');
      return opened.payload;
    };
    const digest = computeArgumentDigest(canonicalizeArguments(ARGS));
    expect(open(await firstCall('direct'))).toMatchObject({ t: 'run_widget_job', d: digest, w: 0, p: REF });
    expect(open(await firstCall('call_tool'))).toMatchObject({ t: 'run_widget_job', d: digest, w: 1, p: REF });
  });

  it('the elicitation names the real tool, never call_tool', async () => {
    const res = await mcp.modern('tools/call', wrap('run_widget_job', ARGS), { clientCapabilities: URL_CAPS });
    expect(JSON.stringify(res.body.result.inputRequests)).not.toContain('call_tool');
    expect(intentMocks.createMcpActionIntent.mock.calls[0]![0]).toMatchObject({ toolName: 'run_widget_job', toolInput: ARGS });
  });
});

describe('retries', () => {
  it('a wrapper retry with the same inner name and arguments → the same status body a direct retry gets', async () => {
    const direct = await retry('direct', await firstCall('direct'));
    const wrapped = await retry('call_tool', await firstCall('call_tool'));
    expect(direct.body.result.structuredContent).toMatchObject({ status: 'pending_approval', actionId: ID });
    expect(wrapped.body).toEqual(direct.body);
    expect(waits.waitForIntentTerminalOutcome).toHaveBeenCalledTimes(2);
  });

  it('a wrapper retry with a changed inner argument → invalid_request_state', async () => {
    expect((await retry('call_tool', await firstCall('call_tool'), { args: { deviceId: 'd2' } })).body.error).toEqual(INVALID_STATE);
  });

  it('a wrapper retry with a different inner name → invalid_request_state', async () => {
    harnessState.catalog = { ...harnessState.catalog, run_other_job: { tier: 3, domain: 'devices' } };
    expect((await retry('call_tool', await firstCall('call_tool'), { name: 'run_other_job' })).body.error).toEqual(INVALID_STATE);
  });

  it('a direct retry of a state issued through call_tool → invalid_request_state', async () => {
    expect((await retry('direct', await firstCall('call_tool'))).body.error).toEqual(INVALID_STATE);
  });

  it('a wrapper retry of a state issued to a direct call → invalid_request_state', async () => {
    expect((await retry('call_tool', await firstCall('direct'))).body.error).toEqual(INVALID_STATE);
  });

  it('a state sealed before the surface byte existed opens on a direct retry only', async () => {
    const legacyState = sealMcpRequestState({
      a: ID, p: REF, m: 'tools/call', t: 'run_widget_job', d: computeArgumentDigest(canonicalizeArguments(ARGS)),
    } as never, mcpRequestStateKey(), Math.floor(Date.now() / 1000));
    expect(openMcpRequestState(legacyState, mcpRequestStateKey(), Math.floor(Date.now() / 1000))).toMatchObject({ ok: true });
    expect((openMcpRequestState(legacyState, mcpRequestStateKey(), Math.floor(Date.now() / 1000)) as { payload: Record<string, unknown> }).payload).not.toHaveProperty('w');
    expect((await retry('direct', legacyState)).body.result.structuredContent).toMatchObject({ actionId: ID });
    expect((await retry('call_tool', legacyState)).body.error).toEqual(INVALID_STATE);
  });

  it('an expired wrapped state → request_state_expired only on its own surface with matching bindings', async () => {
    const past = Math.floor(Date.now() / 1000) - 10_000;
    const expired = sealMcpRequestState({
      a: ID, p: REF, m: 'tools/call', t: 'run_widget_job', d: computeArgumentDigest(canonicalizeArguments(ARGS)), w: 1,
    }, mcpRequestStateKey(), past);
    expect((await retry('call_tool', expired)).body.error).toEqual({ code: -32602, message: 'Invalid params', data: { reason: 'request_state_expired', actionId: ID } });
    expect((await retry('direct', expired)).body.error).toEqual(INVALID_STATE);
    expect((await retry('call_tool', expired, { args: { deviceId: 'd2' } })).body.error).toEqual(INVALID_STATE);
  });

  it('the meta-tool-target refusal runs before the continuation branch', async () => {
    const state = await firstCall('call_tool');
    const res = await mcp.modern('tools/call', wrap('search_tools', { query: 'x' }, { requestState: state }), { clientCapabilities: URL_CAPS });
    expect(res.body.error.data).toEqual({ reason: 'meta_tool_target' });
  });
});

describe('Tasks through call_tool', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_TASKS_ENABLED', 'true');
  });

  it('a task created through call_tool is read, updated and cancelled by id, and its request row carries taskResult', async () => {
    const created = await mcp.modern('tools/call', wrap('run_widget_job', ARGS), { clientCapabilities: TASK_CAPS });
    expect(created.body.result).toMatchObject({ resultType: 'task', taskId: ID });
    expect(created.requestAudits[0]!.details).toMatchObject({ taskResult: true, metaTool: 'call_tool', toolName: 'run_widget_job' });
    const get = await mcp.modern('tasks/get', { taskId: ID }, { clientCapabilities: TASK_CAPS });
    expect(get.body.result).toMatchObject({ taskId: ID });
    const update = await mcp.modern('tasks/update', { taskId: ID, inputResponses: {} }, { clientCapabilities: TASK_CAPS });
    expect(update.body).toMatchObject({ result: {} });
    intentMocks.cancelOwnedMcpIntent.mockResolvedValue({ kind: 'cancelled', status: { actionId: ID, status: 'cancelled' } });
    const cancel = await mcp.modern('tasks/cancel', { taskId: ID }, { clientCapabilities: TASK_CAPS });
    expect(cancel.body).toMatchObject({ result: {} });
    expect(intentMocks.cancelOwnedMcpIntent).toHaveBeenCalledWith(expect.anything(), ID, expect.anything());
    const direct = await mcp.modern('tools/call', { name: 'run_widget_job', arguments: ARGS }, { clientCapabilities: TASK_CAPS });
    expect(direct.body.result).toEqual(created.body.result);
  });
});
