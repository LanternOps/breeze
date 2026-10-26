import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

vi.mock('./flows/service', () => ({ saveDraftFlow: vi.fn(), getFlow: vi.fn(), listFlows: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./flows/owner', () => ({ resolveFlowOwnerForCaller: vi.fn() }));
vi.mock('./flowValidator', () => ({ validateFlowDocument: vi.fn() }));
// The cap below is a stand-in with the real contract (runService.test.ts pins
// the real one): over 4 KB serialized becomes { truncated: true }.
vi.mock('./flows/runService', () => ({
  startManualRun: vi.fn(),
  listFlowRuns: vi.fn(),
  getFlowRun: vi.fn(),
  cancelFlowRun: vi.fn(),
  capFlowRunToolOutput: (v: unknown) => (Buffer.byteLength(JSON.stringify(v) ?? 'null') > 4096 ? { truncated: true, preview: '' } : v),
}));

import { getFlow, listFlows, saveDraftFlow } from './flows/service';
import { resolveFlowOwnerForCaller } from './flows/owner';
import { validateFlowDocument } from './flowValidator';
import { cancelFlowRun, capFlowRunToolOutput, getFlowRun, listFlowRuns, startManualRun } from './flows/runService';
import { FLOW_TOOL_NAMES, registerFlowTools } from './aiToolsFlows';
import { isToolEnvGatedOff } from './aiToolEnvGates';
import { captureException } from './sentry';

const FLOW_ID = '33333333-3333-4333-8333-333333333333';
const auth = { scope: 'organization', orgId: 'o', user: { id: 'u' } } as unknown as AuthContext;

function tools(): Map<string, AiTool> {
  const m = new Map<string, AiTool>();
  registerFlowTools(m);
  return m;
}
const call = (name: string, input: Record<string, unknown>) => tools().get(name)!.handler(input, auth).then((s) => JSON.parse(s));

describe('flow AI tools', () => {
  beforeEach(() => {
    vi.stubEnv('FLOWS_ENABLED', 'true');
    vi.mocked(saveDraftFlow).mockReset();
    vi.mocked(getFlow).mockReset();
    vi.mocked(listFlows).mockReset();
    vi.mocked(resolveFlowOwnerForCaller).mockReset();
    vi.mocked(validateFlowDocument).mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('registers exactly the four tools with their tiers and domain', () => {
    const m = tools();
    expect([...m.keys()].sort()).toEqual([...FLOW_TOOL_NAMES].sort());
    expect(FLOW_TOOL_NAMES).toEqual(expect.arrayContaining(['run_flow', 'list_flow_runs', 'get_flow_run', 'cancel_flow_run']));
    expect(m.get('draft_flow')!.tier).toBe(2);
    expect(m.get('cancel_flow_run')!.tier).toBe(2);
    expect(m.get('run_flow')!.tier).toBe(3);
    for (const n of ['validate_flow', 'get_flow', 'list_flows', 'list_flow_runs', 'get_flow_run']) expect(m.get(n)!.tier).toBe(1);
    for (const t of m.values()) {
      expect(t.domain).toBe('scripts');
      expect(t.deviceArgs).toEqual([]);
      expect(t.alwaysLoad).toBeUndefined();
    }
  });

  it('every handler returns flows_disabled with the flag off', async () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    for (const name of FLOW_TOOL_NAMES) {
      expect(await call(name, { document: {}, flowId: FLOW_ID })).toEqual({ error: 'flows_disabled' });
    }
    expect(saveDraftFlow).not.toHaveBeenCalled();
    expect(validateFlowDocument).not.toHaveBeenCalled();
  });

  it('validate_flow naming an inaccessible org returns the owner error and never calls the validator', async () => {
    vi.mocked(resolveFlowOwnerForCaller).mockResolvedValue({ error: 'Cannot access another organization' });
    expect(await call('validate_flow', { document: {}, orgId: FLOW_ID })).toEqual({ error: 'Cannot access another organization' });
    expect(resolveFlowOwnerForCaller).toHaveBeenCalledWith(auth, { ownerScope: undefined, orgId: FLOW_ID }, 'read');
    expect(validateFlowDocument).not.toHaveBeenCalled();
  });

  it('validate_flow on a broken document returns the validator issues and drops the parsed document', async () => {
    vi.mocked(resolveFlowOwnerForCaller).mockResolvedValue({ owner: { orgId: 'o', partnerId: 'p' } });
    vi.mocked(validateFlowDocument).mockResolvedValue({
      valid: false, effectiveTier: null, steps: [], issues: [{ code: 'schema', severity: 'error', message: 'bad' }],
    });
    const out = await call('validate_flow', { document: { steps: 'x' } });
    expect(out).toEqual({ valid: false, effectiveTier: null, steps: [], issues: [{ code: 'schema', severity: 'error', message: 'bad' }] });
  });

  it('draft_flow maps a saved result with reviewPath', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: true, flow: { id: FLOW_ID } as never, validation: { valid: true } as never });
    const out = await call('draft_flow', { document: { a: 1 }, ownerScope: 'organization' });
    expect(out).toMatchObject({ saved: true, reviewPath: `/flows/${FLOW_ID}` });
    expect(saveDraftFlow).toHaveBeenCalledWith(auth, expect.objectContaining({ document: { a: 1 }, ownerScope: 'organization' }));
  });

  it('draft_flow passes validation failures and partner-wide denials through without reviewPath', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, validation: { valid: false } as never });
    expect(await call('draft_flow', { document: {} })).toEqual({ saved: false, validation: { valid: false } });
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: 'denied' });
    expect(await call('draft_flow', { document: {} })).toEqual({ saved: false, error: 'denied' });
  });

  it('draft_flow never forwards session provenance from input', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: 'x' });
    await call('draft_flow', { document: {}, aiSessionId: FLOW_ID });
    expect(vi.mocked(saveDraftFlow).mock.calls[0]![1]).not.toHaveProperty('aiSessionId');
  });

  it('get_flow of an invisible id ⇒ flow_not_found', async () => {
    vi.mocked(getFlow).mockResolvedValue(null);
    expect(await call('get_flow', { flowId: FLOW_ID })).toEqual({ error: 'flow_not_found' });
  });

  it('list_flows passes the filter through', async () => {
    vi.mocked(listFlows).mockResolvedValue({ flows: [], total: 0 });
    expect(await call('list_flows', { status: 'draft', limit: 5 })).toEqual({ flows: [], total: 0 });
    expect(listFlows).toHaveBeenCalledWith(auth, { orgId: undefined, status: 'draft', limit: 5 });
  });
});

describe('isToolEnvGatedOff', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('gates the four flow tools on FLOWS_ENABLED and nothing else', () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    for (const n of FLOW_TOOL_NAMES) expect(isToolEnvGatedOff(n)).toBe(true);
    expect(isToolEnvGatedOff('get_device_details')).toBe(false);
    vi.stubEnv('FLOWS_ENABLED', 'true');
    for (const n of FLOW_TOOL_NAMES) expect(isToolEnvGatedOff(n)).toBe(false);
  });
});

// Tool Catalog W04 (#5219, Task A11): run / list / get / cancel flow runs.
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const userAuth = { scope: 'organization', orgId: 'o', user: { id: 'u' }, principal: { kind: 'user_session' } } as unknown as AuthContext;
const apiKeyAuth = { scope: 'organization', orgId: 'o', user: { id: 'u' }, principal: { kind: 'api_key', apiKeyId: 'k' } } as unknown as AuthContext;
const chatCtx = { chatSessionId: '55555555-5555-4555-8555-555555555555' };
const callAs = (a: AuthContext, name: string, input: Record<string, unknown>, ctx?: Record<string, unknown>) =>
  tools().get(name)!.handler(input, a, ctx as never).then((s) => JSON.parse(s));

describe('flow run AI tools (W04)', () => {
  beforeEach(() => {
    vi.stubEnv('FLOWS_ENABLED', 'true');
    for (const f of [startManualRun, listFlowRuns, getFlowRun, cancelFlowRun]) (f as unknown as { mockReset: () => void }).mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('the four run handlers return flows_disabled with the flag off and touch no service', async () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    for (const name of ['run_flow', 'list_flow_runs', 'get_flow_run', 'cancel_flow_run']) {
      expect(await callAs(userAuth, name, { flowId: FLOW_ID, runId: RUN_ID }, chatCtx)).toEqual({ error: 'flows_disabled' });
    }
    expect(startManualRun).not.toHaveBeenCalled();
    expect(cancelFlowRun).not.toHaveBeenCalled();
  });

  it('descriptions are prose of at most 300 chars; run_flow names the approval and human-gated steps', () => {
    for (const name of ['run_flow', 'list_flow_runs', 'get_flow_run', 'cancel_flow_run']) {
      expect(tools().get(name)!.definition.description!.length, name).toBeLessThanOrEqual(300);
    }
    const d = tools().get('run_flow')!.definition.description!;
    expect(d).toMatch(/approval/i);
    expect(d).toMatch(/human/i);
  });

  it('run_flow creates a run with pre_approvals_honored false, session from chat context only', async () => {
    vi.mocked(startManualRun).mockResolvedValue({ ok: true, runId: RUN_ID, duplicate: false, preApprovalsHonored: false });
    const out = await callAs(userAuth, 'run_flow', { flowId: FLOW_ID, orgId: 'o', inputs: { a: 1 }, idempotencyKey: 'k1', aiSessionId: 'attacker' }, chatCtx);
    expect(out).toEqual({ ok: true, runId: RUN_ID, duplicate: false, preApprovalsHonored: false, runPath: `/flows/runs/${RUN_ID}` });
    expect(startManualRun).toHaveBeenCalledWith(userAuth, FLOW_ID, { orgId: 'o', inputs: { a: 1 }, idempotencyKey: 'k1' }, 'ai_tool', chatCtx.chatSessionId);
  });

  it('run_flow passes a service refusal through without a runPath', async () => {
    vi.mocked(startManualRun).mockResolvedValue({ ok: false, error: 'org_required' });
    expect(await callAs(userAuth, 'run_flow', { flowId: FLOW_ID }, chatCtx)).toEqual({ ok: false, error: 'org_required' });
  });

  it('run_flow refuses a caller that is not an interactive user session with a chat session', async () => {
    expect(await callAs(apiKeyAuth, 'run_flow', { flowId: FLOW_ID }, chatCtx)).toEqual({ error: 'run_flow_requires_chat' });
    expect(await callAs(userAuth, 'run_flow', { flowId: FLOW_ID })).toEqual({ error: 'run_flow_requires_chat' });
    expect(await callAs(userAuth, 'run_flow', { flowId: FLOW_ID }, {})).toEqual({ error: 'run_flow_requires_chat' });
    expect(startManualRun).not.toHaveBeenCalled();
  });

  it('an MCP_UNATTENDED_TIER3_PRINCIPALS key reaching the handler gets run_flow_requires_chat', async () => {
    vi.stubEnv('MCP_UNATTENDED_TIER3_PRINCIPALS', 'api_key:k');
    expect(await callAs(apiKeyAuth, 'run_flow', { flowId: FLOW_ID, orgId: 'o' }, chatCtx)).toEqual({ error: 'run_flow_requires_chat' });
    expect(startManualRun).not.toHaveBeenCalled();
  });

  it('list_flow_runs passes the filter through', async () => {
    vi.mocked(listFlowRuns).mockResolvedValue({ runs: [], total: 0 });
    expect(await callAs(userAuth, 'list_flow_runs', { flowId: FLOW_ID, status: 'running', limit: 5 })).toEqual({ runs: [], total: 0 });
    expect(listFlowRuns).toHaveBeenCalledWith(userAuth, { flowId: FLOW_ID, orgId: undefined, status: 'running', limit: 5 });
  });

  it('get_flow_run asks for capped step bodies; an invisible run is run_not_found', async () => {
    vi.mocked(getFlowRun).mockResolvedValue(null);
    expect(await callAs(userAuth, 'get_flow_run', { runId: RUN_ID })).toEqual({ error: 'run_not_found' });
    expect(getFlowRun).toHaveBeenCalledWith(userAuth, RUN_ID, { stepBodies: 'capped' });
  });

  it('get_flow_run caps a step output at 4 KB with a truncated marker', async () => {
    const big = capFlowRunToolOutput({ blob: 'x'.repeat(10_000) });
    expect(big).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(4096 + 64);
    vi.mocked(getFlowRun).mockResolvedValue({ id: RUN_ID, steps: [{ stepId: 's', output: big }] } as never);
    const out = await callAs(userAuth, 'get_flow_run', { runId: RUN_ID });
    expect(out.steps[0].output.truncated).toBe(true);
  });

  it('get_flow_run re-caps an oversized output the service returned uncapped', async () => {
    vi.mocked(getFlowRun).mockResolvedValue({ id: RUN_ID, steps: [{ stepId: 's', output: { blob: 'y'.repeat(10_000) } }] } as never);
    const out = await callAs(userAuth, 'get_flow_run', { runId: RUN_ID });
    expect(out.steps[0].output.truncated).toBe(true);
  });

  // Review finding: runs have no site column and W04 no site model, so a
  // site-limited user or a device-bound agent never reads a run body through
  // the tools either (the service redacts; the handler holds the line too).
  const siteLimited = { ...(userAuth as object), allowedSiteIds: ['s1'] } as unknown as AuthContext;
  const deviceBound = { scope: 'organization', orgId: 'o', principal: { kind: 'ai_agent' }, allowedDeviceIds: ['d1'] } as unknown as AuthContext;
  const fullRun = () => ({
    id: RUN_ID, triggerPayload: { payload: { secret: 1 } }, inputs: { host: 'pc-1' },
    steps: [{ stepId: 's', bodiesPruned: false, output: { secret: 2 } }],
  });

  it.each([['a site-limited user', siteLimited], ['a device-bound agent', deviceBound]])(
    'get_flow_run for %s returns no trigger payload, inputs or step outputs',
    async (_label, who) => {
      vi.mocked(getFlowRun).mockResolvedValue(fullRun() as never);
      const out = await callAs(who, 'get_flow_run', { runId: RUN_ID });
      expect(getFlowRun).toHaveBeenCalledWith(who, RUN_ID, { stepBodies: 'capped' });
      expect(out).toMatchObject({ id: RUN_ID, triggerPayload: null, inputs: null });
      expect(out.steps[0]).not.toHaveProperty('output');
      expect(out.steps[0].bodiesPruned).toBe(true);
    },
  );

  it('get_flow_run for an unrestricted user keeps the bodies', async () => {
    vi.mocked(getFlowRun).mockResolvedValue(fullRun() as never);
    const out = await callAs(userAuth, 'get_flow_run', { runId: RUN_ID });
    expect(out).toMatchObject({ triggerPayload: { payload: { secret: 1 } }, inputs: { host: 'pc-1' } });
    expect(out.steps[0].output).toEqual({ secret: 2 });
  });

  it.each([['a site-limited user', siteLimited], ['a device-bound agent', deviceBound]])(
    'list_flow_runs for %s passes its auth to the service (summaries carry no bodies)',
    async (_label, who) => {
      vi.mocked(listFlowRuns).mockResolvedValue({ runs: [], total: 0 });
      expect(await callAs(who, 'list_flow_runs', {})).toEqual({ runs: [], total: 0 });
      expect(listFlowRuns).toHaveBeenCalledWith(who, { flowId: undefined, orgId: undefined, status: undefined, limit: undefined });
    },
  );

  it('a handler failure is captured with the flow tags and a bounded fingerprint', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(captureException).mockReset();
    vi.mocked(listFlowRuns).mockRejectedValue(new Error('db down'));
    expect(await callAs(userAuth, 'list_flow_runs', {})).toEqual({ error: 'Operation failed. Check server logs for details.' });
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error), undefined, { flow_site: 'ai_tool.list_flow_runs' }, { fingerprint: ['flow', 'ai_tool.list_flow_runs'] },
    );
    err.mockRestore();
  });

  it('cancel_flow_run of a terminal run returns already_terminal; a hidden run is run_not_found', async () => {
    vi.mocked(cancelFlowRun).mockResolvedValue({ ok: false, error: 'already_terminal' });
    expect(await callAs(userAuth, 'cancel_flow_run', { runId: RUN_ID })).toEqual({ ok: false, error: 'already_terminal' });
    vi.mocked(cancelFlowRun).mockResolvedValue({ ok: true, status: 'cancelled' } as never);
    expect(await callAs(userAuth, 'cancel_flow_run', { runId: RUN_ID })).toEqual({ ok: true, status: 'cancelled' });
    expect(cancelFlowRun).toHaveBeenCalledWith(userAuth, RUN_ID);
  });
});

describe('run_flow tier (W04 Decision 11)', () => {
  it('is tier 3 supervised in TOOL_TIERS and checkGuardrails, agent human-only, never policy-decidable', async () => {
    const { TOOL_TIERS } = await import('./aiAgentSdkTools');
    const g = await import('./aiGuardrails');
    expect(TOOL_TIERS.run_flow).toBe(3);
    expect(TOOL_TIERS.cancel_flow_run).toBe(2);
    expect(TOOL_TIERS.list_flow_runs).toBe(1);
    expect(TOOL_TIERS.get_flow_run).toBe(1);
    expect(g.TIER3_SUPERVISED_TOOLS.has('run_flow')).toBe(true);
    expect(g.checkGuardrails('run_flow', { flowId: FLOW_ID })).toMatchObject({ tier: 3, requiresApproval: true });
    const { AGENT_HUMAN_ONLY_TOOLS } = await import('./aiToolExposure');
    expect(AGENT_HUMAN_ONLY_TOOLS.has('run_flow')).toBe(true);
    expect(AGENT_HUMAN_ONLY_TOOLS.has('cancel_flow_run')).toBe(true);
    expect(g.TOOL_PERMISSIONS.run_flow).toEqual({ resource: 'automations', action: 'write' });
    expect(g.TOOL_PERMISSIONS.get_flow_run).toEqual({ resource: 'automations', action: 'read' });
  }, 60_000);
});
