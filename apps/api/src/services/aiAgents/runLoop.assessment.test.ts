// apps/api/src/services/aiAgents/runLoop.assessment.test.ts
/**
 * Wisp W05b Task 6 — the `assessment` profile's wiring into the run loop:
 * the run's agent AuthContext carries `wispGrant` (w00 A2/A23), the context
 * load and its `grant_inactive` short-circuit, the profile's limits/floor
 * arms, the append-only outcome capture, and the `finalizeAssessment`
 * dispatch. The finalizer's own rules are unit-tested in
 * `runFinalizers.assessment.test.ts`; the harness below is
 * `runLoop.ticketTriage.test.ts`'s, trimmed to what an assessment reaches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy, type AiAgentPolicySnapshot } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000d1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000d2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000d3';
const RUN_ID = '00000000-0000-4000-8000-0000000000d6';
const TICKET_ID = '00000000-0000-4000-8000-0000000000d7';
const GRANT_ID = '00000000-0000-4000-8000-0000000000e1';
const REVISION_ID = '00000000-0000-4000-8000-0000000000e2';
const GRANTOR = '00000000-0000-4000-8000-0000000000e3';
const THREAD_ID = '00000000-0000-4000-8000-0000000000e4';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// db mock (same table-keyed harness shape as runLoop.ticketTriage.test.ts)
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
    return [{ ...base, status: last[2] }];
  }
  if (table === 'ai_agents' && dbMockState.lastRow.ai_agents) return [dbMockState.lastRow.ai_agents];
  throw new Error(`No queued rows for table ${table}`);
}

const loadProvenFixesForRun = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('../fixMemory/runMemory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fixMemory/runMemory')>()),
  loadProvenFixesForRun,
}));

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
  vi.fn<(runId: string, from: unknown, to: string, patch?: Record<string, unknown>) => Promise<boolean>>());
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

const getCachedAiKillStateSnapshot = vi.hoisted(() =>
  vi.fn<() => { killed: boolean; epoch: number }>(() => ({ killed: false, epoch: 0 })));
vi.mock('../aiKillState', () => ({
  readAiKillState: vi.fn(async () => ({ killed: false, epoch: 0 })), getCachedAiKillStateSnapshot,
}));

vi.mock('./actRevalidation', () => ({ revalidateActExecution: vi.fn() }));
vi.mock('./actVerify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./actVerify')>()),
  verifyActExecution: vi.fn(),
  recordActVerifyFailureAlert: vi.fn(async () => undefined),
}));
vi.mock('./playbookActExecutor', () => ({ executeBuiltInPlaybookForRun: vi.fn() }));

const publishEvent = vi.hoisted(() =>
  vi.fn<(type: string, orgId: string, payload: unknown, source: string) => Promise<string>>(async () => 'event-1'));
vi.mock('../eventBus', () => ({ publishEvent }));

const queryMock = vi.hoisted(() => vi.fn<(params: { prompt: unknown; options: Record<string, unknown> }) => unknown>());
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: queryMock,
}));

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
  TOOL_TIERS: { query_devices: 1 },
  listChatSurfaceToolNames: () => ['query_devices'],
  POST_TOOL_USE_TIMEOUT_MS: 10_000,
}));

const createActionIntent = vi.hoisted(() => vi.fn());
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));

vi.mock('./ticketContext', () => ({ loadTicketContext: vi.fn(async () => null) }));
vi.mock('./recipients', () => ({ resolveRecipientUserIds: vi.fn(async () => []) }));
vi.mock('../userNotifications', () => ({ createNotification: vi.fn(async () => 'notification-1') }));
vi.mock('../../jobs/agentNotifyRetryWorker', () => ({ enqueueAgentNotifyRetry: vi.fn(async () => undefined) }));
vi.mock('../../jobs/fixWatchWorker', () => ({ scheduleFixWatch: vi.fn(async () => undefined) }));

const resolveModel = vi.hoisted(() => vi.fn());
vi.mock('../aiModels/resolveModel', () => ({ resolveModel }));
vi.mock('../aiModels/settleInvocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiModels/settleInvocation')>()),
  settleInvocation: vi.fn(async () => ({ costCents: 0, invocationIds: [], deferred: false })),
}));
vi.mock('../streamingSessionManager', () => ({ buildClaudeSdkChildEnv: vi.fn(() => ({ CI: 'true' })) }));
vi.mock('../aiCostTracker', () => ({}));
const reserveAiBudget = vi.hoisted(() => vi.fn());
vi.mock('../aiBudgetReservations', () => ({ reserveAiBudget, markAiBudgetReservationIndeterminate: vi.fn() }));

// Wisp seams.
const loadAssessmentContext = vi.hoisted(() => vi.fn());
const rollupPartnerPicture = vi.hoisted(() => vi.fn(async () => 'picture'));
vi.mock('../wisp/assessment', () => ({ loadAssessmentContext, rollupPartnerPicture }));
vi.mock('../wisp/readiness', () => ({ renderReadinessSummary: vi.fn(() => 'readiness') }));
const upsertConcern = vi.hoisted(() => vi.fn(async () => ({ id: 'c-new', created: true })));
vi.mock('../wisp/concerns', () => ({
  upsertConcern,
  updateConcern: vi.fn(async () => undefined),
  resolveConcern: vi.fn(async () => undefined),
  recordNudge: vi.fn(),
  getConcernForCeiling: vi.fn(async () => null),
}));
vi.mock('../wisp/deliver', () => ({ deliverInApp: vi.fn(async () => ({ created: true })) }));
const resolveGrantCeiling = vi.hoisted(() => vi.fn());
vi.mock('../wisp/grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../wisp/grantAuthority')>()),
  resolveGrantCeiling,
}));

import { executeAgentRun, resolveRunProfileLimits, resolveRunProfileToolAllowlist } from './runLoop';
import { assessmentToolAllowlist } from './assessmentProfile';
import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import type { GrantCeiling } from '../wisp/grantAuthority';
import type { AssessmentRunContext } from './runLoopTypes';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function policy(): AiAgentPolicy {
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
  };
}

function snapshot(effective: AiAgentPolicy): AiAgentPolicySnapshot {
  return {
    schemaVersion: 8, agentId: AGENT_ID, kind: 'triage', effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-08-30T00:00:00Z').toISOString(),
  };
}

function seedRows(run: { profile: 'assessment' | 'triage'; grant: boolean }) {
  const effective = policy();
  dbMockState.rowQueues.ai_agent_runs = [[{
    id: RUN_ID, agentId: AGENT_ID, orgId: ORG_ID, deviceId: null, alertId: null,
    ticketId: run.profile === 'triage' ? TICKET_ID : null,
    anomalyIncidentId: null, status: 'queued', modeAtStart: 'shadow',
    triggerKind: run.profile === 'triage' ? 'ticket' : 'schedule',
    policySnapshot: snapshot(effective), profile: run.profile, correlationGroupId: null, scheduleId: null,
    triggerRef: run.grant ? { wisp: { grantId: GRANT_ID, grantRevisionId: REVISION_ID, reason: { kind: 'tick' }, watermark: null } } : {},
    taskId: null, taskStepKey: null, taskAttemptOrdinal: null,
    grantId: run.grant ? GRANT_ID : null,
    grantRevisionId: run.grant ? REVISION_ID : null,
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID, orgId: null, partnerId: PARTNER_ID, name: 'Wisp', kind: 'triage',
    recipients: { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(effective));
}

function ceiling(): GrantCeiling {
  return {
    grantId: GRANT_ID, revisionId: REVISION_ID, partnerId: PARTNER_ID, grantorUserId: GRANTOR,
    scopeOrgId: null, partnerWide: true, orgIds: new Set([ORG_ID]), siteIds: null,
    permissionKeys: new Set(['*:*']), toolAllowlist: null, deniedTools: new Set(), orgTerms: new Map(),
    status: 'active',
  };
}

function assessmentCtx(): AssessmentRunContext {
  return {
    grantId: GRANT_ID, grantRevisionId: REVISION_ID, grantorUserId: GRANTOR, threadId: THREAD_ID,
    threadSummary: 'Wisp picture', openConcerns: [], changedSince: null,
    digest: { alerts: [], tickets: [], incidents: [], runs: [], intents: [] },
    watch: null, reason: { kind: 'tick' }, readiness: null, nudgeFeedback: [],
  };
}

const hooks: Hooks = {};
let lastQuery: { prompt: unknown; options: Record<string, unknown> } | undefined;

function scriptQuery(toolCalls: Array<{ tool: string; input: Record<string, unknown> }> = [], text = 'Assessment done.') {
  queryMock.mockImplementation((params) => {
    lastQuery = params;
    const generator = (async function* () {
      for (const call of toolCalls) {
        const verdict = await hooks.pre!(call.tool, call.input);
        await hooks.post!(call.tool, call.input, verdict.allowed ? '{"status":"recorded"}' : JSON.stringify({ error: verdict.error }), !verdict.allowed, 5);
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
      yield {
        type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: '',
        total_cost_usd: 0.05, usage: { input_tokens: 900, output_tokens: 200 },
      };
    })();
    return Object.assign(generator, { close: vi.fn(), interrupt: vi.fn() });
  });
}

function finalTransition(): { to: string; patch: Record<string, unknown> } | undefined {
  const last = transitionRunStatus.mock.calls.at(-1);
  return last ? { to: last[2], patch: (last[3] ?? {}) as Record<string, unknown> } : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  reserveAiBudget.mockResolvedValue({
    kind: 'unlimited', reservationId: '00000000-0000-4000-8000-0000000000f1',
    dailyPeriodKey: '2026-09-06', monthlyPeriodKey: '2026-09-01', status: 'active',
  });
  dbMockState.rowQueues = {};
  dbMockState.lastRow = {};
  lastQuery = undefined;
  transitionRunStatus.mockResolvedValue(true);
  createAgentRunSession.mockResolvedValue('session-1');
  let n = 0;
  startToolExecution.mockImplementation(async () => `exec-${++n}`);
  completeToolExecution.mockResolvedValue(undefined);
  reconcileHungExecutions.mockResolvedValue(0);
  closeAgentRunSession.mockResolvedValue(undefined);
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
  getCachedAiKillStateSnapshot.mockReturnValue({ killed: false, epoch: 0 });
  resolveGrantCeiling.mockResolvedValue(ceiling());
  loadAssessmentContext.mockResolvedValue(assessmentCtx());
  createBreezeMcpServer.mockImplementation((getAuth, pre, post) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assessment run-loop wiring (Wisp W05b)', () => {
  it("a grant run's agentAuth carries wispGrant; a plain run's does not", async () => {
    seedRows({ profile: 'assessment', grant: true });
    await executeAgentRun(RUN_ID);
    expect((hooks.getAuth!() as { wispGrant?: unknown }).wispGrant)
      .toEqual({ grantId: GRANT_ID, grantRevisionId: REVISION_ID, sessionId: null });

    vi.clearAllMocks();
    hooks.getAuth = undefined;
    dbMockState.rowQueues = {};
    dbMockState.lastRow = {};
    transitionRunStatus.mockResolvedValue(true);
    createAgentRunSession.mockResolvedValue('session-1');
    resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
    seedRows({ profile: 'triage', grant: false });
    await executeAgentRun(RUN_ID);
    expect(hooks.getAuth).toBeDefined();
    expect((hooks.getAuth!() as { wispGrant?: unknown }).wispGrant).toBeUndefined();
    expect(loadAssessmentContext).not.toHaveBeenCalled();
  });

  it('loads the assessment context from the run row and renders the assessment task prompt', async () => {
    seedRows({ profile: 'assessment', grant: true });
    await executeAgentRun(RUN_ID);
    expect(loadAssessmentContext).toHaveBeenCalledWith({
      id: RUN_ID, orgId: ORG_ID, grantId: GRANT_ID, grantRevisionId: REVISION_ID,
      triggerRef: { wisp: { grantId: GRANT_ID, grantRevisionId: REVISION_ID, reason: { kind: 'tick' }, watermark: null } },
    });
    expect(String(lastQuery?.prompt)).toContain('## Mode: assessment');
    const allowed = lastQuery?.options.allowedTools as string[];
    for (const name of ['record_concern', 'update_concern', 'nudge', 'propose_action', 'request_specialist']) {
      expect(allowed).toContain(`mcp__breeze__${name}`);
    }
    expect(finalTransition()?.to).toBe('completed');
  });

  it('an assessment whose grant is inactive (null context) is skipped grant_inactive with no model call', async () => {
    seedRows({ profile: 'assessment', grant: true });
    loadAssessmentContext.mockResolvedValue(null);
    await executeAgentRun(RUN_ID);
    expect(queryMock).not.toHaveBeenCalled();
    expect(createBreezeMcpServer).not.toHaveBeenCalled();
    expect(finalTransition()).toEqual({
      to: 'skipped', patch: expect.objectContaining({ errorCode: 'grant_inactive', summary: 'grant_inactive' }),
    });
    expect(publishEvent).toHaveBeenCalledWith('ai.agent.run.skipped', ORG_ID,
      expect.objectContaining({ reason: 'grant_inactive' }), expect.any(String));
  });

  it('outcome-tool calls APPEND to outcome.assessment and finalizeAssessment applies them', async () => {
    seedRows({ profile: 'assessment', grant: true });
    const raise = (summary: string) => ({ subject: { kind: 'org', id: ORG_ID }, summary, severity: 'low' });
    scriptQuery([
      { tool: 'record_concern', input: raise('first') },
      { tool: 'record_concern', input: raise('second') },
      { tool: 'request_specialist', input: { kind: 'backup', params: {}, reason: 'needs a backup specialist' } },
    ]);
    await executeAgentRun(RUN_ID);
    expect(upsertConcern).toHaveBeenCalledTimes(2);
    expect(rollupPartnerPicture).toHaveBeenCalledWith(GRANT_ID);
    const final = finalTransition()!;
    expect(final.to).toBe('completed');
    const outcome = final.patch.outcome as { assessment: { concernsRaised: unknown[]; specialistRequests: unknown[] } };
    expect(outcome.assessment.concernsRaised).toHaveLength(2);
    expect(outcome.assessment.specialistRequests).toHaveLength(1);
  });

  it('a non-assessment run cannot record an assessment outcome', async () => {
    seedRows({ profile: 'triage', grant: false });
    scriptQuery([{ tool: 'record_concern', input: { subject: { kind: 'org', id: ORG_ID }, summary: 's', severity: 'low' } }]);
    await executeAgentRun(RUN_ID);
    expect(upsertConcern).not.toHaveBeenCalled();
    const outcome = finalTransition()!.patch.outcome as { assessment?: unknown; deniedActions: Array<{ tool: string }> };
    expect(outcome.assessment).toBeUndefined();
    expect(outcome.deniedActions.map((d) => d.tool)).toContain('record_concern');
  });

  it('resolveRunProfileLimits / resolveRunProfileToolAllowlist take the assessment arms', () => {
    const limits = resolveRunProfileLimits({ profile: 'assessment' }, { ...AI_AGENT_LIMIT_DEFAULTS });
    expect(limits).toMatchObject({ maxTurnsPerRun: 15, maxBudgetCentsPerRun: 25, wallClockSeconds: 300, maxActionsPerRun: 0 });
    expect(resolveRunProfileToolAllowlist({ profile: 'assessment' }, ['run_script'])).toEqual(assessmentToolAllowlist([]));
  });
});
