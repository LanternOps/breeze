// apps/api/src/services/aiAgents/runLoop.ticketTriage.test.ts
/**
 * Phase 2 wave P2-4 (ticket triage, #4191), Task A8 — the `triage` profile's
 * wiring into the run loop's finish path: `finalizeTicketTriage` calling
 * `persistTicketTriage` with the right run shape, and the run-status
 * classification extension (`classifyIntentAwaitingApproval`) that lets a
 * creation-time `ticket_autonomy` grant finish `completed` instead of
 * `awaiting_approval`.
 *
 * Its own file rather than more cases in `runLoop.test.ts` — same reasoning
 * as `runLoop.sweep.test.ts`/`runLoop.narrative.test.ts`: a triage run needs
 * a DIFFERENT seeded run row (`ticketId`/`triggerKind: 'ticket'`) plus its
 * own extra module mock (`./ticketContext`). The mock harness below is the
 * same shape as `runLoop.sweep.test.ts`'s, trimmed to what a triage run
 * actually reaches. `persistTicketTriage`'s own gates (confidence floor,
 * human-set pre-filter, cap, autonomy) are unit-tested directly in
 * `ticketTriageFindings.test.ts` — this file exercises only the run loop's
 * WIRING contract and the status-classification extension.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy, type AiAgentPolicySnapshot } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000d1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000d2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000d3';
const RUN_ID = '00000000-0000-4000-8000-0000000000d6';
const TICKET_ID = '00000000-0000-4000-8000-0000000000d7';
const USER_A = '00000000-0000-4000-8000-0000000000d8';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// db mock (same table-keyed harness shape as runLoop.sweep.test.ts)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  lastRow: {} as Record<string, unknown>,
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
      const builder: Record<string, unknown> = {
        where: vi.fn(() => builder),
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
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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

// `ticketContext.ts` is an I/O-heavy leaf module with its own dedicated unit
// suite — mocked here at the module boundary, same precedent as
// `loadSweepEvidence` in `runLoop.sweep.test.ts`. `null` is a valid, already
// -handled value (`ctx.ticket ? ... : null` in the prompt builder).
const loadTicketContext = vi.hoisted(() => vi.fn<(ticketId: string, orgId: string) => Promise<unknown>>());
vi.mock('./ticketContext', () => ({ loadTicketContext }));

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

import { classifyIntentAwaitingApproval, executeAgentRun } from './runLoop';

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
    schemaVersion: 8,
    agentId: AGENT_ID,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-08-30T00:00:00Z').toISOString(),
  };
}

function seedRows(options: { effective?: AiAgentPolicy } = {}) {
  const effective = options.effective ?? policy();
  dbMockState.rowQueues.ai_agent_runs = [[{
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: null,
    alertId: null,
    ticketId: TICKET_ID,
    anomalyIncidentId: null,
    status: 'queued',
    modeAtStart: effective.mode === 'off' ? 'shadow' : effective.mode,
    triggerKind: 'ticket',
    policySnapshot: snapshot(effective),
    profile: 'triage',
    correlationGroupId: null,
    scheduleId: null,
    triggerRef: {},
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    name: 'Triage Bot',
    kind: 'triage',
    recipients: { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(effective));
  return effective;
}

const hooks: Hooks = {};
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
  queryMock.mockImplementation(() => {
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

const VALID_PROPOSAL = {
  version: 1,
  summary: 'Printer offline; likely a driver issue.',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  dbMockState.rowQueues = {};
  dbMockState.lastRow = {};
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
  getCachedAiKillStateSnapshot.mockReturnValue({ killed: false, epoch: 0 });
  loadTicketContext.mockResolvedValue(null);
  createBreezeMcpServer.mockImplementation((getAuth, pre, post) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery({ assistantText: 'Triage complete.' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('classifyIntentAwaitingApproval', () => {
  it('no intents -> not awaiting approval', () => {
    expect(classifyIntentAwaitingApproval([], undefined)).toBe(false);
  });

  it('an ordinary pending intent (decidedIntentIds unset) -> awaiting approval, unchanged from every pre-P2-4 profile', () => {
    expect(classifyIntentAwaitingApproval(['a'], undefined)).toBe(true);
  });

  it('every created intent already decided by ticket_autonomy -> not awaiting approval', () => {
    expect(classifyIntentAwaitingApproval(['a', 'b'], ['a', 'b'])).toBe(false);
  });

  it('a mix of decided and still-pending intents -> awaiting approval', () => {
    expect(classifyIntentAwaitingApproval(['a', 'b'], ['a'])).toBe(true);
  });
});

describe('ticket-triage persistence at finish (P2-4, Task A8)', () => {
  it('a non-autonomous run creates pending intents and finishes awaiting_approval', async () => {
    seedRows({ effective: policy({ mode: 'shadow' }) });
    dbMockState.rowQueues.tickets = [[{ deviceId: null, resolutionNote: null, fieldProvenance: {} }]];
    createActionIntent.mockResolvedValue({ id: 'intent-triage-1', status: 'pending_approval' });
    scriptQuery({
      toolCalls: [{ tool: 'submit_ticket_proposal', input: VALID_PROPOSAL }],
      assistantText: 'Proposal submitted.',
    });

    await executeAgentRun(RUN_ID);

    expect(createActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      toolName: 'manage_tickets',
      source: 'ai_agent',
      orgId: ORG_ID,
      scope: { ticketId: TICKET_ID },
      autonomy: undefined,
    }));
    const final = finalTransition()!;
    expect(final.to).toBe('awaiting_approval');
    expect(final.patch.intentIds).toEqual(['intent-triage-1']);
  });

  it('an autonomous (ticket_autonomy) run creates approved intents and finishes completed', async () => {
    const effective = policy({
      mode: 'act',
      triggers: { ...policy().triggers, ticketAutonomousWrites: true },
    });
    seedRows({ effective });
    dbMockState.rowQueues.tickets = [[{ deviceId: null, resolutionNote: null, fieldProvenance: {} }]];
    createActionIntent.mockResolvedValue({ id: 'intent-triage-2', status: 'approved' });
    scriptQuery({
      toolCalls: [{ tool: 'submit_ticket_proposal', input: VALID_PROPOSAL }],
      assistantText: 'Proposal submitted.',
    });

    await executeAgentRun(RUN_ID);

    expect(createActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      toolName: 'manage_tickets',
      autonomy: { kind: 'ticket_autonomy' },
    }));
    const final = finalTransition()!;
    // The whole point of Task A8's status-classification extension: an
    // approved (already-decided) intent must not leave the run
    // `awaiting_approval` — nobody is waiting on it.
    expect(final.to).toBe('completed');
    expect(final.patch.intentIds).toEqual(['intent-triage-2']);
  });

  it('a mid-loop status flip leaves the run awaiting_approval — ground truth, not the uniform advisory flag', async () => {
    // Autonomy is REQUESTED for the whole run (act + ticketAutonomousWrites),
    // but the two candidates this proposal mints (note, then draft-reply)
    // resolve DIFFERENTLY: the first is granted (`approved`), the second is
    // not (`pending_approval`) — e.g. a kill-switch trip between the two
    // sequential createActionIntent calls. The review-flagged bug: reading
    // the call-level `autonomous` flag uniformly would mark BOTH ids
    // decided and wrongly finish `completed` with a human decision still
    // outstanding on the second intent.
    const effective = policy({
      mode: 'act',
      triggers: { ...policy().triggers, ticketAutonomousWrites: true },
    });
    seedRows({ effective });
    dbMockState.rowQueues.tickets = [[{ deviceId: null, resolutionNote: null, fieldProvenance: {} }]];
    let call = 0;
    createActionIntent.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { id: 'intent-triage-approved', status: 'approved' }
        : { id: 'intent-triage-pending', status: 'pending_approval' };
    });
    scriptQuery({
      toolCalls: [{
        tool: 'submit_ticket_proposal',
        input: { ...VALID_PROPOSAL, draftReply: 'We are looking into this now.' },
      }],
      assistantText: 'Proposal submitted.',
    });

    await executeAgentRun(RUN_ID);

    expect(createActionIntent).toHaveBeenCalledTimes(2);
    const final = finalTransition()!;
    expect(final.to).toBe('awaiting_approval');
    expect(final.patch.intentIds).toEqual(['intent-triage-approved', 'intent-triage-pending']);
  });

  it('a run that never calls submit_ticket_proposal finishes completed with ticket_proposal_missing', async () => {
    seedRows({ effective: policy({ mode: 'shadow' }) });
    scriptQuery({ assistantText: 'Nothing to report.' });

    await executeAgentRun(RUN_ID);

    expect(createActionIntent).not.toHaveBeenCalled();
    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBe('ticket_proposal_missing');
  });
});
