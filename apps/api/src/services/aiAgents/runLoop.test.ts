import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  selects: [] as Array<{ table: string; where?: SQL }>,
  systemContextDepth: 0,
  ambientContext: undefined as { scope: string } | undefined,
}));

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (!queue || queue.length === 0) throw new Error(`No queued rows for table ${table}`);
  return queue.shift() as unknown[];
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

const resolveEffectiveAgentSystem = vi.hoisted(() =>
  vi.fn<(orgId: string, kind: string) => Promise<AiAgentPolicySnapshot | null>>());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

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
  vi.fn<(auth: unknown, input: Record<string, unknown>) => Promise<{ id: string }>>());
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));

const resolveRecipientUserIds = vi.hoisted(() =>
  vi.fn<(agent: unknown, orgId: string) => Promise<string[]>>(async () => []));
vi.mock('./recipients', () => ({ resolveRecipientUserIds }));

const createNotification = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<string | null>>(async () => 'notification-1'));
vi.mock('../userNotifications', () => ({ createNotification }));

const resolveLlmConfigForOrg = vi.hoisted(() =>
  vi.fn<(orgId: string) => Promise<{ source: string; apiKey?: string; model: string }>>());
vi.mock('../llm/llmConfigResolver', () => ({ resolveLlmConfigForOrg }));

const buildClaudeSdkChildEnv = vi.hoisted(() =>
  vi.fn<(resolved: { source: string }) => Record<string, string>>(() => ({ CI: 'true' })));
vi.mock('../streamingSessionManager', () => ({ buildClaudeSdkChildEnv }));

const recordUsage = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
const calculateCostCents = vi.hoisted(() => vi.fn<(...args: unknown[]) => number>(() => 0));
vi.mock('../aiCostTracker', () => ({ recordUsage, calculateCostCents }));

// checkToolPermission must NEVER be reachable from an agent run. Spying through
// the real module would require mocking it; instead the contract is asserted by
// the red-team suite (Task 5). Here we assert the loop never imports it by
// asserting on the guardrail path it DOES take.
import { executeAgentRun } from './runLoop';

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
  recipients?: { userIds: string[]; roleIds: string[] };
  agentOrgId?: string | null;
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
    modeAtStart: 'shadow',
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
  dbMockState.selects.length = 0;
  dbMockState.systemContextDepth = 0;
  dbMockState.ambientContext = undefined;
  yielded.length = 0;
  preVerdicts.length = 0;
  lastQueryOptions = undefined;
  transitionRunStatus.mockResolvedValue(true);
  resolveLlmConfigForOrg.mockResolvedValue({ source: 'platform', apiKey: 'sk-test', model: 'claude-fallback' });
  resolveRecipientUserIds.mockResolvedValue([]);
  createActionIntent.mockResolvedValue({ id: INTENT_ID });
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
});
