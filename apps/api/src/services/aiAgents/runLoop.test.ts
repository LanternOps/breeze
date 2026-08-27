import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentLimits,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000c2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000c3';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000c4';
const ALERT_ID = '00000000-0000-4000-8000-0000000000c5';
const RUN_ID = '00000000-0000-4000-8000-0000000000c6';
const SITE_ID = '00000000-0000-4000-8000-0000000000c7';
const USER_A = '00000000-0000-4000-8000-0000000000c8';
const USER_B = '00000000-0000-4000-8000-0000000000c9';
const INTENT_ID = '00000000-0000-4000-8000-0000000000d1';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}
// ---------------------------------------------------------------------------
// db mock (same harness shape as runService.test.ts)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  // The most recently shifted row for a table, keyed by table name — lets
  // `nextRows` synthesize a SECOND read below (wave 4a Task 6, #3826:
  // `deliverRunFinishedNotifications` re-reads `ai_agent_runs`/`ai_agents`
  // from `finishRun`, after `seedRows()`'s one queued row-set for each has
  // already been consumed by the loop's own initial `loadRunContext`).
  lastRow: {} as Record<string, unknown>,
  selects: [] as Array<{ table: string; where?: SQL }>,
  systemContextDepth: 0,
  ambientContext: undefined as { scope: string } | undefined,
}));

/**
 * `ai_agent_runs`/`ai_agents` are read TWICE per completed run under real
 * code: once by `loadRunContext` at the top of `executeAgentRun`, and again
 * by `deliverRunFinishedNotifications` inside `finishRun` (Task 6). Only the
 * first read is ever explicitly queued (`seedRows()`); rather than force
 * every existing test to queue an identical second copy, a table that runs
 * dry synthesizes its second read from what it already knows:
 *  - `ai_agents`: the agent row never changes mid-run — reuse the last one.
 *  - `ai_agent_runs`: overlay the LAST `transitionRunStatus` call's
 *    `to`/`patch` (status, summary, outcome, intentIds) onto the seeded row,
 *    since `transitionRunStatus` is mocked and never actually mutates it —
 *    this is what makes the synthesized re-read reflect the run's real
 *    terminal outcome instead of the stale pre-run seed.
 * Every OTHER table still throws on a second, un-queued read (unchanged
 * strictness) — only these two are ever legitimately read twice.
 */
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
      dbMockState.systemContextDepth += 1;
      try {
        return await fn();
      } finally {
        dbMockState.systemContextDepth -= 1;
        dbMockState.ambientContext = previous;
      }
    }),
  };
});

const transitionRunStatus = vi.hoisted(() =>
  vi.fn<(
    runId: string,
    from: unknown,
    to: string,
    patch?: Record<string, unknown>,
  ) => Promise<boolean>>());
vi.mock('./runService', () => ({ transitionRunStatus }));

const createAgentRunSession = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<string>>());
const startToolExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<string>>());
const completeToolExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<void>>());
const reconcileHungExecutions = vi.hoisted(() =>
  vi.fn<(sessionId: string) => Promise<number>>());
const closeAgentRunSession = vi.hoisted(() =>
  vi.fn<(sessionId: string, status: 'completed' | 'failed') => Promise<void>>());
vi.mock('./executionLedger', () => ({
  createAgentRunSession,
  startToolExecution,
  completeToolExecution,
  reconcileHungExecutions,
  closeAgentRunSession,
}));

const resolveEffectiveAgentSystem = vi.hoisted(() =>
  vi.fn<(orgId: string, kind: string) => Promise<AiAgentPolicySnapshot | null>>());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

// `revalidateActExecution` and `verifyActExecution`/`recordActVerifyFailureAlert`
// are I/O-heavy leaf modules with their own dedicated unit suites
// (actRevalidation.test.ts, actVerify.test.ts) — mocked here at the module
// boundary, same precedent as `resolveEffectiveAgentSystem` above, so this
// file only exercises the run-loop's WIRING contract (deny/downgrade/ok
// mapping, ledger writes, pin passthrough, verdict rollup) rather than
// re-driving disk-cleanup preview rows / command-queue reads through this
// harness's already-strict table-queue mock.
const revalidateActExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<
    | { ok: true; pin: Record<string, unknown> }
    | { ok: false; downgrade: 'propose' }
    | { ok: false; deny: string }
  >>());
vi.mock('./actRevalidation', () => ({ revalidateActExecution }));

const verifyActExecution = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<
    { execution: string; verification: string; verifyDetail?: string }
  >>());
const recordActVerifyFailureAlert = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<void>>(async () => undefined));
vi.mock('./actVerify', async (importOriginal) => {
  // `actTargetSummary` is pure — keep the real implementation so the
  // notification/outcome fields it feeds are exercised for real.
  const actual = await importOriginal<typeof import('./actVerify')>();
  return { ...actual, verifyActExecution, recordActVerifyFailureAlert };
});

const publishEvent = vi.hoisted(() =>
  vi.fn<(type: string, orgId: string, payload: unknown, source: string) => Promise<string>>(
    async () => 'event-1'));
vi.mock('../eventBus', () => ({ publishEvent }));

const queryMock = vi.hoisted(() =>
  vi.fn<(params: { prompt: unknown; options: Record<string, unknown> }) => unknown>());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const createBreezeMcpServer = vi.hoisted(() =>
  vi.fn<(getAuth: () => unknown, pre?: Hooks['pre'], post?: Hooks['post']) => unknown>());
vi.mock('../aiAgentSdkTools', () => ({
  createBreezeMcpServer,
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));

const createActionIntent = vi.hoisted(() =>
  vi.fn<(auth: unknown, input: Record<string, unknown>) =>
    Promise<{ id: string; status: string; errorCode?: string | null }>>());
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));

const resolveRecipientUserIds = vi.hoisted(() =>
  vi.fn<(agent: unknown, orgId: string) => Promise<string[]>>(async () => []));
vi.mock('./recipients', () => ({ resolveRecipientUserIds }));

const createNotification = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<string | null>>(async () => 'notification-1'));
vi.mock('../userNotifications', () => ({ createNotification }));

// `deliverRunFinishedNotifications` (Task 6) lives in `./runFinishedNotify`,
// NOT this file — it resolves `./recipients`/`../userNotifications` from the
// SAME directory as runLoop.ts, so the two mocks above still intercept its
// calls even though it's a different module making them (Vitest mocks by
// resolved module path, not by importer). Only the retry-enqueue side needs
// its own mock here.
const enqueueAgentNotifyRetry = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<void>>(async () => undefined));
vi.mock('../../jobs/agentNotifyRetryWorker', () => ({ enqueueAgentNotifyRetry }));

const resolveLlmConfigForOrg = vi.hoisted(() =>
  vi.fn<(orgId: string) => Promise<{ source: string; apiKey?: string; model: string }>>());
vi.mock('../llm/llmConfigResolver', () => ({ resolveLlmConfigForOrg }));

const buildClaudeSdkChildEnv = vi.hoisted(() =>
  vi.fn<(resolved: { source: string }) => Record<string, string>>(() => ({ CI: 'true' })));
vi.mock('../streamingSessionManager', () => ({ buildClaudeSdkChildEnv }));

const recordSessionlessSdkUsage = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
const calculateCostCents = vi.hoisted(() => vi.fn<(...args: unknown[]) => number>(() => 0));
vi.mock('../aiCostTracker', () => ({ recordSessionlessSdkUsage, calculateCostCents }));

// checkToolPermission must NEVER be reachable from an agent run. Spying through
// the real module would require mocking it; instead the contract is asserted by
// the red-team suite (Task 5). Here we assert the loop never imports it by
// asserting on the guardrail path it DOES take.
import { computeRunVerdict, executeAgentRun, PROPOSAL_RECORDED_TEXT } from './runLoop';
import type { AgentRunOutcome } from './runLoop';

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
    instructions: null,
    cooldownSeconds: 900,
    ...overrides,
  };
}

function snapshot(effective: AiAgentPolicy): AiAgentPolicySnapshot {
  return {
    schemaVersion: 1,
    agentId: AGENT_ID,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-08-24T00:00:00Z').toISOString(),
  };
}

function seedRows(options: {
  effective?: AiAgentPolicy;
  deviceId?: string | null;
  alertId?: string | null;
  /** What the partner-baseline agent ROW carries (never the merged set). */
  recipients?: { userIds: string[]; roleIds: string[] };
  agentOrgId?: string | null;
  /**
   * `checkAgentGuardrails` reasons about `run.modeAtStart`, NOT
   * `effective.mode` (runLoop.ts pins the guardrail policy to the mode the
   * run itself started under). Defaults to 'shadow' to match `policy()`'s
   * default; pass this whenever a test's `effective.mode` diverges (e.g.
   * 'act') so the guardrail check actually sees it.
   */
  modeAtStart?: AiAgentPolicy['mode'];
} = {}) {
  const effective = options.effective ?? policy();
  const deviceId = options.deviceId === undefined ? DEVICE_ID : options.deviceId;
  const alertId = options.alertId === undefined ? ALERT_ID : options.alertId;

  dbMockState.rowQueues.ai_agent_runs = [[{
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId,
    alertId,
    status: 'queued',
    modeAtStart: options.modeAtStart ?? 'shadow',
    triggerKind: 'alert',
    policySnapshot: snapshot(effective),
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID,
    orgId: options.agentOrgId === undefined ? null : options.agentOrgId,
    partnerId: options.agentOrgId === undefined ? PARTNER_ID : null,
    name: 'Front Desk Triage',
    kind: 'triage',
    recipients: options.recipients ?? { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  if (deviceId) {
    dbMockState.rowQueues.devices = [[{ id: deviceId, siteId: SITE_ID, hostname: 'WS-ACCT-04', osType: 'windows' }]];
  }
  if (alertId) {
    dbMockState.rowQueues.alerts = [[{ id: alertId, title: 'Disk almost full', severity: 'high', message: 'C: at 96%' }]];
  }
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(effective));
  return effective;
}

const hooks: Hooks = {};

interface QueryScript {
  toolCalls?: Array<{ tool: string; input: Record<string, unknown> }>;
  assistantText?: string;
  results?: Array<Record<string, unknown>>;
  hangUntilAbort?: boolean;
}

const dialect = new PgDialect();
function compiled(cond: SQL | undefined): string {
  return cond ? dialect.sqlToQuery(cond).sql : '';
}

const yielded: unknown[] = [];
const preVerdicts: Array<{ allowed: boolean; error?: string }> = [];
const closeMock = vi.fn();
let lastQueryOptions: Record<string, unknown> | undefined;

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    result: '',
    total_cost_usd: 0.25,
    usage: { input_tokens: 1200, output_tokens: 300 },
    ...overrides,
  };
}

function scriptQuery(script: QueryScript) {
  queryMock.mockImplementation((params: { prompt: unknown; options: Record<string, unknown> }) => {
    lastQueryOptions = params.options;
    const generator = (async function* () {
      for (const call of script.toolCalls ?? []) {
        const verdict = await hooks.pre!(call.tool, call.input);
        preVerdicts.push(verdict);
        if (verdict.allowed) {
          await hooks.post!(call.tool, call.input, '{"ok":true}', false, 5);
        } else {
          await hooks.post!(call.tool, call.input, JSON.stringify({ error: verdict.error }), true, 0);
        }
      }
      if (script.hangUntilAbort) {
        const signal = (params.options.abortController as AbortController).signal;
        await new Promise((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('AbortError')); return; }
          signal.addEventListener('abort', () => reject(new Error('AbortError')));
        });
      }
      if (script.assistantText !== undefined) {
        const message = {
          type: 'assistant',
          message: { content: [{ type: 'text', text: script.assistantText }] },
        };
        yielded.push(message);
        yield message;
      }
      for (const result of script.results ?? [resultMessage()]) {
        yielded.push(result);
        yield result;
      }
    })();
    return Object.assign(generator, { close: closeMock, interrupt: vi.fn() });
  });
}

function finalTransition(): { from: unknown; to: string; patch: Record<string, unknown> } | undefined {
  const calls = transitionRunStatus.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) return undefined;
  return { from: last[1], to: last[2] as string, patch: (last[3] ?? {}) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbMockState.rowQueues = {};
  dbMockState.lastRow = {};
  dbMockState.selects.length = 0;
  dbMockState.systemContextDepth = 0;
  dbMockState.ambientContext = undefined;
  yielded.length = 0;
  preVerdicts.length = 0;
  lastQueryOptions = undefined;
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
  createActionIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_approval' });
  // Never reached unless a test's script drives a manifest-matched call
  // under a live `mode: 'act'` guardrail policy — a mismatched default here
  // would only ever surface as "Cannot use 'in' operator on undefined" in a
  // test that forgot to configure it, which is exactly what should happen.
  revalidateActExecution.mockReset();
  verifyActExecution.mockReset().mockResolvedValue({ execution: 'succeeded', verification: 'passed' });
  recordActVerifyFailureAlert.mockReset().mockResolvedValue(undefined);
  createBreezeMcpServer.mockImplementation((getAuth: () => unknown, pre: Hooks['pre'], post: Hooks['post']) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery({ assistantText: 'All good.' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('executeAgentRun', () => {
  it('CAS queued->running, executes a read tool, completes with cost and summary', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'query_devices', input: { status: 'online' } }],
      assistantText: 'Disk is at 96% because of Windows update caches.',
    });

    await executeAgentRun(RUN_ID);

    expect(transitionRunStatus.mock.calls[0]!.slice(0, 3)).toEqual([RUN_ID, 'queued', 'running']);
    expect(preVerdicts[0]).toEqual({ allowed: true });

    const final = finalTransition()!;
    expect(final.from).toBe('running');
    expect(final.to).toBe('completed');
    expect(final.patch.summary).toBe('Disk is at 96% because of Windows update caches.');
    expect(final.patch.costCents).toBe(25);
    expect(final.patch.turnCount).toBe(3);
    expect(final.patch.intentIds).toEqual([]);

    const outcome = final.patch.outcome as Record<string, unknown>;
    expect(outcome.executedActions).toEqual([
      expect.objectContaining({ tool: 'query_devices', result: 'ok' }),
    ]);
    expect(outcome.proposedActions).toEqual([]);

    const events = publishEvent.mock.calls.map((call) => call[0]);
    expect(events).toContain('ai.agent.run.started');
    expect(events).toContain('ai.agent.run.completed');
  });

  it('shadow: a tier-3 mutating tool becomes an intent + proposedActions entry, status awaiting_approval', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'Proposed a print spooler restart.',
    });

    await executeAgentRun(RUN_ID);

    expect(createActionIntent).toHaveBeenCalledTimes(1);
    const [auth, intentInput] = createActionIntent.mock.calls[0]!;
    expect((auth as { principal: { kind: string; runId: string } }).principal)
      .toMatchObject({ kind: 'ai_agent', agentId: AGENT_ID, runId: RUN_ID });
    expect(intentInput).toMatchObject({ toolName: 'manage_services', source: 'ai_agent', orgId: ORG_ID });

    // The model is told the proposal is success, not an error to route around.
    expect(preVerdicts[0]!.allowed).toBe(false);
    expect(preVerdicts[0]!.error).toMatch(/proposal/i);

    const final = finalTransition()!;
    expect(final.to).toBe('awaiting_approval');
    expect(final.patch.intentIds).toEqual([INTENT_ID]);
    const outcome = final.patch.outcome as { proposedActions: Array<Record<string, unknown>> };
    expect(outcome.proposedActions).toEqual([
      expect.objectContaining({ tool: 'manage_services', action: 'restart', intentId: INTENT_ID }),
    ]);
    expect(publishEvent.mock.calls.map((c) => c[0])).toContain('ai.agent.run.awaiting_approval');
  });

  it('shadow: a tier-2 mutating tool becomes a proposal WITHOUT an intent', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_alerts'] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_alerts', input: { action: 'acknowledge', alertId: ALERT_ID } }],
      assistantText: 'Would acknowledge the alert.',
    });

    await executeAgentRun(RUN_ID);

    // Tier 2 has no action-intent path at all (createActionIntent throws
    // tier_not_tier3), so the runner must not even try.
    expect(createActionIntent).not.toHaveBeenCalled();

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.intentIds).toEqual([]);
    const outcome = final.patch.outcome as { proposedActions: Array<Record<string, unknown>> };
    expect(outcome.proposedActions).toHaveLength(1);
    expect(outcome.proposedActions[0]!.tool).toBe('manage_alerts');
    expect(outcome.proposedActions[0]!.intentId).toBeUndefined();
  });

  it('records the proposal even when the intent cannot be submitted', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }) });
    createActionIntent.mockRejectedValue(new Error('no_eligible_approvers'));
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'done',
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    const outcome = final.patch.outcome as { proposedActions: Array<Record<string, unknown>> };
    expect(outcome.proposedActions).toHaveLength(1);
    expect(outcome.proposedActions[0]!.intentId).toBeUndefined();
    expect(String(outcome.proposedActions[0]!.intentError)).toContain('no_eligible_approvers');
    expect(preVerdicts[0]!.error).toContain('no_eligible_approvers');
  });

  it('deny verdict surfaces as a tool error the model can read, and the run still completes', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'Could not restart; recorded the finding.',
    });

    await executeAgentRun(RUN_ID);

    expect(createActionIntent).not.toHaveBeenCalled();
    expect(preVerdicts[0]!.allowed).toBe(false);
    expect(preVerdicts[0]!.error).toMatch(/allowlist/i);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    const outcome = final.patch.outcome as {
      deniedActions: Array<Record<string, unknown>>;
      executedActions: unknown[];
      proposedActions: unknown[];
    };
    expect(outcome.deniedActions).toHaveLength(1);
    // A denial is neither an execution nor a proposal.
    expect(outcome.executedActions).toEqual([]);
    expect(outcome.proposedActions).toEqual([]);
  });

  describe('act disposition (Task 3 revalidation + Task 4 verification)', () => {
    function seedActRun() {
      return seedRows({
        effective: policy({ mode: 'act', toolAllowlist: ['manage_services'] }),
        modeAtStart: 'act',
      });
    }

    const ACT_CALL = {
      tool: 'manage_services',
      input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' },
    };

    it('ok revalidation dispatches through the NORMAL tool path — ledger write, no action-intent — and verifies to remediated', async () => {
      seedActRun();
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true,
        pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({ execution: 'succeeded', verification: 'passed' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Restarted the spooler service.' });

      await executeAgentRun(RUN_ID);

      expect(revalidateActExecution).toHaveBeenCalledTimes(1);
      const revalidateArgs = revalidateActExecution.mock.calls[0]![0] as Record<string, unknown>;
      expect(revalidateArgs.toolName).toBe('manage_services');
      expect((revalidateArgs.run as Record<string, unknown>).deviceId).toBe(DEVICE_ID);
      // This is the ONLY execution path — through the same
      // startToolExecution/allowedPending machinery a plain 'allow' uses.
      expect(startToolExecution).toHaveBeenCalledTimes(1);
      expect(createActionIntent).not.toHaveBeenCalled();
      expect(preVerdicts[0]).toEqual({ allowed: true });
      expect(verifyActExecution).toHaveBeenCalledTimes(1);

      const final = finalTransition()!;
      expect(final.to).toBe('completed');
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.deniedActions).toEqual([]);
      expect(outcome.proposedActions).toEqual([]);
      expect(outcome.executedActions).toHaveLength(1);
      expect(outcome.executedActions[0]).toMatchObject({
        tool: 'manage_services',
        execution: 'succeeded',
        verification: 'passed',
        actOpKey: 'manage_services.restart',
        actTargetName: 'Spooler',
      });
      expect(outcome.runVerdict).toBe('remediated');
      expect(recordActVerifyFailureAlert).not.toHaveBeenCalled();
    });

    it('deny revalidation NEVER dispatches — no ledger write, no proposal, recorded as a denial', async () => {
      seedActRun();
      revalidateActExecution.mockResolvedValue({ ok: false, deny: 'Agent is disabled' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Could not restart; recorded the finding.' });

      await executeAgentRun(RUN_ID);

      expect(startToolExecution).not.toHaveBeenCalled();
      expect(createActionIntent).not.toHaveBeenCalled();
      expect(preVerdicts[0]).toEqual({ allowed: false, error: 'Agent is disabled' });

      const final = finalTransition()!;
      expect(final.to).toBe('completed');
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.deniedActions).toEqual([{ tool: 'manage_services', reason: 'Agent is disabled' }]);
      expect(outcome.executedActions).toEqual([]);
      expect(outcome.proposedActions).toEqual([]);
      expect(outcome.runVerdict).toBe('no_action');
    });

    it('downgrade (drift act→shadow, or cap exhaustion) records a PROPOSAL — never executes', async () => {
      seedActRun();
      revalidateActExecution.mockResolvedValue({ ok: false, downgrade: 'propose' });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Proposed a restart for review.' });

      await executeAgentRun(RUN_ID);

      expect(startToolExecution).not.toHaveBeenCalled();
      // manage_services:restart is Tier 3 — same intent path an ordinary
      // shadow-mode proposal takes.
      expect(createActionIntent).toHaveBeenCalledTimes(1);
      expect(preVerdicts[0]).toEqual({ allowed: false, error: PROPOSAL_RECORDED_TEXT });

      const final = finalTransition()!;
      // A pending action-intent leaves the run 'awaiting_approval' — same
      // terminal status an ordinary shadow-mode Tier-3 proposal produces.
      expect(final.to).toBe('awaiting_approval');
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.proposedActions).toHaveLength(1);
      expect(outcome.proposedActions[0]!.tool).toBe('manage_services');
      expect(outcome.proposedActions[0]!.intentId).toBe(INTENT_ID);
      expect(outcome.executedActions).toEqual([]);
      expect(outcome.deniedActions).toEqual([]);
      expect(outcome.runVerdict).toBe('no_action');
    });

    it('verification failure raises the rule-less alert and rolls up to needs_attention', async () => {
      seedActRun();
      revalidateActExecution.mockImplementation(async (args: Record<string, unknown>) => ({
        ok: true,
        pin: { op: args.op, target: { kind: 'service', serviceName: 'Spooler' } },
      }));
      verifyActExecution.mockResolvedValue({
        execution: 'succeeded', verification: 'failed', verifyDetail: 'service status is "stopped"',
      });
      scriptQuery({ toolCalls: [ACT_CALL], assistantText: 'Restarted the spooler service.' });

      await executeAgentRun(RUN_ID);

      expect(recordActVerifyFailureAlert).toHaveBeenCalledTimes(1);
      const alertArgs = recordActVerifyFailureAlert.mock.calls[0]![0] as Record<string, unknown>;
      expect((alertArgs.run as Record<string, unknown>).deviceId).toBe(DEVICE_ID);
      expect((alertArgs.op as Record<string, unknown>).key).toBe('manage_services.restart');
      expect(alertArgs.detail).toBe('service status is "stopped"');

      const final = finalTransition()!;
      const outcome = final.patch.outcome as AgentRunOutcome;
      expect(outcome.executedActions[0]).toMatchObject({ execution: 'succeeded', verification: 'failed' });
      expect(outcome.runVerdict).toBe('needs_attention');
    });

    it('an unmatched mutation under act mode still proposes exactly like shadow (no revalidation call)', async () => {
      // execute_command has NO manifest entry — resolveActOperation returns
      // null, so checkAgentGuardrails itself returns 'propose', and the
      // pre-hook must never call revalidateActExecution for it.
      seedRows({
        effective: policy({ mode: 'act', toolAllowlist: ['execute_command'] }),
        modeAtStart: 'act',
      });
      scriptQuery({
        toolCalls: [{ tool: 'execute_command', input: { deviceId: DEVICE_ID, commandType: 'restart_service', payload: {} } }],
        assistantText: 'Proposed a restart for review.',
      });

      await executeAgentRun(RUN_ID);

      expect(revalidateActExecution).not.toHaveBeenCalled();
      expect(createActionIntent).toHaveBeenCalledTimes(1);
      expect(preVerdicts[0]).toEqual({ allowed: false, error: PROPOSAL_RECORDED_TEXT });
    });
  });

  it('policy revoked between admission and start => skipped, no SDK call', async () => {
    seedRows();
    resolveEffectiveAgentSystem.mockResolvedValue(snapshot(policy({ enabled: false })));

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('skipped');
    expect(final.patch.errorCode).toBe('policy_revoked_before_start');
    expect(publishEvent.mock.calls.map((c) => c[0])).toContain('ai.agent.run.skipped');
  });

  it('the kill switch flipping off between admission and start also skips', async () => {
    seedRows();
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    expect(finalTransition()!.to).toBe('skipped');
  });

  it('duplicate delivery (CAS false) is a no-op', async () => {
    seedRows();
    transitionRunStatus.mockResolvedValue(false);

    await executeAgentRun(RUN_ID);

    expect(transitionRunStatus).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('wall-clock abort marks failed with wall_clock_exceeded when nothing was produced', async () => {
    seedRows({
      effective: policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, wallClockSeconds: 0.01 } as AiAgentLimits }),
    });
    scriptQuery({ hangUntilAbort: true, assistantText: 'never reached' });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('wall_clock_exceeded');
    expect(publishEvent.mock.calls.map((c) => c[0])).toContain('ai.agent.run.failed');
  });

  it('per-run budget breach aborts the loop', async () => {
    seedRows({
      effective: policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxBudgetCentsPerRun: 10 } as AiAgentLimits }),
    });
    scriptQuery({
      assistantText: 'partial work',
      results: [
        resultMessage({ total_cost_usd: 0.5, num_turns: 2 }),
        resultMessage({ total_cost_usd: 0.5, num_turns: 2 }),
      ],
    });

    await executeAgentRun(RUN_ID);

    // The second result message must never be pulled off the iterator.
    expect(yielded.filter((m) => (m as { type: string }).type === 'result')).toHaveLength(1);
    const final = finalTransition()!;
    expect((final.patch.outcome as { budgetExceeded?: boolean }).budgetExceeded).toBe(true);
    // Something useful was produced (a summary), so this is not a hard failure.
    expect(final.to).toBe('completed');
    expect(lastQueryOptions!.maxBudgetUsd).toBeCloseTo(0.1);
  });

  it('an SDK crash mid-loop still records the cost already spent', async () => {
    seedRows();
    queryMock.mockImplementation((params: { prompt: unknown; options: Record<string, unknown> }) => {
      lastQueryOptions = params.options;
      const generator = (async function* () {
        yield resultMessage({ total_cost_usd: 0.42, num_turns: 4 });
        throw new Error('anthropic 529 overloaded');
      })();
      return Object.assign(generator, { close: closeMock, interrupt: vi.fn() });
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('sdk_error');
    // A crashed run that recorded 0 cents would make the agent's daily budget
    // cap under-count real spend.
    expect(final.patch.costCents).toBe(42);
    expect(final.patch.turnCount).toBe(4);
  });

  it('a setup failure before any spend fails without inventing a cost', async () => {
    seedRows();
    resolveLlmConfigForOrg.mockResolvedValue({ source: 'unavailable', model: '' });

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('llm_unavailable');
    expect(final.patch.costCents).toBeUndefined();
  });

  it('passes the per-run turn ceiling and the agent model to the SDK', async () => {
    seedRows({
      effective: policy({ model: 'claude-agent-model', limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxTurnsPerRun: 7 } as AiAgentLimits }),
    });

    await executeAgentRun(RUN_ID);

    expect(lastQueryOptions!.maxTurns).toBe(7);
    expect(lastQueryOptions!.model).toBe('claude-agent-model');
    expect(lastQueryOptions!.persistSession).toBe(false);
    expect(lastQueryOptions!.settingSources).toEqual([]);
    expect(buildClaudeSdkChildEnv).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'platform' }),
    );
  });

  it('recipients are notified once with dedupeKey agent-run:<id>', async () => {
    seedRows({ recipients: { userIds: [USER_A, USER_B], roleIds: [] } });
    resolveRecipientUserIds.mockResolvedValue([USER_A, USER_B]);
    scriptQuery({ assistantText: 'Nothing actionable found.' });

    await executeAgentRun(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(2);
    for (const [input] of createNotification.mock.calls) {
      expect(input).toMatchObject({
        orgId: ORG_ID,
        type: 'ai',
        dedupeKey: `agent-run:${RUN_ID}`,
      });
      expect((input as { message: string }).message).toContain('Front Desk Triage');
    }
    expect(createNotification.mock.calls.map(([i]) => (i as { userId: string }).userId))
      .toEqual([USER_A, USER_B]);
  });

  // -------------------------------------------------------------------------
  // Durable notify retry lane (wave 4a, Task 6)
  // -------------------------------------------------------------------------

  it('a notify failure enqueues exactly one durable retry job and does not fail the run', async () => {
    seedRows({ recipients: { userIds: [], roleIds: [] } });
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    createNotification.mockRejectedValueOnce(new Error('notifications db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await executeAgentRun(RUN_ID);

    expect(enqueueAgentNotifyRetry).toHaveBeenCalledTimes(1);
    expect(enqueueAgentNotifyRetry).toHaveBeenCalledWith(RUN_ID);
    // The notify failure must never redefine the run's own terminal status —
    // it already committed 'completed' before notify ran at all.
    expect(finalTransition()!.to).toBe('completed');
  });

  it('a normal successful notify never enqueues a retry job', async () => {
    seedRows();
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await executeAgentRun(RUN_ID);

    expect(enqueueAgentNotifyRetry).not.toHaveBeenCalled();
  });

  it('builds the agent AuthContext from the RUN row, pinned to the device site', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    const auth = hooks.getAuth!() as {
      principal: { kind: string; runId: string };
      orgId: string;
      allowedSiteIds?: string[];
      user: { id: string };
    };
    expect(auth.principal).toMatchObject({ kind: 'ai_agent', runId: RUN_ID });
    expect(auth.orgId).toBe(ORG_ID);
    expect(auth.allowedSiteIds).toEqual([SITE_ID]);
  });

  it('a run whose agent belongs to another partner fails ownership_mismatch and never starts the SDK', async () => {
    seedRows();
    dbMockState.rowQueues.ai_agents = [[{
      id: AGENT_ID,
      orgId: '00000000-0000-4000-8000-0000000000e1',
      partnerId: null,
      name: 'Foreign Agent',
      kind: 'triage',
      recipients: { userIds: [], roleIds: [] },
    }]];

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('ownership_mismatch');
  });

  it('a missing run row is a loud no-op, never a transition', async () => {
    dbMockState.rowQueues.ai_agent_runs = [[]];

    await executeAgentRun(RUN_ID);

    expect(transitionRunStatus).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Review findings (wave 3c)
  // -------------------------------------------------------------------------

  it('an SDK terminal ERROR result fails the run instead of reporting a silent all-clear', async () => {
    seedRows();
    scriptQuery({
      results: [resultMessage({
        subtype: 'error_during_execution',
        is_error: true,
        result: undefined,
        errors: ['Anthropic API 500'],
      })],
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    // Before the fix this was `completed` with error_code NULL and an empty
    // summary — indistinguishable from "investigated, found nothing".
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('sdk_error');
    expect(publishEvent.mock.calls.map((c) => c[0])).toContain('ai.agent.run.failed');
    // The cost already burned is still recorded.
    expect(final.patch.costCents).toBe(25);
  });

  it('an unknown future result subtype is a failure, not a success', async () => {
    seedRows();
    scriptQuery({ results: [resultMessage({ subtype: 'error_brand_new_stop_reason', is_error: true })] });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()!.to).toBe('failed');
    expect(finalTransition()!.patch.errorCode).toBe('sdk_error');
  });

  it("the SDK's own budget stop (error_max_budget_usd) lands as budget_exceeded", async () => {
    seedRows();
    // Under the local guard's ceiling (25 cents < the 50-cent default), so this
    // can ONLY come from the subtype: the SDK halts at maxBudgetUsd itself,
    // which made the `costCents > limit` guard largely dead.
    scriptQuery({ results: [resultMessage({ subtype: 'error_max_budget_usd', is_error: true })] });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect((final.patch.outcome as { budgetExceeded?: boolean }).budgetExceeded).toBe(true);
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('budget_exceeded');
  });

  it('error_max_turns is a ceiling: flagged, and only a failure when nothing was produced', async () => {
    seedRows();
    scriptQuery({ results: [resultMessage({ subtype: 'error_max_turns', is_error: true })] });
    await executeAgentRun(RUN_ID);
    let final = finalTransition()!;
    expect((final.patch.outcome as { maxTurnsExceeded?: boolean }).maxTurnsExceeded).toBe(true);
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('max_turns_exceeded');

    // ...but a run that produced something first still finishes normally.
    vi.clearAllMocks();
    transitionRunStatus.mockResolvedValue(true);
    seedRows();
    scriptQuery({
      assistantText: 'Found the cause, ran out of turns writing it up.',
      results: [resultMessage({ subtype: 'error_max_turns', is_error: true })],
    });
    await executeAgentRun(RUN_ID);
    final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect((final.patch.outcome as { maxTurnsExceeded?: boolean }).maxTurnsExceeded).toBe(true);
  });

  it('an intent born cancelled (no eligible approvers) does NOT leave the run awaiting_approval', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }) });
    // createActionIntent does not throw here: it commits the intent and
    // immediately cancels it, returning that snapshot.
    createActionIntent.mockResolvedValue({
      id: INTENT_ID, status: 'cancelled', errorCode: 'no_eligible_approvers',
    });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'Proposed a print spooler restart.',
    });

    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    // Nothing is waiting in /approvals, so nothing may claim to be.
    expect(final.patch.intentIds).toEqual([]);
    const outcome = final.patch.outcome as { proposedActions: Array<Record<string, unknown>> };
    expect(outcome.proposedActions).toHaveLength(1);
    expect(outcome.proposedActions[0]!.intentError).toBe('no_eligible_approvers');
    // The model is told the proposal will not be reviewed.
    expect(preVerdicts[0]!.error).toContain('no_eligible_approvers');
    // And the notification does not link to a queue the intent never enters.
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('the stop gate rejects a run whose agent is no longer the effective one', async () => {
    seedRows();
    // Agent A was disabled and replacement B (same kind) resolved in its place.
    const replacement = snapshot(policy());
    replacement.agentId = '00000000-0000-4000-8000-0000000000f1';
    resolveEffectiveAgentSystem.mockResolvedValue(replacement);

    await executeAgentRun(RUN_ID);

    expect(queryMock).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('skipped');
    expect(final.patch.errorCode).toBe('policy_revoked_before_start');
  });

  it('org-pins the RLS-bypassing device and alert reads to the run org', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    const deviceSelect = dbMockState.selects.find((s) => s.table === 'devices');
    const alertSelect = dbMockState.selects.find((s) => s.table === 'alerts');
    // Both reads run inside a system context (full RLS bypass), so the tenant
    // predicate has to be in the WHERE clause by hand.
    expect(compiled(deviceSelect?.where)).toContain('"org_id"');
    expect(compiled(alertSelect?.where)).toContain('"org_id"');
  });

  it('a device that has moved to another org is not fed into the prompt', async () => {
    seedRows();
    // The org-pinned read finds nothing after the move.
    dbMockState.rowQueues.devices = [[]];

    await executeAgentRun(RUN_ID);

    const auth = hooks.getAuth!() as { allowedSiteIds?: string[] };
    expect(auth.allowedSiteIds).toEqual([]);
    const prompt = String((queryMock.mock.calls[0]![0] as { prompt: unknown }).prompt);
    expect(prompt).not.toContain('WS-ACCT-04');
  });

  it('notifies the MERGED recipient set from the run snapshot, not the baseline row', async () => {
    // Partner baseline row lists only USER_A; the org override added USER_B, so
    // the run's immutable snapshot carries the union.
    seedRows({
      effective: policy({ recipients: { userIds: [USER_A, USER_B], roleIds: [] } }),
      recipients: { userIds: [USER_A], roleIds: [] },
    });
    resolveRecipientUserIds.mockResolvedValue([USER_A, USER_B]);

    await executeAgentRun(RUN_ID);

    expect(resolveRecipientUserIds).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: { userIds: [USER_A, USER_B], roleIds: [] } }),
      ORG_ID,
    );
  });

  it('records org AI spend from the SDK figure — cache tokens included, credits deducted', async () => {
    seedRows();
    scriptQuery({
      assistantText: 'done',
      results: [resultMessage({
        total_cost_usd: 0.4,
        num_turns: 5,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 90_000,
          cache_creation_input_tokens: 5_000,
        },
      })],
    });

    await executeAgentRun(RUN_ID);

    // recordUsage(null, …) used to stand here: it re-priced from input/output
    // alone and deducted no platform credits at all.
    expect(recordSessionlessSdkUsage).toHaveBeenCalledTimes(1);
    const [orgId, payload, billingSource] = recordSessionlessSdkUsage.mock.calls[0]!;
    expect(orgId).toBe(ORG_ID);
    expect(billingSource).toBe('platform');
    expect(payload).toMatchObject({
      costCents: 40,
      numTurns: 5,
      usage: expect.objectContaining({
        cache_read_input_tokens: 90_000,
        cache_creation_input_tokens: 5_000,
      }),
    });
  });

  it('records a cache-only result that reports no plain input/output tokens', async () => {
    seedRows();
    scriptQuery({
      assistantText: 'done',
      results: [resultMessage({
        total_cost_usd: 0.12,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 200_000 },
      })],
    });

    await executeAgentRun(RUN_ID);

    expect(recordSessionlessSdkUsage).toHaveBeenCalledTimes(1);
    expect(recordSessionlessSdkUsage.mock.calls[0]![1]).toMatchObject({ costCents: 12 });
  });

  it('a usage-recording failure never redefines the run outcome', async () => {
    seedRows();
    recordSessionlessSdkUsage.mockRejectedValueOnce(new Error('billing service down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await executeAgentRun(RUN_ID);

    expect(finalTransition()!.to).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // Execution ledger wiring (wave 4a, Task 2)
  // -------------------------------------------------------------------------

  it('creates exactly one execution-ledger session per run, with the snapshot model + turn ceiling', async () => {
    seedRows({
      effective: policy({ model: 'claude-agent-model', limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxTurnsPerRun: 9 } as AiAgentLimits }),
    });

    await executeAgentRun(RUN_ID);

    expect(createAgentRunSession).toHaveBeenCalledTimes(1);
    expect(createAgentRunSession).toHaveBeenCalledWith(expect.objectContaining({
      runId: RUN_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      model: 'claude-agent-model',
      maxTurns: 9,
    }));
  });

  it('falls back to the resolved LLM model when the snapshot has none', async () => {
    seedRows({ effective: policy({ model: null }) });

    await executeAgentRun(RUN_ID);

    expect(createAgentRunSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-fallback' }),
    );
  });

  it('an allowed tool call gets a real ledger execution id, threaded onto the outcome', async () => {
    seedRows();
    scriptQuery({
      toolCalls: [{ tool: 'query_devices', input: { status: 'online' } }],
      assistantText: 'done',
    });

    await executeAgentRun(RUN_ID);

    expect(startToolExecution).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      toolName: 'query_devices',
      toolInput: { status: 'online' },
    }));
    expect(completeToolExecution).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'exec-1',
      isError: false,
      durationMs: 5,
    }));

    const final = finalTransition()!;
    const outcome = final.patch.outcome as { executedActions: Array<{ executionId: string }> };
    expect(outcome.executedActions[0]!.executionId).toBe('exec-1');
  });

  it('a ledger write failure never blocks the tool call — falls back to (inline)', async () => {
    seedRows();
    startToolExecution.mockRejectedValueOnce(new Error('db unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    scriptQuery({
      toolCalls: [{ tool: 'query_devices', input: { status: 'online' } }],
      assistantText: 'done',
    });

    await executeAgentRun(RUN_ID);

    // The gate still allowed the call — the ledger write is observability
    // only, never authorization.
    expect(preVerdicts[0]).toEqual({ allowed: true });
    expect(completeToolExecution).not.toHaveBeenCalled();

    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    const outcome = final.patch.outcome as { executedActions: Array<{ executionId: string; result: string }> };
    expect(outcome.executedActions[0]).toMatchObject({ executionId: '(inline)', result: 'ok' });
  });

  it('reconciles hung executions and closes the session on finish', async () => {
    seedRows();

    await executeAgentRun(RUN_ID);

    expect(reconcileHungExecutions).toHaveBeenCalledWith('session-1');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'completed');
  });

  it('closes the session as failed when the run itself fails', async () => {
    seedRows();
    scriptQuery({
      results: [resultMessage({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['boom'] })],
    });

    await executeAgentRun(RUN_ID);

    expect(finalTransition()!.to).toBe('failed');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'failed');
  });

  it('still reconciles and closes the session when finishRun loses the CAS (!moved)', async () => {
    seedRows();
    // First call is the queued->running CAS (must succeed so a session gets
    // created); the second is finishRun's running->completed CAS, which loses
    // to a competing executor (or reapStalledAgentRuns) here.
    transitionRunStatus.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await executeAgentRun(RUN_ID);

    expect(transitionRunStatus).toHaveBeenCalledTimes(2);
    expect(reconcileHungExecutions).toHaveBeenCalledWith('session-1');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'completed');
  });

  it('still reconciles and closes the session when something throws after session creation', async () => {
    seedRows();
    createBreezeMcpServer.mockImplementationOnce(() => {
      throw new Error('boom — mcp server construction failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await executeAgentRun(RUN_ID);

    // The run still ends up `failed` via executeAgentRun's outer catch, and
    // the session created just before the throw is still cleaned up.
    expect(finalTransition()!.to).toBe('failed');
    expect(reconcileHungExecutions).toHaveBeenCalledWith('session-1');
    expect(closeAgentRunSession).toHaveBeenCalledWith('session-1', 'failed');
  });

  it('a denied call never reaches the ledger — no execution row is started', async () => {
    seedRows({ effective: policy({ toolAllowlist: [] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'denied',
    });

    await executeAgentRun(RUN_ID);

    expect(startToolExecution).not.toHaveBeenCalled();
  });

  it('a proposed (shadow) call never reaches the ledger — no execution row is started', async () => {
    seedRows({ effective: policy({ toolAllowlist: ['manage_services'] }) });
    scriptQuery({
      toolCalls: [{ tool: 'manage_services', input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' } }],
      assistantText: 'proposed',
    });

    await executeAgentRun(RUN_ID);

    expect(startToolExecution).not.toHaveBeenCalled();
  });
});

describe('computeRunVerdict', () => {
  function executed(overrides: Partial<AgentRunOutcome['executedActions'][number]> = {}) {
    return { tool: 'manage_services', executionId: 'exec-1', result: 'ok' as const, durationMs: 5, ...overrides };
  }

  it('no_action when nothing acted (no executedActions carry a verification field)', () => {
    expect(computeRunVerdict({ executedActions: [], proposedActions: [] })).toBe('no_action');
    expect(computeRunVerdict({ executedActions: [executed()], proposedActions: [] })).toBe('no_action');
  });

  it('remediated when every acted op verified passed, with no proposals', () => {
    const outcome = {
      executedActions: [executed({ verification: 'passed', execution: 'succeeded' })],
      proposedActions: [],
    };
    expect(computeRunVerdict(outcome)).toBe('remediated');
  });

  it('needs_attention when ANY acted op verified failed or inconclusive', () => {
    expect(computeRunVerdict({
      executedActions: [
        executed({ verification: 'passed', execution: 'succeeded' }),
        executed({ verification: 'failed', execution: 'succeeded' }),
      ],
      proposedActions: [],
    })).toBe('needs_attention');
    expect(computeRunVerdict({
      executedActions: [executed({ verification: 'inconclusive', execution: 'unknown' })],
      proposedActions: [],
    })).toBe('needs_attention');
  });

  it('partial when every acted op passed but the run ALSO left proposals', () => {
    const outcome = {
      executedActions: [executed({ verification: 'passed', execution: 'succeeded' })],
      proposedActions: [{ tool: 'run_script', args: {} }],
    };
    expect(computeRunVerdict(outcome)).toBe('partial');
  });

  it('needs_attention takes priority over partial when both conditions hold', () => {
    const outcome = {
      executedActions: [executed({ verification: 'failed', execution: 'succeeded' })],
      proposedActions: [{ tool: 'run_script', args: {} }],
    };
    expect(computeRunVerdict(outcome)).toBe('needs_attention');
  });
});

