// apps/api/src/services/aiAgents/runLoop.patch.test.ts
/**
 * AI patch agent W01 (#5747) — the `patch` profile's wiring into the run loop:
 * the tool-allowlist FLOOR, the patch budget/turn substitution with
 * maxActionsPerRun 0, the read-only backstop, the evidence load under the
 * system context (and its one hard failure mode), and the finish-time
 * persistence / `patch_plan_missing` split. Zero action intents, by
 * construction.
 *
 * Harness copied from `runLoop.design.test.ts` (same db mock, same leaf-module
 * mocks) — `./patchEvidence` is mocked at the module boundary in place of
 * `./designEvidence`, keeping `patchEvidenceRefs`/`assemblePatchEvidence` REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
  type AiAgentRunProfile,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000d1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000d2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000d3';
const RUN_ID = '00000000-0000-4000-8000-0000000000d6';
const USER_A = '00000000-0000-4000-8000-0000000000d8';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000f1';
const OCCURRENCE_KEY = '2026-09-12T00:00:00+00:00';
const P1 = '00000000-0000-4000-8000-0000000000e1';
const D2 = '00000000-0000-4000-8000-0000000000f5';
const D1 = '00000000-0000-4000-8000-0000000000f4';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// db mock (same harness shape as runLoop.narrative.test.ts — see its comments)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  lastRow: {} as Record<string, unknown>,
  selects: [] as Array<{ table: string; where?: SQL }>,
  ambientContext: undefined as { scope: string } | undefined,
  /** Every scope `loadPatchEvidence` was called under — the evidence load
   *  bypasses RLS and org-pins by hand, so it must run in the system context. */
  patchEvidenceScopes: [] as Array<string | undefined>,
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
  throw new Error(`No queued rows for table ${table}`);
}

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
    db: { select: vi.fn(() => makeSelect()) },
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
// `submit_patch_plan` SDK tool — only `query` needs faking here.
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
  POST_TOOL_USE_TIMEOUT_MS: 10_000,
}));

const createActionIntent = vi.hoisted(() =>
  vi.fn<(auth: unknown, input: Record<string, unknown>) => Promise<{ id: string; status: string }>>());
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));

// W02 (#5748): the minting branch's two reads, seamed so this loop-level suite
// stays about the loop (patchPlan.test.ts pins their semantics).
const w02 = vi.hoisted(() => ({ resolveEligibility: vi.fn(), findIntents: vi.fn() }));
vi.mock('../patchEligibility', () => ({ resolvePatchInstallEligibility: w02.resolveEligibility }));
vi.mock('../actionIntents/intentQuery', () => ({ findIntentsByIdempotencyKey: w02.findIntents }));

const persistAlertVerdict = vi.hoisted(() =>
  vi.fn<(run: unknown, verdict: unknown, agentAuth: unknown) => Promise<{
    verdictId: string; intentId: string | null; suggestionDisposition: 'intent_created' | 'not_created';
  }>>());
vi.mock('./alertVerdicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./alertVerdicts')>();
  return { ...actual, persistAlertVerdict };
});

// `patchEvidence.ts` has its own suite (patchEvidence.test.ts). Mocked at the
// module boundary; `assemblePatchEvidence`/`patchEvidenceRefs` stay REAL so the
// refs the outcome tool validates against are genuinely derived.
const loadPatchEvidence = vi.hoisted(() =>
  vi.fn<(orgId: string, partnerId: string | null) => Promise<unknown>>());
vi.mock('./patchEvidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./patchEvidence')>();
  return { ...actual, loadPatchEvidence };
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

const resolveLlmConfigForOrg = vi.hoisted(() =>
  vi.fn<(orgId: string) => Promise<{ source: string; apiKey?: string; model: string }>>());
vi.mock('../llm/llmConfigResolver', () => ({ resolveLlmConfigForOrg }));

const buildClaudeSdkChildEnv = vi.hoisted(() =>
  vi.fn<(resolved: { source: string }) => Record<string, string>>(() => ({ CI: 'true' })));
vi.mock('../streamingSessionManager', () => ({ buildClaudeSdkChildEnv }));

const recordSessionlessSdkUsage = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
const calculateCostCents = vi.hoisted(() => vi.fn<(...args: unknown[]) => number>(() => 0));
vi.mock('../aiCostTracker', () => ({ recordSessionlessSdkUsage, calculateCostCents }));
const reserveAiBudget = vi.hoisted(() => vi.fn());
const markAiBudgetReservationIndeterminate = vi.hoisted(() => vi.fn());
vi.mock('../aiBudgetReservations', () => ({ reserveAiBudget, markAiBudgetReservationIndeterminate }));

import { AgentRunError, createAgentRunPostToolUse, createAgentRunPreToolUse, executeAgentRun } from './runLoop';
import type { AgentRunOutcome } from './runLoop';
import { PatchEvidenceUnavailableError, assemblePatchEvidence, patchEvidenceRefs, type RawPatchEvidence } from './patchEvidence';
import { PATCH_TOOL_ALLOWLIST, patchLimits } from './patchProfile';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function policy(overrides: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true,
    mode: 'shadow',
    model: 'claude-test-model',
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
    schemaVersion: 7,
    agentId: AGENT_ID,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-09-12T00:00:00Z').toISOString(),
  };
}

function patchRaw(overrides: Partial<RawPatchEvidence['sections']> = {}): RawPatchEvidence {
  return {
    rollup: {
      devicesTotal: 3, devicesNonCompliant: 1, devicesCompliant: 2, outstandingPatches: 1,
      outstandingBySeverity: { critical: 1, important: 0, moderate: 0, low: 0, unrated: 0 },
      oldestOutstandingDays: 30, snapshot: null,
    },
    sections: {
      ringPosture: { rows: [], total: 0 },
      topNonCompliant: {
        rows: [{
          deviceId: D1, hostname: 'WS-01', fields: { outstanding: 1, critical: 1, maintenanceWindowResolves: false },
          patches: [{ patchId: P1, title: 'Cumulative Update KB5041234', vendor: 'Microsoft', severity: 'critical', ageDays: 30, requiresReboot: true }],
        }],
        total: 1,
      },
      rebootBacklog: { rows: [{ deviceId: D2, hostname: 'WS-02', fields: { lastSeenAt: null } }], total: 1 },
      ...overrides,
    },
  };
}

const PATCH_EVIDENCE = assemblePatchEvidence(patchRaw());

const VALID_PATCH_PLAN = {
  summary: 'One device holds a 30-day-old critical update.',
  posture: { compliancePct: 66.7, devicesAtRisk: 1, oldestOutstandingDays: 30 },
  items: [{
    class: 'install', severity: 'high', deviceId: D1, patchIds: [P1],
    title: 'Install KB5041234 on WS-01', detail: 'Critical, outstanding for 30 days.', evidenceRef: 'topNonCompliant',
  }],
};

function seedRows(options: {
  effective?: AiAgentPolicy;
  profile?: AiAgentRunProfile;
  scheduleId?: string | null;
  triggerRef?: Record<string, unknown>;
} = {}) {
  const effective = options.effective ?? policy();
  const profile = options.profile ?? 'patch';

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
    triggerKind: profile === 'patch' ? 'schedule' : 'alert',
    policySnapshot: snapshot(effective),
    profile,
    correlationGroupId: null,
    scheduleId: options.scheduleId === undefined ? SCHEDULE_ID : options.scheduleId,
    triggerRef: options.triggerRef ?? { scheduleId: SCHEDULE_ID, occurrenceKey: OCCURRENCE_KEY, kind: 'patch' },
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    name: 'Patching',
    kind: 'patch',
    recipients: { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(effective));
  return effective;
}

const hooks: Hooks = {};
let lastQueryOptions: Record<string, unknown> | undefined;
let lastPrompt: unknown;
const closeMock = vi.fn();

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    result: '',
    total_cost_usd: 0.05,
    usage: { input_tokens: 900, output_tokens: 200 },
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
    lastPrompt = params.prompt;
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

function finalTransition(): { to: string; patch: Record<string, unknown> } | undefined {
  const calls = transitionRunStatus.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) return undefined;
  return { to: last[2] as string, patch: (last[3] ?? {}) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  reserveAiBudget.mockResolvedValue({
    kind: 'unlimited', reservationId: '00000000-0000-4000-8000-0000000000f1',
    dailyPeriodKey: '2026-09-06', monthlyPeriodKey: '2026-09-01', status: 'active',
  });
  markAiBudgetReservationIndeterminate.mockResolvedValue({
    kind: 'indeterminate', reservationId: '00000000-0000-4000-8000-0000000000f1',
  });
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbMockState.rowQueues = {};
  dbMockState.lastRow = {};
  dbMockState.selects.length = 0;
  dbMockState.ambientContext = undefined;
  dbMockState.patchEvidenceScopes.length = 0;
  lastQueryOptions = undefined;
  lastPrompt = undefined;
  transitionRunStatus.mockResolvedValue(true);
  let execCounter = 0;
  createAgentRunSession.mockResolvedValue('session-1');
  startToolExecution.mockImplementation(async () => `exec-${++execCounter}`);
  completeToolExecution.mockResolvedValue(undefined);
  reconcileHungExecutions.mockResolvedValue(0);
  closeAgentRunSession.mockResolvedValue(undefined);
  resolveLlmConfigForOrg.mockResolvedValue({ source: 'platform', apiKey: 'sk-test', model: 'claude-fallback' });
  resolveRecipientUserIds.mockResolvedValue([]);
  enqueueAgentNotifyRetry.mockResolvedValue(undefined);
  createActionIntent.mockResolvedValue({ id: 'intent-1', status: 'pending_approval' });
  persistAlertVerdict.mockResolvedValue({ verdictId: 'v-1', intentId: null, suggestionDisposition: 'not_created' });
  getCachedAiKillStateSnapshot.mockReturnValue({ killed: false, epoch: 0 });
  loadPatchEvidence.mockImplementation(async () => {
    dbMockState.patchEvidenceScopes.push(dbMockState.ambientContext?.scope);
    return PATCH_EVIDENCE;
  });
  createBreezeMcpServer.mockImplementation((getAuth, pre, post) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery({ assistantText: 'Plan complete.' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function emptyOutcome(): AgentRunOutcome {
  return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
}

function directPre(profile: AiAgentRunProfile, outcome: AgentRunOutcome, extra: Record<string, unknown> = {}) {
  return createAgentRunPreToolUse({
    run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile },
    agentName: 'Patching', agentAuth: {}, agentKind: 'patch',
    guardrailPolicy: {
      enabled: true, mode: 'shadow', toolAllowlist: [],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      deviceId: null, deviceSiteId: null,
    },
    outcome, intentIds: [], allowedPending: new Map<string, number>(), sessionId: null,
    executionIdPending: new Map<string, Array<string | null>>(),
    actPinPending: new Map<string, Array<unknown>>(),
    actReservation: { count: 0 }, deadlineMs: Date.now() + 60_000,
    ...extra,
  } as never);
}

const PATCH_REFS = { refs: patchEvidenceRefs(PATCH_EVIDENCE), evidenceTruncated: false, generatedAt: '2026-09-14T02:00:00.000Z' };

describe('patch run tool exposure is the FLOOR, not the agent allowlist', () => {
  it('exposes exactly the patch drill-down floor plus submit_patch_plan', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['run_script', 'manage_patches:install'] }) });

    await executeAgentRun(RUN_ID);

    const exposed = lastQueryOptions?.allowedTools as string[];
    expect(exposed).toContain('mcp__breeze__submit_patch_plan');
    expect(exposed).not.toContain('mcp__breeze__run_script');
    expect(new Set(exposed)).toEqual(new Set([
      ...PATCH_TOOL_ALLOWLIST.map((name) => `mcp__breeze__${name.split(':')[0]}`),
      'mcp__breeze__submit_patch_plan',
    ]));
    const extraTools = createBreezeMcpServer.mock.calls[0]?.[4] as Array<{ name: string }> | undefined;
    expect(extraTools?.map((t) => t.name)).toEqual(['submit_patch_plan']);
    const options = createBreezeMcpServer.mock.calls[0]?.[5] as { onlyTools?: ReadonlySet<string> } | undefined;
    expect(options?.onlyTools).toEqual(new Set(PATCH_TOOL_ALLOWLIST.map((n) => n.split(':')[0])));
  });

  it('the guardrail allowlist admits manage_patches:list but never :install on a patch run', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_patches'] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_patches', input: { action: 'install', deviceIds: [D1], patchIds: [P1] } }],
      assistantText: 'Plan complete.',
    });

    await executeAgentRun(RUN_ID);

    const outcome = finalTransition()!.patch.outcome as AgentRunOutcome;
    expect(outcome.deniedActions.map((d) => d.tool)).toEqual(['manage_patches']);
    expect(outcome.proposedActions).toEqual([]);
    expect(createActionIntent).not.toHaveBeenCalled();
  });
});

describe('patch run limits come from patchLimits', () => {
  it('drives the SDK with the patch budget/turn caps, not the general ones', async () => {
    seedRows({
      effective: policy({
        limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxTurnsPerRun: 40, maxBudgetCentsPerRun: 999, patchMaxTurns: 7, patchBudgetCentsPerRun: 35 },
      }),
    });

    await executeAgentRun(RUN_ID);

    expect(lastQueryOptions?.maxTurns).toBe(7);
    expect(lastQueryOptions?.maxBudgetUsd).toBe(35 / 100);
  });

  it('patchLimits zeroes maxActionsPerRun', () => {
    expect(patchLimits(AI_AGENT_LIMIT_DEFAULTS).maxActionsPerRun).toBe(0);
  });
});

describe('patch run read-only backstop', () => {
  it('denies any non-allow disposition outright, even with a broad allowlist and a device', async () => {
    const outcome = emptyOutcome();
    const pre = directPre('patch', outcome, {
      guardrailPolicy: {
        enabled: true, mode: 'shadow', toolAllowlist: ['manage_alerts'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        deviceId: D1, deviceSiteId: '00000000-0000-4000-8000-0000000000d7',
      },
    });

    const result = await pre('manage_alerts', { action: 'suppress', alertId: D1, suppressDuration: 24 });

    expect(result).toEqual({ allowed: false, error: 'patch runs are read-only' });
    expect(outcome.proposedActions).toEqual([]);
    expect(createActionIntent).not.toHaveBeenCalled();
  });

  it('pre-hook allows a valid submit_patch_plan on a patch run, refuses a bad reference, and denies it on other profiles', async () => {
    const outcome = emptyOutcome();
    const pre = directPre('patch', outcome, { patch: PATCH_REFS });
    expect(await pre('submit_patch_plan', VALID_PATCH_PLAN)).toMatchObject({ allowed: true });

    const bad = { ...VALID_PATCH_PLAN, items: [{ ...VALID_PATCH_PLAN.items[0]!, deviceId: D2 }] };
    const refused = await pre('submit_patch_plan', bad);
    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false && refused.error).toContain('patchIds');

    for (const profile of ['full', 'sweep', 'design'] as const) {
      const other = emptyOutcome();
      const result = await directPre(profile, other)('submit_patch_plan', VALID_PATCH_PLAN);
      expect(result.allowed).toBe(false);
      expect(other.deniedActions[0]!.reason).toContain(`${profile}-profile`);
    }
  });
});

describe('patch evidence load', () => {
  it('loads evidence for the run org and its partner, in a system DB context, and renders it', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    expect(loadPatchEvidence).toHaveBeenCalledTimes(1);
    expect(loadPatchEvidence).toHaveBeenCalledWith(ORG_ID, PARTNER_ID);
    expect(dbMockState.patchEvidenceScopes).toEqual(['system']);
    const prompt = String(lastPrompt);
    expect(prompt).toContain('WS-01');
    expect(prompt).toContain('KB5041234');
    expect(prompt).toContain('submit_patch_plan');
  });

  it('fails with patch_evidence_unavailable when the compliance rollup is unavailable', async () => {
    seedRows();
    loadPatchEvidence.mockRejectedValue(new PatchEvidenceUnavailableError());

    let caught: unknown;
    try {
      await executeAgentRun(RUN_ID);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentRunError);
    expect((caught as InstanceType<typeof AgentRunError>).errorCode).toBe('patch_evidence_unavailable');
    expect(transitionRunStatus).not.toHaveBeenCalled();
  });

  it('never loads patch evidence for a non-patch profile (negative control)', async () => {
    seedRows({ profile: 'full' });
    await executeAgentRun(RUN_ID);
    expect(loadPatchEvidence).not.toHaveBeenCalled();
  });
});

describe('patch plan capture', () => {
  it('captures the SERVER-BUILT plan into outcome.patchPlan and mints zero intents', async () => {
    seedRows();
    scriptQuery({ toolCalls: [{ tool: 'submit_patch_plan', input: VALID_PATCH_PLAN }], assistantText: 'Plan complete.' });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.patchPlan).toMatchObject({ schemaVersion: 1, summary: VALID_PATCH_PLAN.summary });
    expect(outcome.patchPlan!.items).toHaveLength(1);
    expect(final.patch.intentIds ?? []).toEqual([]);
    expect(createActionIntent).not.toHaveBeenCalled();
  });
});

describe('finalizePatchPlan (finish-time re-validation)', () => {
  beforeEach(() => {
    w02.resolveEligibility.mockReset();
    w02.findIntents.mockReset();
    w02.findIntents.mockResolvedValue([]);
  });

  it('records a disposition per item; an install item is refused as not_allowlisted when the agent cannot install (W02)', async () => {
    seedRows();
    dbMockState.rowQueues.devices = [[{ id: D1 }]];
    const withReboot = {
      ...VALID_PATCH_PLAN,
      items: [...VALID_PATCH_PLAN.items, { class: 'escalation', severity: 'low', deviceId: D2, title: 'Check WS-02', detail: 'Pending reboot for a while.', evidenceRef: 'rebootBacklog' }],
    };
    scriptQuery({ toolCalls: [{ tool: 'submit_patch_plan', input: withReboot }], assistantText: 'Plan complete.' });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.patchPlan!.dispositions).toEqual([
      { index: 0, class: 'install', deviceId: D1, disposition: 'refused', reason: 'not_allowlisted' },
      { index: 1, class: 'escalation', deviceId: D2, disposition: 'refused', reason: 'device_not_in_org' },
    ]);
    expect(final.to).toBe('completed');
    expect(final.patch.intentIds ?? []).toEqual([]);
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(w02.resolveEligibility).not.toHaveBeenCalled();
  });

  it('W02: with manage_patches:install allowlisted, an eligible install item mints ONE device-scoped card under the AGENT cap, not patchLimits\' 0', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_patches:install'], limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxActionsPerRun: 3 } }) });
    dbMockState.rowQueues.devices = [[{ id: D1 }]];
    w02.resolveEligibility.mockResolvedValue({
      eligible: [{ patchId: P1, devicePatchId: 'dp', externalId: 'KB', title: 't', category: null, severity: null, requiresReboot: false, approvalReason: 'manual' }],
      ineligible: [], ringId: null, resolvedAt: 'x',
    });
    createActionIntent.mockResolvedValue({ id: 'intent-77', status: 'pending_approval' });
    scriptQuery({ toolCalls: [{ tool: 'submit_patch_plan', input: VALID_PATCH_PLAN }], assistantText: 'Plan complete.' });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    const outcome = final.patch.outcome as AgentRunOutcome;
    // A run that left a pending card behind waits on the human, like a sweep.
    expect(final.to).toBe('awaiting_approval');
    expect(createActionIntent).toHaveBeenCalledTimes(1);
    expect(createActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      toolName: 'manage_patches',
      input: { action: 'install', deviceIds: [D1], patchIds: [P1] },
      idempotencyKey: `patch:${ORG_ID}:${D1}:${P1}`,
      scope: { deviceId: D1 },
    }));
    expect(outcome.patchPlan!.dispositions[0]).toMatchObject({ disposition: 'intent_created', intentId: 'intent-77' });
    expect(final.patch.intentIds).toEqual(['intent-77']);
  });

  it('reports patch_plan_missing when the run finished without a submission', async () => {
    seedRows();
    await executeAgentRun(RUN_ID);
    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBe('patch_plan_missing');
  });

  it('a submitted plan counts as producing something — a max-turns cut-off after it is not a failure', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'submit_patch_plan', input: VALID_PATCH_PLAN }],
      results: [resultMessage({ subtype: 'error_max_turns', is_error: true })],
    });
    dbMockState.rowQueues.devices = [[{ id: D1 }]];
    await executeAgentRun(RUN_ID);
    expect(finalTransition()!.to).not.toBe('failed');
  });
});
