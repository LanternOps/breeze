// apps/api/src/services/aiAgents/runLoop.analysis.test.ts
/**
 * Execution plane W04 (#5715) — the `analysis`-profile wiring into the run
 * loop: the read-only + workspace tool floor and the fixed injection-
 * containment system-prompt section, the frozen-device-set auth context, and
 * the sandbox lifecycle + compute settlement in `finalizeWorkspaceForRun`
 * (every billing source, every usage shape — measured, estimated, none, and
 * a mid-loop throw).
 *
 * Its own file rather than more cases in `runLoop.test.ts` — same reasoning
 * as `runLoop.sweep.test.ts`'s header: an analysis run needs a DIFFERENT
 * seeded run row (`staged_inputs`/`compute_reserved_cents`, device-less) plus
 * two extra module mocks neither `runLoop.test.ts` nor `runLoop.sweep.test.ts`
 * need (`../workspace/sandboxBackend`, `../workspace/workspaceService`). The
 * mock harness below is the same shape as `runLoop.sweep.test.ts`'s, trimmed
 * to what an analysis run actually reaches (no sweep-evidence mock — an
 * analysis run never calls `isSweepProfile`'s branch in `loadRunContext`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
} from '@breeze/shared';
import type { AiAgentRunStagedInputs } from '../../db/schema/aiAgents';

const ORG_ID = '00000000-0000-4000-8000-0000000000d1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000d2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000d3';
const DEVICE_A = '00000000-0000-4000-8000-0000000000d4';
const DEVICE_B = '00000000-0000-4000-8000-0000000000d5';
const RUN_ID = '00000000-0000-4000-8000-0000000000d6';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// db mock (same harness shape as runLoop.sweep.test.ts — see its own comments
// — PLUS `update`: the workspace finalizer's best-effort "stamp the measured
// provider numbers" write calls `db.update(...)`, which neither the sweep nor
// the main runLoop harness ever needed.)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  lastRow: {} as Record<string, unknown>,
  selects: [] as Array<{ table: string; where?: SQL }>,
  ambientContext: undefined as { scope: string } | undefined,
}));

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (queue && queue.length > 0) {
    const rows = queue.shift() as unknown[];
    if (rows.length > 0) dbMockState.lastRow[table] = rows[0];
    return rows;
  }
  if (table === 'ai_agent_runs' && dbMockState.lastRow.ai_agent_runs) {
    const base = dbMockState.lastRow.ai_agent_runs as Record<string, unknown>;
    const calls = transitionRunStatus.mock.calls;
    const last = calls[calls.length - 1];
    if (!last) return [base];
    const patch = (last[3] ?? {}) as Record<string, unknown>;
    return [{
      ...base,
      status: last[2],
      summary: (patch.summary as string | null | undefined) ?? null,
      outcome: patch.outcome ?? {},
      intentIds: patch.intentIds ?? [],
    }];
  }
  if (table === 'ai_agents' && dbMockState.lastRow.ai_agents) {
    return [dbMockState.lastRow.ai_agents];
  }
  // A best-effort re-read (e.g. `runFinishedNotify`'s `ticket_drafts` count,
  // or a second `organizations` read on a path this suite never exercises)
  // throws here, exactly like every other unseeded table — the caller's own
  // try/catch (or `finishRun`'s notify try/catch) is what makes that safe.
  throw new Error(`No queued rows for table ${table}`);
}

// AI Suggested Fixes W3 — loadRunContext's proven-fix lookup. Mocked so it never
// consumes this file's queued db rows; returns null (no memory) by default.
const loadProvenFixesForRun = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('../fixMemory/runMemory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fixMemory/runMemory')>()),
  loadProvenFixesForRun,
}));

vi.mock('../../db', () => {
  const makeSelect = () => ({
    from: vi.fn((table: unknown) => {
      const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
      const captured: { table: string; where?: SQL } = { table: tableName };
      dbMockState.selects.push(captured);
      const builder: Record<string, unknown> = {
        where: vi.fn((cond: SQL) => { captured.where = cond; return builder; }),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => nextRows(tableName)).then(resolve, reject),
      };
      return builder;
    }),
  });

  return {
    db: {
      select: vi.fn(() => makeSelect()),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    },
    getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previous = dbMockState.ambientContext;
      dbMockState.ambientContext = { scope: 'system' };
      try {
        return await fn();
      } finally {
        dbMockState.ambientContext = previous;
      }
    }),
  };
});

const transitionRunStatus = vi.hoisted(() =>
  vi.fn<(
    runId: string, from: unknown, to: string, patch?: Record<string, unknown>,
  ) => Promise<boolean>>());
vi.mock('./runService', () => ({ transitionRunStatus }));

const createAgentRunSession = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<string>>());
const startToolExecution = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<string>>());
const completeToolExecution = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<void>>());
const reconcileHungExecutions = vi.hoisted(() => vi.fn<(sessionId: string) => Promise<number>>());
const closeAgentRunSession = vi.hoisted(() =>
  vi.fn<(sessionId: string, status: 'completed' | 'failed') => Promise<void>>());
vi.mock('./executionLedger', () => ({
  createAgentRunSession, startToolExecution, completeToolExecution, reconcileHungExecutions, closeAgentRunSession,
}));

const resolveEffectiveAgentSystem = vi.hoisted(() =>
  vi.fn<(orgId: string, kind: string) => Promise<AiAgentPolicySnapshot | null>>());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

const readAiKillState = vi.hoisted(() =>
  vi.fn<() => Promise<{ killed: boolean; epoch: number }>>(async () => ({ killed: false, epoch: 0 })));
const getCachedAiKillStateSnapshot = vi.hoisted(() =>
  vi.fn<() => { killed: boolean; epoch: number }>(() => ({ killed: false, epoch: 0 })));
vi.mock('../aiKillState', () => ({ readAiKillState, getCachedAiKillStateSnapshot }));

const revalidateActExecution = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<unknown>>());
vi.mock('./actRevalidation', () => ({ revalidateActExecution }));

const verifyActExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<{ execution: string; verification: string }>>());
const recordActVerifyFailureAlert = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<void>>(async () => undefined));
vi.mock('./actVerify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actVerify')>();
  return { ...actual, verifyActExecution, recordActVerifyFailureAlert };
});

const executeBuiltInPlaybookForRun = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<unknown>>());
vi.mock('./playbookActExecutor', () => ({ executeBuiltInPlaybookForRun }));

const publishEvent = vi.hoisted(() =>
  vi.fn<(type: string, orgId: string, payload: unknown, source: string) => Promise<string>>(async () => 'event-1'));
vi.mock('../eventBus', () => ({ publishEvent }));

const queryMock = vi.hoisted(() =>
  vi.fn<(params: { prompt: unknown; options: Record<string, unknown> }) => unknown>());
// Partial mock: `buildOutcomeSdkTools` calls the REAL `tool()` to build the
// `submit_analysis` SDK tool — only `query` needs faking here.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, query: queryMock };
});

const createBreezeMcpServer = vi.hoisted(() =>
  vi.fn<(
    getAuth: () => unknown,
    pre?: Hooks['pre'],
    post?: Hooks['post'],
    getActiveSession?: () => unknown,
    extraTools?: Array<{ name: string }>,
    options?: { onlyTools?: ReadonlySet<string> },
  ) => unknown>());
vi.mock('../aiAgentSdkTools', () => ({
  createBreezeMcpServer,
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
  // runLoop.ts's full-profile exposure (WQ3, #6755) derives from
  // Object.keys(TOOL_TIERS); this suite never exercises a full-profile run,
  // but the module-level computation still runs, so this must exist.
  TOOL_TIERS: { query_devices: 1 },
  // A full-profile run intersects its exposure with the declared set (#7427);
  // mirrors TOOL_TIERS above.
  listChatSurfaceToolNames: () => ['query_devices'],
  POST_TOOL_USE_TIMEOUT_MS: 10_000,
}));

const createActionIntent = vi.hoisted(() =>
  vi.fn<(auth: unknown, input: Record<string, unknown>) => Promise<{ id: string; status: string }>>());
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));

const persistAlertVerdict = vi.hoisted(() =>
  vi.fn<(run: unknown, verdict: unknown, agentAuth: unknown) => Promise<{
    verdictId: string; intentId: string | null; suggestionDisposition: 'intent_created' | 'not_created';
  }>>());
vi.mock('./alertVerdicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./alertVerdicts')>();
  return { ...actual, persistAlertVerdict };
});

const resolveRecipientUserIds = vi.hoisted(() =>
  vi.fn<(agent: unknown, orgId: string) => Promise<string[]>>(async () => []));
vi.mock('./recipients', () => ({ resolveRecipientUserIds }));

const createNotification = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<string | null>>(async () => 'notification-1'));
vi.mock('../userNotifications', () => ({ createNotification }));

const enqueueAgentNotifyRetry = vi.hoisted(() => vi.fn<(runId: string) => Promise<void>>(async () => undefined));
vi.mock('../../jobs/agentNotifyRetryWorker', () => ({ enqueueAgentNotifyRetry }));

const scheduleFixWatch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
vi.mock('../../jobs/fixWatchWorker', () => ({ scheduleFixWatch }));

// AI model registry W03 (Task 12): the run loop resolves `ai_agents` through
// the registry and settles through the single billing path.
const resolveModel = vi.hoisted(() => vi.fn());
vi.mock('../aiModels/resolveModel', () => ({ resolveModel }));
const settleInvocation = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<{ costCents: number; invocationIds: string[]; deferred: boolean }>>(
    async () => ({ costCents: 0, invocationIds: [], deferred: false })));
vi.mock('../aiModels/settleInvocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiModels/settleInvocation')>()),
  settleInvocation,
}));

const buildClaudeSdkChildEnv = vi.hoisted(() =>
  vi.fn<(resolved: { source: string }) => Record<string, string>>(() => ({ CI: 'true' })));
vi.mock('../streamingSessionManager', () => ({ buildClaudeSdkChildEnv }));

const settleComputeCents = vi.hoisted(() =>
  vi.fn<(orgId: string, runId: string, cents: number, source: 'platform' | 'partner_key') => Promise<void>>(
    async () => undefined,
  ));
const calculateComputeCents = vi.hoisted(() =>
  vi.fn<(backend: string, usage: unknown, memGb: number) => number>(() => 0));
vi.mock('../aiCostTracker', () => ({
  settleComputeCents, calculateComputeCents,
}));
const reserveAiBudget = vi.hoisted(() => vi.fn());
const markAiBudgetReservationIndeterminate = vi.hoisted(() => vi.fn());
vi.mock('../aiBudgetReservations', () => ({ reserveAiBudget, markAiBudgetReservationIndeterminate }));

// Execution plane W04 — the sandbox adapter. `getSandboxBackend()` is invoked
// unconditionally as an ARGUMENT to `new WorkspaceService(...)` even though
// the class itself is faked below, so a real (unmocked) backend resolution —
// which needs env/config this suite never sets up — must never run.
const getSandboxBackend = vi.hoisted(() => vi.fn(() => ({ name: 'fake' as const })));
vi.mock('../workspace/sandboxBackend', () => ({ getSandboxBackend }));

interface FakeSandboxUsage { cpuMs: number; wallMs: number; memAllocatedMb: number }

// Execution plane W04 — the per-run sandbox workspace. `finalize` is ONE
// shared mock (never more than one workspace exists per run in this suite)
// and `usageEstimated` a plain mutable field standing in for the real
// class's private-backed getter — `finalizeWorkspaceForRun` only ever READS
// it, never sets it, so a getter here would add nothing.
const workspaceServiceState = vi.hoisted(() => ({
  finalize: vi.fn<() => Promise<FakeSandboxUsage | null>>(),
  usageEstimated: false,
  constructorArgs: [] as Array<Record<string, unknown>>,
}));
vi.mock('../workspace/workspaceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/workspaceService')>();
  class FakeWorkspaceService {
    constructor(ctx: Record<string, unknown>) {
      workspaceServiceState.constructorArgs.push(ctx);
    }

    finalize(): Promise<FakeSandboxUsage | null> {
      return workspaceServiceState.finalize();
    }

    get usageEstimated(): boolean {
      return workspaceServiceState.usageEstimated;
    }
  }
  return {
    ...actual,
    // Re-exports the REAL `WORKSPACE_MEMORY_GB`/`deploymentRegion` — the run
    // loop feeds the former straight into the (mocked) `calculateComputeCents`
    // call, so a faked value here would make that call's arguments a lie.
    WorkspaceService: FakeWorkspaceService,
  };
});
// Deliberately NOT mocked — `registerWorkspace`/`unregisterWorkspace` are the
// REAL process-local map, so `getWorkspaceForRun` (imported below) can prove
// the run loop's own teardown actually ran, not just that our fake class's
// `finalize` was invoked.
import { __resetWorkspaceRegistry, getWorkspaceForRun } from '../workspace/workspaceRegistry';

import { executeAgentRun } from './runLoop';
import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import { ANALYSIS_TOOL_ALLOWLIST } from './analysisProfile';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function policy(overrides: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true,
    mode: 'shadow',
    toolAllowlist: [],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: true },
    recipients: { userIds: [], roleIds: [] },
    actAssets: { scriptIds: [] },
    instructions: null,
    cooldownSeconds: 900,
    ...overrides,
  };
}

function snapshot(effective: AiAgentPolicy): AiAgentPolicySnapshot {
  return {
    schemaVersion: 6,
    agentId: AGENT_ID,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-09-14T00:00:00Z').toISOString(),
  };
}

/** The admission-frozen inputs of a device-less analysis run. */
const STAGED_INPUTS: AiAgentRunStagedInputs = { handles: [], deviceIds: [DEVICE_A, DEVICE_B], region: 'eu' };

function seedRows(options: {
  effective?: AiAgentPolicy;
  stagedInputs?: AiAgentRunStagedInputs | null;
  computeReservedCents?: number | null;
  fundingSource?: 'platform' | 'partner_key' | null;
} = {}) {
  const effective = options.effective ?? policy();
  const stagedInputs = options.stagedInputs === undefined ? STAGED_INPUTS : options.stagedInputs;
  const computeReservedCents = options.computeReservedCents === undefined ? 25 : options.computeReservedCents;

  dbMockState.rowQueues.ai_agent_runs = [[{
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: null,
    alertId: null,
    ticketId: null,
    anomalyIncidentId: null,
    status: 'queued',
    modeAtStart: 'shadow',
    triggerKind: 'manual',
    policySnapshot: snapshot(effective),
    profile: 'analysis',
    correlationGroupId: null,
    scheduleId: null,
    triggerRef: {},
    taskId: null,
    taskStepKey: null,
    taskAttemptOrdinal: null,
    stagedInputs,
    computeReservedCents,
    fundingSource: options.fundingSource ?? null,
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    name: 'Analysis Agent',
    kind: 'triage',
    recipients: { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(effective));
  return effective;
}

const hooks: Hooks = {};
let lastQueryOptions: Record<string, unknown> | undefined;
const closeMock = vi.fn();
/** Deep snapshots of every `transitionRunStatus` patch, taken at call time. */
const persistedPatches: Array<Record<string, unknown>> = [];

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: '',
    total_cost_usd: 0.01,
    usage: { input_tokens: 300, output_tokens: 100 },
    ...overrides,
  };
}

function scriptQuery(script: {
  toolCalls?: Array<{ tool: string; input: Record<string, unknown> }>;
  assistantText?: string;
  results?: Array<Record<string, unknown>>;
} = {}) {
  queryMock.mockImplementation((params: { prompt: unknown; options: Record<string, unknown> }) => {
    lastQueryOptions = params.options;
    const generator = (async function* () {
      for (const call of script.toolCalls ?? []) {
        const verdict = await hooks.pre!(call.tool, call.input);
        if (verdict.allowed) {
          await hooks.post!(call.tool, call.input, '{"status":"recorded"}', false, 5);
        } else {
          await hooks.post!(call.tool, call.input, JSON.stringify({ error: verdict.error }), true, 0);
        }
      }
      if (script.assistantText !== undefined) {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: script.assistantText }] } };
      }
      for (const result of script.results ?? [resultMessage()]) yield result;
    })();
    return Object.assign(generator, { close: closeMock, interrupt: vi.fn() });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceRegistry();
  reserveAiBudget.mockResolvedValue({
    kind: 'unlimited', reservationId: '00000000-0000-4000-8000-0000000000e1',
    dailyPeriodKey: '2026-09-14', monthlyPeriodKey: '2026-09-01', status: 'active',
  });
  markAiBudgetReservationIndeterminate.mockResolvedValue({
    kind: 'indeterminate', reservationId: '00000000-0000-4000-8000-0000000000e1',
  });
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_REGION', 'eu');
  dbMockState.rowQueues = {};
  dbMockState.lastRow = {};
  dbMockState.selects.length = 0;
  dbMockState.ambientContext = undefined;
  lastQueryOptions = undefined;
  // Snapshot the patch AT CALL TIME. `finishRun` hands the live outcome object
  // to `transitionRunStatus`, and in production that is when it is serialized
  // to jsonb — a plain `mock.calls` read would observe LATER mutations (the
  // `finally`'s) through the same reference and make the teardown-before-
  // finishRun ordering untestable.
  persistedPatches.length = 0;
  transitionRunStatus.mockImplementation(async (_runId, _from, _to, patch) => {
    persistedPatches.push(JSON.parse(JSON.stringify(patch ?? {})));
    return true;
  });
  let execCounter = 0;
  createAgentRunSession.mockResolvedValue('session-1');
  startToolExecution.mockImplementation(async () => `exec-${++execCounter}`);
  completeToolExecution.mockResolvedValue(undefined);
  reconcileHungExecutions.mockResolvedValue(0);
  closeAgentRunSession.mockResolvedValue(undefined);
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
  resolveRecipientUserIds.mockResolvedValue([]);
  enqueueAgentNotifyRetry.mockResolvedValue(undefined);
  createActionIntent.mockResolvedValue({ id: 'intent-1', status: 'pending_approval' });
  persistAlertVerdict.mockResolvedValue({ verdictId: 'v-1', intentId: null, suggestionDisposition: 'not_created' });
  getCachedAiKillStateSnapshot.mockReturnValue({ killed: false, epoch: 0 });
  getSandboxBackend.mockReturnValue({ name: 'fake' });
  workspaceServiceState.finalize.mockReset();
  workspaceServiceState.finalize.mockResolvedValue(null);
  workspaceServiceState.usageEstimated = false;
  workspaceServiceState.constructorArgs = [];
  calculateComputeCents.mockReturnValue(0);
  settleComputeCents.mockResolvedValue(undefined);
  createBreezeMcpServer.mockImplementation((getAuth, pre, post) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery({ assistantText: 'Analysis complete.' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetWorkspaceRegistry();
});

// ---------------------------------------------------------------------------

describe('analysis profile tool floor and system prompt (execution plane W04)', () => {
  it('exposes exactly the analysis floor + submit_analysis, never the Tier-3 live tools', async () => {
    // Deliberately mismatched agent allowlist — the floor is served
    // regardless (same "floor, not intersection" contract as sweep/verdict;
    // see analysisProfile.ts's `analysisToolAllowlist` docstring).
    seedRows({ effective: policy({ toolAllowlist: ['execute_command', 'run_script', 'file_operations'] }) });

    await executeAgentRun(RUN_ID);

    expect(lastQueryOptions?.allowedTools).toEqual([
      ...ANALYSIS_TOOL_ALLOWLIST.map((name) => `mcp__breeze__${name}`),
      'mcp__breeze__submit_analysis',
    ]);
    const allowedTools = lastQueryOptions?.allowedTools as string[];
    expect(allowedTools).toContain('mcp__breeze__workspace_run');
    expect(allowedTools).toContain('mcp__breeze__export_dataset');
    expect(allowedTools).toContain('mcp__breeze__submit_analysis');
    expect(allowedTools).not.toContain('mcp__breeze__execute_command');
    expect(allowedTools).not.toContain('mcp__breeze__run_script');
    expect(allowedTools).not.toContain('mcp__breeze__file_operations');
  });

  it('renders the fixed injection-containment prompt: no network/device reach, results land in /work/out', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    const systemPrompt = lastQueryOptions?.systemPrompt as string;
    expect(systemPrompt).toContain('CANNOT reach the network or any device');
    expect(systemPrompt).toContain('/work/out');
  });
});

describe('analysis profile auth context is pinned to the frozen device set (execution plane W04)', () => {
  it('gives the tools an AuthContext whose allowedDeviceIds is the staged device set, not the whole org', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    const auth = hooks.getAuth!() as { allowedDeviceIds?: readonly string[] };
    expect(auth.allowedDeviceIds).toEqual([DEVICE_A, DEVICE_B]);
  });
});

describe('sandbox lifecycle + compute settlement (execution plane W04)', () => {
  it('destroys the sandbox and unregisters the workspace exactly once per run', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    expect(getWorkspaceForRun(RUN_ID)).toBeNull();
    expect(workspaceServiceState.finalize).toHaveBeenCalledTimes(1);
  });

  it('settles at the CALCULATED cents when usage was measured (not estimated)', async () => {
    seedRows({ computeReservedCents: 25 });
    workspaceServiceState.finalize.mockResolvedValue({ cpuMs: 4000, wallMs: 9000, memAllocatedMb: 2048 });
    workspaceServiceState.usageEstimated = false;
    calculateComputeCents.mockReturnValue(13);

    await executeAgentRun(RUN_ID);

    expect(settleComputeCents).toHaveBeenCalledWith(ORG_ID, RUN_ID, 13, 'platform');
  });

  it('settles at the RESERVATION — never $0 — when the provider usage came back estimated', async () => {
    seedRows({ computeReservedCents: 25 });
    workspaceServiceState.finalize.mockResolvedValue({ cpuMs: 1000, wallMs: 2000, memAllocatedMb: 2048 });
    workspaceServiceState.usageEstimated = true;

    await executeAgentRun(RUN_ID);

    expect(settleComputeCents).toHaveBeenCalledWith(ORG_ID, RUN_ID, 25, 'platform');
    expect(settleComputeCents).not.toHaveBeenCalledWith(ORG_ID, RUN_ID, 0, 'platform');

    // …and the flag reaches the PERSISTED outcome, not a throwaway object:
    // the run-detail DTO reads `computeUsageEstimated` off this jsonb to tell
    // a worst-case 25¢ from a measured one. Teardown therefore has to run
    // BEFORE `finishRun` serializes the outcome, on the same object.
    const persisted = persistedPatches.at(-1) as { outcome?: Record<string, unknown> } | undefined;
    expect(persisted?.outcome?.computeUsageEstimated).toBe(true);
    expect(persisted?.outcome?.computeCents).toBe(25);
  });

  it('settles at $0 when no sandbox was ever created (the model concluded from datasets alone)', async () => {
    seedRows({ computeReservedCents: 25 });
    workspaceServiceState.finalize.mockResolvedValue(null);

    await executeAgentRun(RUN_ID);

    expect(settleComputeCents).toHaveBeenCalledWith(ORG_ID, RUN_ID, 0, 'platform');
  });

  it('still finalizes the workspace and settles compute when the SDK loop itself throws', async () => {
    seedRows({ computeReservedCents: 25 });
    queryMock.mockImplementation(() => {
      throw new Error('sdk process crashed');
    });

    await executeAgentRun(RUN_ID);

    expect(workspaceServiceState.finalize).toHaveBeenCalledTimes(1);
    expect(settleComputeCents).toHaveBeenCalledTimes(1);
    expect(getWorkspaceForRun(RUN_ID)).toBeNull();
  });

  it('settles compute against the run\'s ADMITTED funding source — a partner-key run still settles (W03)', async () => {
    seedRows({ computeReservedCents: 25, fundingSource: 'partner_key' });
    resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'ai_agents' }));

    await executeAgentRun(RUN_ID);

    expect(settleComputeCents).toHaveBeenCalledWith(ORG_ID, RUN_ID, 0, 'partner_key');
  });

  it('settles compute on the throw path too (a refusal ends the run blocked), from the run row (W03)', async () => {
    seedRows({ computeReservedCents: 25, fundingSource: 'partner_key' });
    resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'ai_agents' }));
    scriptQuery({
      results: [
        { type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_category: 'cyber' },
        resultMessage({ stop_reason: 'refusal' }),
      ],
    });

    await executeAgentRun(RUN_ID);

    expect(transitionRunStatus).toHaveBeenCalledWith(RUN_ID, 'running', 'blocked', expect.objectContaining({ errorCode: 'model_refused' }));
    expect(settleComputeCents).toHaveBeenCalledTimes(1);
    expect(settleComputeCents).toHaveBeenCalledWith(ORG_ID, RUN_ID, 0, 'partner_key');
  });

  it('a run admitted before W03 (no funding_source) settles compute as platform, the previous fail-safe', async () => {
    seedRows({ computeReservedCents: 25, fundingSource: null });

    await executeAgentRun(RUN_ID);

    expect(settleComputeCents).toHaveBeenCalledWith(ORG_ID, RUN_ID, 0, 'platform');
  });
});
