// apps/api/src/services/aiAgents/runLoop.sweep.test.ts
/**
 * Phase 2 wave P2-2 (scheduled sweeps), task 6 — the `sweep` profile's wiring
 * into the run loop: outcome-tool exposure/gating, `outcome.sweepFindings`
 * capture, the bounded sweep-evidence context load, and the notify/fix-watch
 * split at finish.
 *
 * Its own file rather than more cases in `runLoop.test.ts`: that suite is
 * already 2.4k lines, and a sweep run needs a DIFFERENT seeded run row
 * (`scheduleId`/`triggerRef`) plus one extra module mock (`./sweepEvidence`).
 * The mock harness below is the same shape as `runLoop.test.ts`'s, trimmed to
 * what a sweep run actually reaches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
  type AiAgentRunProfile,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000c2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000c3';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000c4';
const RUN_ID = '00000000-0000-4000-8000-0000000000c6';
const SITE_ID = '00000000-0000-4000-8000-0000000000c7';
const USER_A = '00000000-0000-4000-8000-0000000000c8';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000e1';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// db mock (same harness shape as runLoop.test.ts — see its own comments)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  lastRow: {} as Record<string, unknown>,
  selects: [] as Array<{ table: string; where?: SQL }>,
  ambientContext: undefined as { scope: string } | undefined,
  /** Every scope the sweep-evidence loader was called under — asserted so the
   *  evidence read can never silently drift out of the system context. */
  sweepEvidenceScopes: [] as Array<string | undefined>,
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
// `submit_sweep_findings` SDK tool — only `query` needs faking here.
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

const persistAlertVerdict = vi.hoisted(() =>
  vi.fn<(run: unknown, verdict: unknown, agentAuth: unknown) => Promise<{
    verdictId: string; intentId: string | null; suggestionDisposition: 'intent_created' | 'not_created';
  }>>());
vi.mock('./alertVerdicts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./alertVerdicts')>();
  return { ...actual, persistAlertVerdict };
});

// `sweepEvidence.ts` is an I/O-heavy leaf module with its own dedicated unit
// suite (sweepEvidence.test.ts drives every loader's SQL and the bounded
// assembler). Mocked here at the module boundary — same precedent as
// `revalidateActExecution` above — so THIS file exercises only the run loop's
// WIRING contract: called at all / with which org+kinds / under which DB scope
// / rendered into which prompt.
const loadSweepEvidence = vi.hoisted(() =>
  vi.fn<(orgId: string, kinds: string[]) => Promise<unknown>>());
vi.mock('./sweepEvidence', () => ({ loadSweepEvidence }));

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

import { createAgentRunPostToolUse, createAgentRunPreToolUse, executeAgentRun } from './runLoop';
import type { AgentRunOutcome } from './runLoop';
import { SWEEP_TOOL_ALLOWLIST } from './sweepProfile';

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
    schemaVersion: 6,
    agentId: AGENT_ID,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-08-29T00:00:00Z').toISOString(),
  };
}

const SWEEP_EVIDENCE = {
  kinds: {
    disk_pressure: {
      rows: [{
        deviceId: DEVICE_ID,
        hostname: 'WS-ACCT-04',
        fields: { mountPoint: 'C:', usedPercent: 96.4 },
      }],
      total: 3,
      truncated: false,
    },
  },
  truncated: false,
};

function seedRows(options: {
  effective?: AiAgentPolicy;
  profile?: AiAgentRunProfile;
  scheduleId?: string | null;
  triggerRef?: Record<string, unknown>;
  deviceId?: string | null;
} = {}) {
  const effective = options.effective ?? policy();
  const deviceId = options.deviceId === undefined ? null : options.deviceId;

  dbMockState.rowQueues.ai_agent_runs = [[{
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId,
    alertId: null,
    ticketId: null,
    anomalyIncidentId: null,
    status: 'queued',
    modeAtStart: 'shadow',
    triggerKind: options.profile === 'sweep' ? 'schedule' : 'alert',
    policySnapshot: snapshot(effective),
    profile: options.profile ?? 'sweep',
    correlationGroupId: null,
    scheduleId: options.scheduleId === undefined ? SCHEDULE_ID : options.scheduleId,
    triggerRef: options.triggerRef ?? {
      scheduleId: SCHEDULE_ID,
      occurrenceKey: '2026-08-29T06:00:00Z',
      sweepKinds: ['disk_pressure', 'service_down'],
    },
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    name: 'Nightly Sweep',
    kind: 'triage',
    recipients: { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  if (deviceId) {
    dbMockState.rowQueues.devices = [[{ id: deviceId, siteId: SITE_ID, hostname: 'WS-ACCT-04', osType: 'windows' }]];
  }
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

const VALID_FINDINGS = {
  summary: 'One machine is nearly out of disk.',
  findings: [{
    kind: 'disk_pressure' as const,
    severity: 'high' as const,
    deviceId: DEVICE_ID,
    title: 'C: is 96% full',
    detail: 'C: on WS-ACCT-04 is at 96.4% with 4.1 GB free.',
    evidence: { mountPoint: 'C:', usedPercent: 96.4 },
  }],
};

const VALID_VERDICT = {
  classification: 'transient_self_healed' as const,
  confidence: 0.9,
  rationale: 'Recovered on its own.',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbMockState.rowQueues = {};
  dbMockState.lastRow = {};
  dbMockState.selects.length = 0;
  dbMockState.ambientContext = undefined;
  dbMockState.sweepEvidenceScopes.length = 0;
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
  loadSweepEvidence.mockImplementation(async () => {
    dbMockState.sweepEvidenceScopes.push(dbMockState.ambientContext?.scope);
    return SWEEP_EVIDENCE;
  });
  createBreezeMcpServer.mockImplementation((getAuth, pre, post) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery({ assistantText: 'Sweep complete.' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('sweep profile outcome-tool gating (P2-2)', () => {
  function emptyOutcome(): AgentRunOutcome {
    return { proposedActions: [], executedActions: [], deniedActions: [], toolExecutionCount: 0 };
  }

  /** Everything the outcome-tool branch returns before touching is dead
   *  weight here, so the whole object is cast `as never` at the call site —
   *  same precedent as runLoop.test.ts's verdict `preArgs`. */
  function preArgs(profile: AiAgentRunProfile, outcome: AgentRunOutcome) {
    return {
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile },
      agentName: 'Nightly Sweep',
      agentAuth: {},
      agentKind: 'triage',
      guardrailPolicy: {
        enabled: true,
        mode: 'shadow',
        toolAllowlist: [],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        deviceId: null,
        deviceSiteId: null,
      },
      outcome,
      intentIds: [],
      allowedPending: new Map<string, number>(),
      sessionId: null,
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      actReservation: { count: 0 },
      deadlineMs: Date.now() + 60_000,
    };
  }

  it('pre-hook allows submit_sweep_findings on a sweep run and denies it on full and verdict runs', async () => {
    const sweepOutcome = emptyOutcome();
    const pre = createAgentRunPreToolUse(preArgs('sweep', sweepOutcome) as never);
    expect(await pre('submit_sweep_findings', VALID_FINDINGS)).toEqual({ allowed: true });

    for (const profile of ['full', 'verdict'] as const) {
      const outcome = emptyOutcome();
      const denied = createAgentRunPreToolUse(preArgs(profile, outcome) as never);
      const result = await denied('submit_sweep_findings', VALID_FINDINGS);
      expect(result.allowed).toBe(false);
      expect(outcome.deniedActions[0]!.reason).toContain(`${profile}-profile`);
      expect(outcome.deniedActions[0]!.reason).toContain('submit_sweep_findings');
    }
  });

  it('pre-hook denies the VERDICT outcome tool on a sweep run (the gate is per-profile, not per-tool)', async () => {
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse(preArgs('sweep', outcome) as never);

    const result = await pre('submit_alert_verdict', VALID_VERDICT);

    expect(result.allowed).toBe(false);
    expect(outcome.deniedActions[0]!.reason).toContain('sweep-profile');
    expect(outcome.alertVerdict).toBeUndefined();
  });

  it('pre-hook rejects malformed submit_sweep_findings input so the model can retry', async () => {
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse(preArgs('sweep', outcome) as never);

    // The union's `error` field only exists on the denied arm, so narrow
    // through `allowed` rather than casting the whole result.
    const result = await pre('submit_sweep_findings', { summary: '', findings: [] });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected the malformed input to be denied');
    expect(result.error).toContain('invalid submit_sweep_findings input');
  });

  it('outcome tool is denied on a sweep run when the kill switch is engaged', async () => {
    getCachedAiKillStateSnapshot.mockReturnValue({ killed: true, epoch: 9 });
    const outcome = emptyOutcome();
    const pre = createAgentRunPreToolUse(preArgs('sweep', outcome) as never);

    const result = await pre('submit_sweep_findings', VALID_FINDINGS);

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected the kill switch to deny the outcome tool');
    // The specific reason matters: a generic "not available" would read as a
    // profile mismatch, and the kill switch is what a responder needs to see.
    expect(result.error).toContain('kill-switched');
    expect(result.error).toContain('epoch 9');
    expect(outcome.deniedActions[0]!.reason).toContain('kill-switched');
    expect(outcome.sweepFindings).toBeUndefined();
  });

  it('post-hook captures the validated findings into outcome.sweepFindings and counts no execution', async () => {
    const outcome = emptyOutcome();
    const post = createAgentRunPostToolUse({
      outcome,
      allowedPending: new Map<string, number>(),
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, deviceId: null, profile: 'sweep' },
      agentUserId: USER_A,
    } as never);

    await post('submit_sweep_findings', VALID_FINDINGS, '{"status":"recorded"}', false, 5);

    expect(outcome.sweepFindings).toEqual(VALID_FINDINGS);
    expect(outcome.alertVerdict).toBeUndefined();
    expect(outcome.toolExecutionCount).toBe(0);
  });

  it('post-hook captures nothing when the tool does not belong to the run profile', async () => {
    const outcome = emptyOutcome();
    const post = createAgentRunPostToolUse({
      outcome,
      allowedPending: new Map<string, number>(),
      executionIdPending: new Map<string, Array<string | null>>(),
      actPinPending: new Map<string, Array<unknown>>(),
      run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, deviceId: null, profile: 'full' },
      agentUserId: USER_A,
    } as never);

    await post('submit_sweep_findings', VALID_FINDINGS, '{"status":"recorded"}', false, 5);

    expect(outcome.sweepFindings).toBeUndefined();
  });
});

describe('sweep profile exposure and context in the run loop (P2-2)', () => {
  it('exposes the sweep floor + sweep outcome tool with the sweep limits', async () => {
    // Deliberately mismatched agent allowlist — the floor is served regardless.
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }), profile: 'sweep' });

    await executeAgentRun(RUN_ID);

    expect(lastQueryOptions?.allowedTools).toEqual([
      ...SWEEP_TOOL_ALLOWLIST.map((name) => `mcp__breeze__${name}`),
      'mcp__breeze__submit_sweep_findings',
    ]);
    expect(lastQueryOptions?.maxTurns).toBe(AI_AGENT_LIMIT_DEFAULTS.sweepMaxTurns);
    expect(lastQueryOptions?.maxBudgetUsd).toBe(AI_AGENT_LIMIT_DEFAULTS.sweepBudgetCentsPerRun / 100);

    const extraTools = createBreezeMcpServer.mock.calls[0]?.[4];
    expect(extraTools?.map((t) => t.name)).toEqual(['submit_sweep_findings']);

    const options = createBreezeMcpServer.mock.calls[0]?.[5];
    expect(options?.onlyTools).toEqual(new Set(SWEEP_TOOL_ALLOWLIST));
  });

  it('loads bounded sweep evidence for the run org, in a system DB context, and renders it into the task turn', async () => {
    seedRows({ profile: 'sweep' });

    await executeAgentRun(RUN_ID);

    expect(loadSweepEvidence).toHaveBeenCalledTimes(1);
    expect(loadSweepEvidence).toHaveBeenCalledWith(ORG_ID, ['disk_pressure', 'service_down']);
    expect(dbMockState.sweepEvidenceScopes).toEqual(['system']);
    expect(String(lastPrompt)).toContain('2026-08-29T06:00:00Z');
    expect(String(lastPrompt)).toContain('## disk_pressure (1 of 3)');
    expect(String(lastPrompt)).toContain('WS-ACCT-04');
  });

  it('drops sweepKinds the catalog does not know and tolerates a missing triggerRef entirely', async () => {
    seedRows({ profile: 'sweep', triggerRef: { sweepKinds: ['disk_pressure', 'expiring_certs', 7] } });
    await executeAgentRun(RUN_ID);
    expect(loadSweepEvidence).toHaveBeenCalledWith(ORG_ID, ['disk_pressure']);

    vi.clearAllMocks();
    loadSweepEvidence.mockResolvedValue({ kinds: {}, truncated: false });
    transitionRunStatus.mockResolvedValue(true);
    createAgentRunSession.mockResolvedValue('session-2');
    resolveLlmConfigForOrg.mockResolvedValue({ source: 'platform', apiKey: 'sk-test', model: 'claude-fallback' });
    resolveRecipientUserIds.mockResolvedValue([]);
    getCachedAiKillStateSnapshot.mockReturnValue({ killed: false, epoch: 0 });
    createBreezeMcpServer.mockImplementation((getAuth, pre, post) => {
      hooks.getAuth = getAuth; hooks.pre = pre; hooks.post = post;
      return { type: 'sdk', name: 'breeze', instance: {} };
    });
    scriptQuery({ assistantText: 'Nothing to report.' });
    seedRows({ profile: 'sweep', triggerRef: {} });

    await executeAgentRun(RUN_ID);

    // Empty kinds, never a throw — the sweeper guarantees the list, but a
    // hand-enqueued or half-migrated run must still finish cleanly.
    expect(loadSweepEvidence).toHaveBeenCalledWith(ORG_ID, []);
    expect(finalTransition()?.to).toBe('completed');
  });

  it('never loads sweep evidence for a non-sweep run (negative control)', async () => {
    seedRows({ profile: 'full', deviceId: DEVICE_ID });

    await executeAgentRun(RUN_ID);

    expect(loadSweepEvidence).not.toHaveBeenCalled();
  });

  it('captures submit_sweep_findings into the persisted outcome of a real run', async () => {
    seedRows({ profile: 'sweep' });
    scriptQuery({
      toolCalls: [{ tool: 'submit_sweep_findings', input: VALID_FINDINGS }],
      assistantText: 'Reported one finding.',
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.sweepFindings).toEqual(VALID_FINDINGS);
    expect(outcome.executedActions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task A7 — `finalizeSweep`'s wiring. The per-gate behaviour of
// `persistSweepFindings` itself is covered exhaustively in
// sweepFindings.test.ts; these two cases pin the RUN-LOOP contract: the
// conversion happens before the terminal-status decision, and it is driven by
// the SYSTEM evidence rather than by anything the model said.
// ---------------------------------------------------------------------------
describe('sweep findings persistence at finish (P2-2, Task A7)', () => {
  const FINDINGS_WITH_PROPOSAL = {
    summary: 'A monitored service is down.',
    findings: [{
      kind: 'service_down' as const,
      severity: 'critical' as const,
      deviceId: DEVICE_ID,
      title: 'Spooler is stopped',
      detail: 'Spooler on WS-ACCT-04 has been stopped for 3 days.',
      evidence: { state: 'stopped' },
      proposedAction: {
        tool: 'manage_services' as const,
        action: 'restart' as const,
        deviceId: DEVICE_ID,
        serviceName: 'Spooler',
      },
    }],
  };

  it('converts a proposal into a device-scoped intent and finishes awaiting_approval', async () => {
    // The agent's OWN allowlist grants the mutating tool (the sweep tool
    // FLOOR is read-only and never admits it) — and its `maxActionsPerRun`,
    // not `sweepLimits`' hard 0, is the cap that applies.
    seedRows({ profile: 'sweep', effective: policy({ toolAllowlist: ['manage_services'] }) });
    // The gate-2 device existence read (org-pinned, non-ephemeral).
    dbMockState.rowQueues.devices = [[{ id: DEVICE_ID }]];
    createActionIntent.mockResolvedValue({ id: 'intent-sweep-1', status: 'pending_approval' });
    scriptQuery({
      toolCalls: [{ tool: 'submit_sweep_findings', input: FINDINGS_WITH_PROPOSAL }],
      assistantText: 'Reported one finding.',
    });

    await executeAgentRun(RUN_ID);

    expect(createActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      toolName: 'manage_services',
      input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' },
      source: 'ai_agent',
      orgId: ORG_ID,
      idempotencyKey: `sweep:${RUN_ID}:0`,
      // The whole point of A3's explicit scope: a DEVICE-LESS sweep run
      // still mints a device-bound intent.
      scope: { deviceId: DEVICE_ID },
    }));

    const final = finalTransition()!;
    // Status is computed AFTER persistence — a sweep run that created a
    // pending approval must not finish `completed`.
    expect(final.to).toBe('awaiting_approval');
    expect(final.patch.intentIds).toEqual(['intent-sweep-1']);
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.sweepProposals).toEqual([{
      findingIndex: 0,
      tool: 'manage_services',
      action: 'restart',
      deviceId: DEVICE_ID,
      disposition: 'intent_created',
      intentId: 'intent-sweep-1',
    }]);
    expect(outcome.sweepEvidenceTruncated).toBe(false);
  });

  it('refuses a proposal for a device the system never collected evidence for', async () => {
    const OFF_EVIDENCE_DEVICE = '00000000-0000-4000-8000-0000000000f9';
    seedRows({ profile: 'sweep', effective: policy({ toolAllowlist: ['manage_services'] }) });
    createActionIntent.mockResolvedValue({ id: 'intent-sweep-1', status: 'pending_approval' });
    scriptQuery({
      toolCalls: [{
        tool: 'submit_sweep_findings',
        input: {
          ...FINDINGS_WITH_PROPOSAL,
          findings: [{
            ...FINDINGS_WITH_PROPOSAL.findings[0]!,
            deviceId: OFF_EVIDENCE_DEVICE,
            proposedAction: {
              ...FINDINGS_WITH_PROPOSAL.findings[0]!.proposedAction,
              deviceId: OFF_EVIDENCE_DEVICE,
            },
          }],
        },
      }],
      assistantText: 'Reported one finding.',
    });

    await executeAgentRun(RUN_ID);

    // No intent, and no device read either — the evidence gate short-circuits
    // before any query (no `devices` rows are queued, so one would throw).
    expect(createActionIntent).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect((final.patch.outcome as AgentRunOutcome).sweepProposals).toEqual([
      expect.objectContaining({ disposition: 'refused', reason: 'device_not_in_evidence' }),
    ]);
  });
});

describe('notify / fix-watch split at finish (P2-2)', () => {
  it('a sweep run DOES notify its recipients but schedules NO fix-watch', async () => {
    seedRows({ profile: 'sweep' });
    scriptQuery({ assistantText: 'Sweep complete.' });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()?.to).toBe('completed');
    expect(resolveRecipientUserIds).toHaveBeenCalled();
    expect(scheduleFixWatch).not.toHaveBeenCalled();
  });

  it('a verdict run still skips BOTH (unchanged by the split)', async () => {
    seedRows({ profile: 'verdict', deviceId: DEVICE_ID });
    scriptQuery({ toolCalls: [{ tool: 'submit_alert_verdict', input: VALID_VERDICT }], assistantText: 'Judged.' });

    await executeAgentRun(RUN_ID);

    expect(resolveRecipientUserIds).not.toHaveBeenCalled();
    expect(scheduleFixWatch).not.toHaveBeenCalled();
  });

  it('a full run still does BOTH (unchanged by the split)', async () => {
    seedRows({ profile: 'full', deviceId: DEVICE_ID });
    scriptQuery({ assistantText: 'All good.' });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()?.to).toBe('completed');
    expect(resolveRecipientUserIds).toHaveBeenCalled();
    expect(scheduleFixWatch).toHaveBeenCalled();
  });
});
