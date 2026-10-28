import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Tool catalog W04 (#5219), plan Task A7 — the flow step executor.
//
// The executors (`executeTool`, `executeTenantToolDetailed`), intent creation
// and the script snapshot read are mocked. `revalidateRenderedStep` is the
// REAL one — only its catalog/ownership lookups are faked — so the ownership
// tests exercise the actual run-org check, not a stub of it.
// ============================================================================

const { dbContexts } = vi.hoisted(() => ({ dbContexts: [] as unknown[] }));

vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  withDbAccessContext: async (ctx: unknown, fn: () => Promise<unknown>) => {
    dbContexts.push(ctx);
    return fn();
  },
}));
vi.mock('../aiTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiTools')>()),
  executeTool: vi.fn(),
}));
vi.mock('../toolSources/resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../toolSources/resolver')>()),
  resolveTenantToolsForOwner: vi.fn(),
  loadTenantToolForExecution: vi.fn(),
}));
vi.mock('../toolSources/execute', () => ({ executeTenantToolDetailed: vi.fn() }));
vi.mock('./ownedReferences', () => ({
  findOwnedScriptIds: vi.fn(),
  findOwnedDeviceGroupIds: vi.fn(),
  findOwnedDeviceIds: vi.fn(),
}));
vi.mock('../actionIntents/intentService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../actionIntents/intentService')>()),
  createActionIntent: vi.fn(),
}));
vi.mock('./builtins/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./builtins/index')>();
  return { ...actual, executeFlowBuiltin: vi.fn(actual.executeFlowBuiltin) };
});
vi.mock('./builtins/runCounters', () => ({ countRunBuiltinCalls: vi.fn() }));
vi.mock('../actionIntents/runScriptSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../actionIntents/runScriptSnapshot')>()),
  buildRunScriptSnapshot: vi.fn(),
}));

import { FLOW_RUN_LIMITS, type FlowDocumentV1, type FlowScope } from '@breeze/shared';
import { executeTool } from '../aiTools';
import { executeTenantToolDetailed } from '../toolSources/execute';
import { loadTenantToolForExecution, resolveTenantToolsForOwner, type TenantToolDescriptor } from '../toolSources/resolver';
import { findOwnedDeviceGroupIds, findOwnedDeviceIds, findOwnedScriptIds } from './ownedReferences';
import { createActionIntent } from '../actionIntents/intentService';
import { buildRunScriptSnapshot, type RunScriptSnapshot } from '../actionIntents/runScriptSnapshot';
import type { FlowStepPin } from '../flowValidator';
import type { FlowRunRow, FlowVersionRow } from '../../db/schema/flowRuns';
import { buildFlowAuthContext } from './flowAuthContext';
import { currentFlowExecutionFrame } from './flowExecutionContext';
import { preApprovalMaterialFromSnapshot, type ActAssetPreApprovalBinding } from './preApproval';
import { executeFlowBuiltin } from './builtins/index';
import { countRunBuiltinCalls } from './builtins/runCounters';
import { classifyToolResult, executeFlowStep, isErrorResult, isTransientFlowToolError, type StepExecutionInput } from './stepExecutor';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SCRIPT = '33333333-3333-4333-8333-333333333333';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const DEVICE_2 = '66666666-6666-4666-8666-666666666666';
const FOREIGN_DEVICE = '77777777-7777-4777-8777-777777777777';
const FLOW = '88888888-8888-4888-8888-888888888888';
const RUN = '99999999-9999-4999-8999-999999999999';
const VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STEP_ROW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DELEGATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INTENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type Step = FlowDocumentV1['steps'][number];

function step(id: string, tool: string, input: Record<string, unknown>, over: Partial<Step> = {}): Step {
  return { id, tool, input, approval: 'default', onFailure: 'stop', timeoutSec: 300, ...over } as Step;
}

const RUN_SCRIPT_PIN: FlowStepPin = { stepId: 'fix', tool: 'run_script', source: 'core', tier: 3, approvalScope: 'supervised' };
const LOOKUP_PIN: FlowStepPin = { stepId: 'look', tool: 'get_device_details', source: 'core', tier: 1, approvalScope: null };
const RUN_SCRIPT_INPUT = { scriptId: SCRIPT, deviceIds: ['{{trigger.device.id}}'], parameters: { mode: 'quick' } };

function tenantTool(qualifiedName: string, tier: 1 | 2 | 3): TenantToolDescriptor {
  const inputSchema = { type: 'object', properties: { summary: { type: 'string' } }, additionalProperties: false };
  return {
    id: `id-${qualifiedName}`, sourceId: 's', sourceName: 'Vendor', sourceKind: 'mcp',
    ownerRef: { orgId: ORG, partnerId: null }, qualifiedName, name: qualifiedName.split('__')[1]!,
    description: '', inputSchema, tier, revision: 'rev-1', rateLimitPerMinute: 60,
    validate: () => ({ success: true }), definition: { name: qualifiedName, description: '', input_schema: inputSchema },
  };
}
const TENANT_T2 = tenantTool('halo__update_ticket', 2);
const TENANT_T1 = tenantTool('halo__get_ticket', 1);
// #10288: a Tier-3 external tool, with a canonical UUID id as tool_source_tools rows carry.
const TENANT_T3: TenantToolDescriptor = { ...tenantTool('halo__close_ticket', 3), id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
const tenantPin = (d: TenantToolDescriptor, stepId: string): FlowStepPin => ({
  stepId, tool: d.qualifiedName, source: 'tenant', tier: d.tier, approvalScope: d.tier === 3 ? 'supervised' : null,
  tenantToolId: d.id, tenantRevision: d.revision,
});

function snapshot(content = 'Write-Output fix', variableReferences: RunScriptSnapshot['variableReferences'] = []): RunScriptSnapshot {
  return {
    script: { id: SCRIPT, orgId: ORG, language: 'powershell', content, timeoutSeconds: 300, runAs: 'system' },
    parameterDefinitions: '[]',
    deviceOrgIds: [ORG],
    variableReferences,
  };
}
function built(snap: RunScriptSnapshot) {
  return {
    kind: 'snapshot' as const,
    snapshot: snap,
    scope: { orgIds: new Set([ORG]) } as never,
    scriptRow: { id: SCRIPT, orgId: ORG, partnerId: null, content: snap.script.content, runAs: 'system' } as never,
  };
}
/** The binding enable would have stored for the step's literal input and the ORIGINAL content. */
function binding(stepId = 'fix', input: Record<string, unknown> = RUN_SCRIPT_INPUT): ActAssetPreApprovalBinding {
  return {
    stepId, lane: 'act_asset', assetKind: 'script', scriptId: SCRIPT,
    contentDigest: preApprovalMaterialFromSnapshot(snapshot(), input).contentDigest,
  };
}

function run(over: Partial<FlowRunRow> = {}): FlowRunRow {
  return {
    id: RUN, orgId: ORG, flowId: FLOW, flowVersionId: VERSION, preApprovalsHonored: true, chainDepth: 1,
    triggeredByUserId: null, triggerKind: 'schedule', triggeredVia: 'scheduler', status: 'running', ...over,
  } as FlowRunRow;
}
function version(over: Partial<FlowVersionRow> = {}): FlowVersionRow {
  return {
    id: VERSION, flowId: FLOW, orgId: ORG, partnerId: null, publicationSeq: 1, definitionVersion: 3,
    definition: { version: 1, name: 'Nightly fix' }, effectiveTier: 3, stepPins: [], preApprovals: [binding()],
    enabledByUserId: DELEGATOR, ...over,
  } as FlowVersionRow;
}

function auth(flowOwner: { orgId: string | null; partnerId: string | null } = { orgId: ORG, partnerId: null }) {
  return buildFlowAuthContext(
    { id: FLOW, orgId: flowOwner.orgId, partnerId: flowOwner.partnerId, status: 'enabled', name: 'Nightly fix' },
    { id: RUN, orgId: ORG, flowId: FLOW },
    { id: ORG, partnerId: PARTNER },
  );
}

const SCOPE: FlowScope = { trigger: { kind: 'event', device: { id: DEVICE } }, inputs: {}, steps: {} };

function input(over: Partial<StepExecutionInput> = {}): StepExecutionInput {
  return {
    run: run(), version: version(), step: step('fix', 'run_script', RUN_SCRIPT_INPUT), pin: RUN_SCRIPT_PIN,
    itemIndex: null, item: undefined, scope: SCOPE, auth: auth(), deadline: Date.now() + 60_000, stepRowId: STEP_ROW,
    ...over,
  };
}

const noSleep = { sleep: vi.fn(async (_ms: number) => {}) };
const executors = () => [executeTool, executeTenantToolDetailed, createActionIntent, buildRunScriptSnapshot].map((f) => vi.mocked(f));

beforeEach(() => {
  vi.mocked(executeTool).mockReset().mockResolvedValue(JSON.stringify({ results: { [DEVICE]: { exitCode: 0 } } }));
  vi.mocked(executeTenantToolDetailed).mockReset().mockResolvedValue({ isError: false, text: '{"ok":true}' });
  vi.mocked(createActionIntent).mockReset().mockResolvedValue({ id: INTENT, status: 'pending_approval', errorCode: null } as never);
  vi.mocked(buildRunScriptSnapshot).mockReset().mockResolvedValue(built(snapshot()));
  vi.mocked(resolveTenantToolsForOwner).mockReset().mockResolvedValue([TENANT_T2, TENANT_T1, TENANT_T3]);
  vi.mocked(loadTenantToolForExecution).mockReset().mockImplementation(async (id) => {
    const d = [TENANT_T2, TENANT_T1, TENANT_T3].find((t) => t.id === id);
    return d ? ({ descriptor: d, source: {}, tool: {} } as never) : null;
  });
  vi.mocked(findOwnedScriptIds).mockReset().mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === SCRIPT)));
  vi.mocked(findOwnedDeviceIds).mockReset().mockImplementation(async (_o, ids) => new Set([...ids].filter((i) => i === DEVICE || i === DEVICE_2)));
  vi.mocked(findOwnedDeviceGroupIds).mockReset().mockResolvedValue(new Set());
  noSleep.sleep.mockClear();
  vi.mocked(countRunBuiltinCalls).mockReset().mockResolvedValue({ notify: 1, http: 1 });
  vi.mocked(executeFlowBuiltin).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('executeFlowStep — when / render / built-ins', () => {
  it('when false skips', async () => {
    const out = await executeFlowStep(input({
      step: step('fix', 'run_script', RUN_SCRIPT_INPUT, { when: 'inputs.go == true' }),
      scope: { ...SCOPE, inputs: { go: false } },
    }));
    expect(out).toEqual({ kind: 'skipped' });
    for (const f of executors()) expect(f).not.toHaveBeenCalled();
  });

  it('set returns values', async () => {
    const out = await executeFlowStep(input({
      step: step('remember', 'set', { values: { host: '{{trigger.device.id}}', fixed: 3 } }),
      pin: { stepId: 'remember', tool: 'set', source: 'builtin', tier: 1, approvalScope: null },
    }));
    expect(out).toMatchObject({ kind: 'completed', output: { host: DEVICE, fixed: 3 }, truncated: false });
    for (const f of executors()) expect(f).not.toHaveBeenCalled();
  });

  it('wait parks with a completed output and is never re-entered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T10:00:00.000Z'));
    const out = await executeFlowStep(input({
      step: step('pause', 'wait', { minutes: 5 }),
      pin: { stepId: 'pause', tool: 'wait', source: 'builtin', tier: 1, approvalScope: null },
    }));
    // The runner writes THIS output as the wait step's completed output in the
    // same checkpoint that parks the run, so the resumed slice starts at the
    // next step: park_wait carries no step state to re-enter.
    expect(out).toEqual({
      kind: 'park_wait',
      resumeAt: new Date('2026-10-25T10:05:00.000Z'),
      output: { waitUntil: '2026-10-25T10:05:00.000Z' },
      renderedInput: { minutes: 5 },
    });
    for (const f of executors()) expect(f).not.toHaveBeenCalled();
  });

  it('a template that cannot render is render_failed', async () => {
    const out = await executeFlowStep(input({
      step: step('remember', 'set', { values: { x: '{{inputs.}}' } }),
      pin: { stepId: 'remember', tool: 'set', source: 'builtin', tier: 1, approvalScope: null },
    }));
    expect(out).toMatchObject({ kind: 'failed', code: 'render_failed' });
  });

  it('set and wait dispatch through executeFlowBuiltin', async () => {
    await executeFlowStep(input({
      step: step('remember', 'set', { values: { a: 1 } }),
      pin: { stepId: 'remember', tool: 'set', source: 'builtin', tier: 1, approvalScope: null },
    }));
    expect(executeFlowBuiltin).toHaveBeenCalledWith('set', { values: { a: 1 } }, expect.objectContaining({ stepRowId: STEP_ROW }));
    // wait/set never read the per-run counters.
    expect(countRunBuiltinCalls).not.toHaveBeenCalled();
  });
});

// W5 PR B (#5220, Decision 12): built-ins go through run-time revalidation and Tier-3 parking.
describe('executeFlowStep — W5 built-ins', () => {
  const HTTP_POST_PIN: FlowStepPin = { stepId: 'call', tool: 'http_request', source: 'builtin', tier: 3, approvalScope: 'supervised' };
  const HTTP_GET_PIN: FlowStepPin = { stepId: 'call', tool: 'http_request', source: 'builtin', tier: 2, approvalScope: null };
  const NOTIFY_PIN: FlowStepPin = { stepId: 'tell', tool: 'notify', source: 'builtin', tier: 2, approvalScope: null };
  const AI_PIN: FlowStepPin = { stepId: 'think', tool: 'ai', source: 'builtin', tier: 1, approvalScope: null };
  const CHANNEL = '7d1c3a5e-2b4f-4c6a-9e8d-1f2a3b4c5d6e';

  it('tier-3 http_request parks with a builtin flow intent and never executes', async () => {
    const out = await executeFlowStep(input({
      step: step('call', 'http_request', { method: 'POST', url: 'https://api.example.com/hosts/{{trigger.device.id}}', body: { up: true } }),
      pin: HTTP_POST_PIN,
    }));
    expect(out).toMatchObject({ kind: 'park_approval', intentId: INTENT });
    const [, intentInput] = vi.mocked(createActionIntent).mock.calls[0]!;
    expect(intentInput).toMatchObject({
      source: 'flow',
      toolName: 'http_request',
      input: { method: 'POST', url: `https://api.example.com/hosts/${DEVICE}`, body: { up: true } },
      flowRun: { runId: RUN, stepRowId: STEP_ROW, stepId: 'call', builtin: true },
    });
    expect(executeFlowBuiltin).not.toHaveBeenCalled();
  });

  it('a tier-3 built-in is never pre-approved, even on an honouring run with a binding for its step', async () => {
    const out = await executeFlowStep(input({
      run: run({ preApprovalsHonored: true }),
      version: version({ preApprovals: [binding('call') as unknown as Record<string, unknown>] }),
      step: step('call', 'http_request', { method: 'DELETE', url: 'https://api.example.com/x' }),
      pin: HTTP_POST_PIN,
    }));
    expect(out).toMatchObject({ kind: 'park_approval' });
    expect(buildRunScriptSnapshot).not.toHaveBeenCalled();
    expect(executeFlowBuiltin).not.toHaveBeenCalled();
  });

  // Review round: an approver is never asked to approve a request that is
  // certain to be refused at release (policy is checked before parking).
  it('a tier-3 http_request that the egress policy would refuse fails before it parks (no intent)', async () => {
    vi.stubEnv('PUBLIC_API_URL', 'https://api.example.com');
    try {
      expect(await executeFlowStep(input({ step: step('call', 'http_request', { method: 'POST', url: 'https://api.example.com/x' }), pin: HTTP_POST_PIN })))
        .toMatchObject({ kind: 'failed', code: 'egress_blocked', policy: true });
    } finally {
      vi.unstubAllEnvs();
    }
    // (An oversized templated body never gets this far: the render bound refuses it first.)
    vi.mocked(countRunBuiltinCalls).mockResolvedValueOnce({ notify: 0, http: 101 });
    expect(await executeFlowStep(input({ step: step('call', 'http_request', { method: 'DELETE', url: 'https://api.example.com/x' }), pin: HTTP_POST_PIN })))
      .toMatchObject({ kind: 'failed', policy: true });
    expect(createActionIntent).not.toHaveBeenCalled();
  });

  it('rendered built-in input is schema-checked at run time', async () => {
    const out = await executeFlowStep(input({
      step: step('call', 'http_request', { method: 'GET', url: 'https://api.example.com/x', timeout: '{{inputs.t}}' }),
      pin: HTTP_GET_PIN,
      scope: { ...SCOPE, inputs: { t: 5 } },
    }));
    expect(out).toMatchObject({ kind: 'failed', code: 'input_invalid', policy: true });
    expect(executeFlowBuiltin).not.toHaveBeenCalled();
  });

  it('a GET pin whose rendered method writes is drift and never executes', async () => {
    const out = await executeFlowStep(input({
      step: step('call', 'http_request', { method: 'POST', url: 'https://api.example.com/x' }),
      pin: HTTP_GET_PIN,
    }));
    expect(out).toMatchObject({ kind: 'failed', code: 'drift', policy: true });
    expect(executeFlowBuiltin).not.toHaveBeenCalled();
    expect(createActionIntent).not.toHaveBeenCalled();
  });

  it('ai step whose tool tier rose is drift', async () => {
    vi.mocked(resolveTenantToolsForOwner).mockResolvedValue([tenantTool('halo__get_ticket', 2)]);
    const out = await executeFlowStep(input({
      step: step('think', 'ai', { prompt: 'Summarise', tools: ['halo__get_ticket'], output: { type: 'object' } }),
      pin: AI_PIN,
    }));
    expect(out).toMatchObject({ kind: 'failed', code: 'drift', policy: true });
    expect(executeFlowBuiltin).not.toHaveBeenCalled();
  });

  it('notify dispatches inside the flow frame with the per-run counters, the publication step and the lease', async () => {
    vi.mocked(countRunBuiltinCalls).mockResolvedValue({ notify: 3, http: 0 });
    let frameRunId: string | undefined;
    vi.mocked(executeFlowBuiltin).mockImplementationOnce(async () => {
      frameRunId = currentFlowExecutionFrame()?.runId;
      return { kind: 'completed', output: { channelId: CHANNEL, sent: true }, truncated: false };
    });
    const tell = step('tell', 'notify', { channelId: CHANNEL, title: 'Disk on {{trigger.device.id}}', message: 'Cleaned' });
    const out = await executeFlowStep(input({ step: tell, pin: NOTIFY_PIN, leaseToken: 'lease-1' }));
    expect(out).toMatchObject({ kind: 'completed', output: { channelId: CHANNEL, sent: true }, renderedInput: { title: `Disk on ${DEVICE}` } });
    expect(frameRunId).toBe(RUN);
    expect(countRunBuiltinCalls).toHaveBeenCalledWith(RUN);
    const [name, rendered, ctx] = vi.mocked(executeFlowBuiltin).mock.calls[0]!;
    expect(name).toBe('notify');
    expect(rendered).toMatchObject({ channelId: CHANNEL, title: `Disk on ${DEVICE}`, severity: 'info' });
    expect(ctx).toMatchObject({
      counters: { notify: 3, http: 0 }, step: tell, stepRowId: STEP_ROW, leaseToken: 'lease-1',
      owner: { orgId: ORG, partnerId: PARTNER },
    });
    expect(ctx.run.id).toBe(RUN);
  });

  it('a tier-2 built-in that throws may have taken effect: unknown_outcome', async () => {
    vi.mocked(executeFlowBuiltin).mockRejectedValueOnce(new Error('socket hang up'));
    const out = await executeFlowStep(input({
      step: step('tell', 'notify', { channelId: CHANNEL, title: 't', message: 'm' }), pin: NOTIFY_PIN,
    }));
    expect(out).toMatchObject({ kind: 'unknown_outcome' });
  });

  it('a tier-1 built-in that throws fails the step without retrying', async () => {
    vi.mocked(executeFlowBuiltin).mockRejectedValueOnce(new Error('ECONNRESET'));
    const out = await executeFlowStep(input({
      step: step('think', 'ai', { prompt: 'x', tools: [], output: { type: 'object' } }), pin: AI_PIN,
    }), noSleep);
    expect(out).toMatchObject({ kind: 'failed', code: 'step_failed', policy: false });
    expect(executeFlowBuiltin).toHaveBeenCalledTimes(1);
  });

  it('a tier-2 built-in past its deadline is unknown_outcome and its late result is dropped', async () => {
    vi.useFakeTimers();
    vi.mocked(executeFlowBuiltin).mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve({ kind: 'completed', output: { late: true }, truncated: false }), 10_000);
    }));
    const pending = executeFlowStep(input({
      step: step('tell', 'notify', { channelId: CHANNEL, title: 't', message: 'm' }), pin: NOTIFY_PIN,
      deadline: Date.now() + 1_000,
    }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toMatchObject({ kind: 'unknown_outcome' });
  });
});

describe('executeFlowStep — run-time revalidation and ownership', () => {
  it('rendered input re-validated unmasked', async () => {
    const out = await executeFlowStep(input({
      step: step('fix', 'run_script', { scriptId: SCRIPT, deviceIds: ['{{inputs.dev}}'] }),
      scope: { ...SCOPE, inputs: { dev: 'abc' } },
    }));
    expect(out).toMatchObject({ kind: 'failed', code: 'input_invalid', policy: true });
    for (const f of executors()) expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['org flow', { orgId: ORG, partnerId: null }],
    ['partner-wide flow', { orgId: null, partnerId: PARTNER }],
  ] as const)('templated device id outside the run org is refused (%s)', async (_label, owner) => {
    const out = await executeFlowStep(input({
      version: version({ orgId: owner.orgId, partnerId: owner.partnerId }),
      auth: auth(owner),
      step: step('look', 'get_device_details', { deviceId: '{{trigger.payload.deviceId}}' }),
      pin: LOOKUP_PIN,
      scope: { ...SCOPE, trigger: { payload: { deviceId: FOREIGN_DEVICE } } },
    }));
    expect(out).toMatchObject({ kind: 'failed', code: 'reference_not_owned', policy: true });
    // The real revalidateRenderedStep checked the RENDERED id against the RUN org.
    expect(findOwnedDeviceIds).toHaveBeenCalledWith(ORG, [FOREIGN_DEVICE]);
    for (const f of executors()) expect(f).not.toHaveBeenCalled();
  });
});

describe('executeFlowStep — tier 3', () => {
  it('tier 3 without pre-approval creates a flow intent and parks', async () => {
    const out = await executeFlowStep(input({ version: version({ preApprovals: [] }) }));
    expect(out).toMatchObject({ kind: 'park_approval', intentId: INTENT });
    expect(createActionIntent).toHaveBeenCalledTimes(1);
    const [authArg, intentInput] = vi.mocked(createActionIntent).mock.calls[0]!;
    expect(authArg.principal).toEqual({ kind: 'flow', flowId: FLOW, runId: RUN });
    expect(intentInput).toMatchObject({
      source: 'flow',
      orgId: ORG,
      toolName: 'run_script',
      input: { scriptId: SCRIPT, deviceIds: [DEVICE], parameters: { mode: 'quick' } },
      flowRun: {
        runId: RUN, stepRowId: STEP_ROW, delegatorUserId: DELEGATOR, triggeredByUserId: null,
        flowName: 'Nightly fix', stepId: 'fix',
      },
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('pre-approval ignored when not honoured', async () => {
    const out = await executeFlowStep(input({ run: run({ preApprovalsHonored: false }) }));
    expect(out).toMatchObject({ kind: 'park_approval', intentId: INTENT });
    expect(buildRunScriptSnapshot).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('pre-approved run_script executes with a verifiedRunScript pin', async () => {
    const flowAuth = auth();
    const out = await executeFlowStep(input({ auth: flowAuth }));
    expect(out).toMatchObject({ kind: 'completed', approvalMode: 'pre_approved', truncated: false });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(buildRunScriptSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildRunScriptSnapshot).mock.calls[0]![0]).toEqual({ scriptId: SCRIPT, deviceIds: [DEVICE] });
    expect(executeTool).toHaveBeenCalledTimes(1);
    const [tool, rendered, authArg, opts] = vi.mocked(executeTool).mock.calls[0]!;
    expect(tool).toBe('run_script');
    expect(rendered).toEqual({ scriptId: SCRIPT, deviceIds: [DEVICE], parameters: { mode: 'quick' } });
    expect(authArg).toBe(flowAuth);
    expect(authArg.aiOrigin).toEqual({ kind: 'flow', flowRunId: RUN });
    const verified = opts?.context?.verifiedRunScript;
    expect(verified?.snapshot.script.content).toBe('Write-Output fix');
    expect(verified?.scriptRow.id).toBe(SCRIPT);
  });

  it('pre-approved run_script with two rendered devices fails policy', async () => {
    const out = await executeFlowStep(input({
      step: step('fix', 'run_script', { ...RUN_SCRIPT_INPUT, deviceIds: [DEVICE, DEVICE_2] }),
    }));
    expect(out).toMatchObject({ kind: 'failed', policy: true });
    for (const f of executors()) expect(f).not.toHaveBeenCalled();
  });

  it('content change is binding_drift', async () => {
    vi.mocked(buildRunScriptSnapshot).mockResolvedValue(built(snapshot('Remove-Item C:\\ -Recurse')));
    const out = await executeFlowStep(input());
    expect(out).toMatchObject({ kind: 'failed', code: 'binding_drift', policy: true });
    expect(executeTool).not.toHaveBeenCalled();
    expect(createActionIntent).not.toHaveBeenCalled();
  });

  it('a literal parameter that no longer matches the binding is binding_drift', async () => {
    const out = await executeFlowStep(input({
      step: step('fix', 'run_script', { ...RUN_SCRIPT_INPUT, parameters: { mode: 'deep' } }),
    }));
    expect(out).toMatchObject({ kind: 'failed', code: 'binding_drift', policy: true });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('content changed between digest check and pin is binding_drift and never executes', async () => {
    // Success order: the FIRST read is the bound content. A second read would
    // see new content — there must not be one: the pin IS the checked read.
    const bound = built(snapshot());
    vi.mocked(buildRunScriptSnapshot)
      .mockResolvedValueOnce(bound)
      .mockResolvedValueOnce(built(snapshot('Remove-Item C:\\ -Recurse')));
    const ok = await executeFlowStep(input());
    expect(ok.kind).toBe('completed');
    expect(buildRunScriptSnapshot).toHaveBeenCalledTimes(1);
    const pinned = vi.mocked(executeTool).mock.calls[0]![3]!.context!.verifiedRunScript!;
    expect(pinned.snapshot).toBe(bound.snapshot);
    expect(preApprovalMaterialFromSnapshot(pinned.snapshot, RUN_SCRIPT_INPUT).contentDigest).toBe(binding().contentDigest);

    // Drift order: the one read already sees the new content ⇒ refused.
    vi.mocked(executeTool).mockClear();
    vi.mocked(buildRunScriptSnapshot).mockReset()
      .mockResolvedValueOnce(built(snapshot('Remove-Item C:\\ -Recurse')))
      .mockResolvedValueOnce(bound);
    const drift = await executeFlowStep(input());
    expect(drift).toMatchObject({ kind: 'failed', code: 'binding_drift', policy: true });
    expect(buildRunScriptSnapshot).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('variable-dependent script at run time is binding_drift', async () => {
    vi.mocked(buildRunScriptSnapshot).mockResolvedValue(built(snapshot('Write-Output fix', [
      { orgId: ORG, key: 'API_TOKEN', state: 'present', variableId: 'v1', version: 1, isSecret: true, ownerScope: 'organization' },
    ])));
    const out = await executeFlowStep(input());
    expect(out).toMatchObject({ kind: 'failed', code: 'binding_drift', policy: true });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('a deleted script at run time is binding_drift', async () => {
    vi.mocked(buildRunScriptSnapshot).mockResolvedValue({ kind: 'target_absent' });
    const out = await executeFlowStep(input());
    expect(out).toMatchObject({ kind: 'failed', code: 'binding_drift', policy: true });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('intent created already cancelled no_eligible_approvers fails policy', async () => {
    vi.mocked(createActionIntent).mockResolvedValue({ id: INTENT, status: 'cancelled', errorCode: 'no_eligible_approvers' } as never);
    const out = await executeFlowStep(input({ version: version({ preApprovals: [] }) }));
    expect(out).toMatchObject({ kind: 'failed', code: 'no_eligible_approvers', policy: true });
  });

  // Review finding 5: a SERVER-side command timeout means the script may
  // still be running on the device — never a definite failure for tier >= 2.
  it('a run_script device the server timed out is unknown_outcome, not a failure', async () => {
    vi.mocked(executeTool).mockResolvedValue(JSON.stringify({
      results: { [DEVICE]: { status: 'timeout', error: 'Command timed out after 60000ms', timedOutBy: 'server', commandId: 'c1' } },
    }));
    const out = await executeFlowStep(input(), noSleep);
    expect(out).toMatchObject({ kind: 'unknown_outcome', approvalMode: 'pre_approved' });
  });

  it('a run_script device reporting status timeout is unknown_outcome', async () => {
    vi.mocked(executeTool).mockResolvedValue(JSON.stringify({
      results: { [DEVICE]: { status: 'timeout', error: 'Script timed out' } },
    }));
    const out = await executeFlowStep(input(), noSleep);
    expect(out).toMatchObject({ kind: 'unknown_outcome' });
  });

  it('a run_script call where every device was suppressed by a maintenance window is a failed step, not completed', async () => {
    vi.mocked(executeTool).mockResolvedValue(JSON.stringify({
      results: { [DEVICE]: { status: 'suppressed', suppressedBy: 'maintenance_window', message: 'Device is in a maintenance window' } },
    }));
    const out = await executeFlowStep(input(), noSleep);
    expect(out).toMatchObject({ kind: 'failed', code: 'step_failed', policy: false });
    expect((out as { message: string }).message).toMatch(/maintenance window/i);
  });

  it('tier-3 timeout is unknown_outcome', async () => {
    vi.useFakeTimers();
    vi.mocked(executeTool).mockReturnValue(new Promise<string>(() => {}));
    const pending = executeFlowStep(input({ deadline: Date.now() + 5_000 }));
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(pending).resolves.toMatchObject({ kind: 'unknown_outcome' });
  });
});

// #10288: a Tier-3 external (tool-source) step parks on a `source: 'flow'`
// intent BOUND to the pinned tool row + revision. Without the binding
// createActionIntent classifies the qualified `<slug>__<name>` with the CORE
// classifier ("unknown tool", tier 4) and refuses it `tool_blocked`, so the
// step failed instead of waiting for approval. The binding is what the dispatch
// claim (tenantStepStillPinned) and release revalidation check against.
describe('executeFlowStep — tier-3 external (tool-source) steps', () => {
  const closeStep = () => step('close', TENANT_T3.qualifiedName, { summary: 'resolved on {{trigger.device.id}}' });

  it('parks on a flow intent bound to the pinned tool row and revision, and never executes', async () => {
    const flowAuth = auth();
    const out = await executeFlowStep(input({ auth: flowAuth, step: closeStep(), pin: tenantPin(TENANT_T3, 'close') }));
    expect(out).toMatchObject({ kind: 'park_approval', intentId: INTENT, renderedInput: { summary: `resolved on ${DEVICE}` } });
    expect(createActionIntent).toHaveBeenCalledTimes(1);
    const [authArg, intentInput] = vi.mocked(createActionIntent).mock.calls[0]!;
    expect(authArg).toBe(flowAuth);
    expect(intentInput).toMatchObject({
      source: 'flow',
      orgId: ORG,
      toolName: TENANT_T3.qualifiedName,
      input: { summary: `resolved on ${DEVICE}` },
      externalTool: { toolSourceToolId: TENANT_T3.id, revision: 'rev-1', sourceName: 'Vendor' },
      flowRun: { runId: RUN, stepRowId: STEP_ROW, delegatorUserId: DELEGATOR, flowName: 'Nightly fix', stepId: 'close' },
    });
    // An external step is never a built-in intent.
    expect(intentInput.flowRun).not.toHaveProperty('builtin');
    expect(loadTenantToolForExecution).toHaveBeenCalledWith(TENANT_T3.id, flowAuth, ORG);
    expect(executeTenantToolDetailed).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('a core Tier-3 step carries no external binding', async () => {
    await executeFlowStep(input({ version: version({ preApprovals: [] }) }));
    expect(vi.mocked(createActionIntent).mock.calls[0]![1]).not.toHaveProperty('externalTool');
  });

  it('a tool the flow principal can no longer load fails policy before any intent is minted', async () => {
    vi.mocked(loadTenantToolForExecution).mockResolvedValue(null);
    const out = await executeFlowStep(input({ step: closeStep(), pin: tenantPin(TENANT_T3, 'close') }));
    expect(out).toMatchObject({ kind: 'failed', code: 'tool_unavailable', policy: true });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(executeTenantToolDetailed).not.toHaveBeenCalled();
  });

  it('a live revision that moved off the pin is drift and never parks', async () => {
    vi.mocked(loadTenantToolForExecution).mockResolvedValue({ descriptor: { ...TENANT_T3, revision: 'rev-2' }, source: {}, tool: {} } as never);
    const out = await executeFlowStep(input({ step: closeStep(), pin: tenantPin(TENANT_T3, 'close') }));
    expect(out).toMatchObject({ kind: 'failed', code: 'drift', policy: true });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(executeTenantToolDetailed).not.toHaveBeenCalled();
  });

  it('is never pre-approved: a stored binding for its step on an honouring run fails closed and never executes', async () => {
    const out = await executeFlowStep(input({
      run: run({ preApprovalsHonored: true }),
      version: version({ preApprovals: [binding('close', { summary: 'resolved on {{trigger.device.id}}' })] }),
      step: closeStep(),
      pin: tenantPin(TENANT_T3, 'close'),
    }));
    expect(out).toMatchObject({ kind: 'failed', code: 'binding_drift', policy: true });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(executeTenantToolDetailed).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('an intent cancelled at creation (nobody may approve) fails the step; it never self-approves', async () => {
    vi.mocked(createActionIntent).mockResolvedValue({ id: INTENT, status: 'cancelled', errorCode: 'no_eligible_approvers' } as never);
    const out = await executeFlowStep(input({ step: closeStep(), pin: tenantPin(TENANT_T3, 'close') }));
    expect(out).toMatchObject({ kind: 'failed', code: 'no_eligible_approvers', policy: true });
    expect(executeTenantToolDetailed).not.toHaveBeenCalled();
  });
});

describe('executeFlowStep — tier 1/2 and tenant', () => {
  it('tier-1 core tool executes and its JSON result is the output', async () => {
    vi.mocked(executeTool).mockResolvedValue(JSON.stringify({ hostname: 'kit-01' }));
    const out = await executeFlowStep(input({
      step: step('look', 'get_device_details', { deviceId: '{{trigger.device.id}}' }), pin: LOOKUP_PIN,
    }));
    expect(out).toMatchObject({ kind: 'completed', output: { hostname: 'kit-01' }, truncated: false });
    expect(vi.mocked(executeTool).mock.calls[0]!.slice(0, 2)).toEqual(['get_device_details', { deviceId: DEVICE }]);
  });

  it('a core tool runs in the flow principal\'s own org-scoped, user-less DB context; self-managed run_script does not', async () => {
    dbContexts.length = 0;
    await executeFlowStep(input({
      step: step('look', 'get_device_details', { deviceId: DEVICE }), pin: LOOKUP_PIN,
    }));
    expect(dbContexts).toEqual([expect.objectContaining({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG], userId: null })]);

    dbContexts.length = 0;
    await executeFlowStep(input());
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(dbContexts).toEqual([]);
  });

  it('a non-JSON result is stored as { text }', async () => {
    vi.mocked(executeTool).mockResolvedValue('plain words');
    const out = await executeFlowStep(input({
      step: step('look', 'get_device_details', { deviceId: DEVICE }), pin: LOOKUP_PIN,
    }));
    expect(out).toMatchObject({ kind: 'completed', output: { text: 'plain words' } });
  });

  it('an { error } result fails the step (not a policy failure)', async () => {
    vi.mocked(executeTool).mockResolvedValue(JSON.stringify({ error: 'Device not found' }));
    const out = await executeFlowStep(input({
      step: step('look', 'get_device_details', { deviceId: DEVICE }), pin: LOOKUP_PIN,
    }), noSleep);
    expect(out).toMatchObject({ kind: 'failed', code: 'step_failed', policy: false });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('tenant step executes with actor kind flow', async () => {
    const flowAuth = auth();
    const out = await executeFlowStep(input({
      auth: flowAuth,
      step: step('ticket', TENANT_T2.qualifiedName, { summary: 'disk full on {{trigger.device.id}}' }),
      pin: tenantPin(TENANT_T2, 'ticket'),
    }));
    expect(out).toMatchObject({ kind: 'completed', output: { ok: true } });
    expect(executeTenantToolDetailed).toHaveBeenCalledWith(
      TENANT_T2,
      { summary: `disk full on ${DEVICE}` },
      flowAuth,
      { orgId: ORG, actor: { kind: 'flow', id: RUN }, surface: 'flow' },
    );
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('tier-1 transient error retries 3 times', async () => {
    vi.mocked(executeTool)
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(JSON.stringify({ error: 'Upstream failed', status: 503 }))
      .mockResolvedValueOnce(JSON.stringify({ error: 'rate limited', status: 429 }))
      .mockResolvedValueOnce(JSON.stringify({ hostname: 'kit-01' }));
    const out = await executeFlowStep(input({
      step: step('look', 'get_device_details', { deviceId: DEVICE }), pin: LOOKUP_PIN,
    }), noSleep);
    expect(out).toMatchObject({ kind: 'completed', output: { hostname: 'kit-01' } });
    expect(executeTool).toHaveBeenCalledTimes(4);
    expect(noSleep.sleep.mock.calls.map((c) => c[0])).toEqual([1_000, 4_000, 16_000]);
  });

  it('tier-1 transient errors past the last retry fail the step', async () => {
    vi.mocked(executeTool).mockResolvedValue(JSON.stringify({ error: 'Service unavailable', status: 503 }));
    const out = await executeFlowStep(input({
      step: step('look', 'get_device_details', { deviceId: DEVICE }), pin: LOOKUP_PIN,
    }), noSleep);
    expect(out).toMatchObject({ kind: 'failed', code: 'step_failed', policy: false });
    expect(executeTool).toHaveBeenCalledTimes(4);
  });

  it('the default backoff sleeps 1 s / 4 s / 16 s on real (fake) timers', async () => {
    vi.useFakeTimers();
    vi.mocked(executeTenantToolDetailed)
      .mockResolvedValueOnce({ isError: true, text: 'HTTP 503 Service Unavailable' })
      .mockResolvedValueOnce({ isError: false, text: '{"id":7}' });
    const pending = executeFlowStep(input({
      step: step('get', TENANT_T1.qualifiedName, {}), pin: tenantPin(TENANT_T1, 'get'),
    }));
    await vi.advanceTimersByTimeAsync(999);
    expect(executeTenantToolDetailed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toMatchObject({ kind: 'completed', output: { id: 7 } });
    expect(executeTenantToolDetailed).toHaveBeenCalledTimes(2);
  });

  it('tier-2 error never retries', async () => {
    vi.mocked(executeTenantToolDetailed).mockResolvedValue({ isError: true, text: 'HTTP 503 Service Unavailable' });
    const out = await executeFlowStep(input({
      step: step('ticket', TENANT_T2.qualifiedName, { summary: 'x' }), pin: tenantPin(TENANT_T2, 'ticket'),
    }), noSleep);
    expect(out).toMatchObject({ kind: 'failed', code: 'step_failed', policy: false });
    expect(executeTenantToolDetailed).toHaveBeenCalledTimes(1);
    expect(noSleep.sleep).not.toHaveBeenCalled();
  });

  it('late result after timeout is not returned', async () => {
    vi.useFakeTimers();
    let resolveLate!: (v: string) => void;
    vi.mocked(executeTool).mockReturnValue(new Promise<string>((r) => { resolveLate = r; }));
    const pending = executeFlowStep(input({
      step: step('look', 'get_device_details', { deviceId: DEVICE }), pin: LOOKUP_PIN, deadline: Date.now() + 2_000,
    }));
    await vi.advanceTimersByTimeAsync(2_001);
    const out = await pending;
    expect(out).toMatchObject({ kind: 'failed', code: 'step_timeout', policy: false });
    resolveLate(JSON.stringify({ hostname: 'late' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(out)).not.toContain('late');
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('events published by a step carry the run\'s chain depth', async () => {
    let frame: unknown;
    vi.mocked(executeTool).mockImplementation(async () => {
      frame = currentFlowExecutionFrame();
      return '{}';
    });
    await executeFlowStep(input({
      run: run({ chainDepth: 2 }),
      step: step('look', 'get_device_details', { deviceId: DEVICE }), pin: LOOKUP_PIN,
    }));
    expect(frame).toEqual({ runId: RUN, chainDepth: 2 });
    expect(currentFlowExecutionFrame()).toBeUndefined();
  });

  it('oversized output is truncated', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(FLOW_RUN_LIMITS.maxStoredOutputBytes + 10) });
    vi.mocked(executeTool).mockResolvedValue(big);
    const out = await executeFlowStep(input({
      step: step('look', 'get_device_details', { deviceId: DEVICE }), pin: LOOKUP_PIN,
    }));
    expect(out.kind).toBe('completed');
    if (out.kind !== 'completed') return;
    expect(out.truncated).toBe(true);
    expect(out.output).toEqual({ truncated: true, preview: big.slice(0, 8_192) });
  });
});

describe('classifyToolResult / isErrorResult', () => {
  it('a top-level error is an error', () => {
    expect(classifyToolResult('get_device_details', { error: 'nope' })).toEqual({ kind: 'error' });
    expect(isErrorResult('get_device_details', { error: 'nope' })).toBe(true);
  });

  it('{ success: false, error } is an error (the release worker records it completed)', () => {
    expect(isErrorResult('manage_services', { success: false, error: 'Service not found' })).toBe(true);
  });

  it('a plain result is ok', () => {
    expect(classifyToolResult('get_device_details', { hostname: 'h' })).toEqual({ kind: 'ok' });
    expect(classifyToolResult('run_script', { results: { a: { exitCode: 0 } } })).toEqual({ kind: 'ok' });
  });

  it('run_script: every device errored is an error; one timed out is may_still_run (outranks errors)', () => {
    expect(classifyToolResult('run_script', { results: { a: { error: 'x' }, b: { error: 'y' } } })).toEqual({ kind: 'error' });
    expect(classifyToolResult('run_script', { results: { a: { error: 'x' }, b: { status: 'timeout', error: 't', timedOutBy: 'server' } } }))
      .toMatchObject({ kind: 'may_still_run' });
    expect(isErrorResult('run_script', { results: { b: { status: 'timeout', error: 't', timedOutBy: 'server' } } })).toBe(false);
  });

  it('run_script: nothing ran when every device was suppressed or refused; anything that ran is ok', () => {
    expect(classifyToolResult('run_script', { results: { a: { status: 'suppressed', suppressedBy: 'maintenance_window' } } }))
      .toMatchObject({ kind: 'nothing_ran' });
    expect(classifyToolResult('run_script', { results: { a: { status: 'suppressed' }, b: { error: 'offline' } } }))
      .toMatchObject({ kind: 'nothing_ran' });
    expect(classifyToolResult('run_script', { results: { a: { status: 'suppressed' }, b: { exitCode: 0 } } })).toEqual({ kind: 'ok' });
  });
});

describe('isTransientFlowToolError', () => {
  it.each([
    ['network error (ECONNRESET)', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), true],
    ['network error (fetch failed)', new TypeError('fetch failed'), true],
    ['500', { error: 'Internal error', status: 500 }, true],
    ['503', { error: 'Service unavailable', statusCode: 503 }, true],
    ['429', { error: 'Too many requests', status: 429 }, true],
    ['503 in tenant text', { error: 'HTTP 503 Service Unavailable' }, true],
    ['400', { error: 'Bad request', status: 400 }, false],
    ['403', { error: 'Forbidden', status: 403 }, false],
    ['{ error: "not found" }', { error: 'not found' }, false],
    ['a plain Error', new Error('Device not found or access denied'), false],
    ['a success object', { hostname: 'kit-01' }, false],
  ])('%s ⇒ %s', (_label, value, expected) => {
    expect(isTransientFlowToolError(value)).toBe(expected);
  });
});
