// apps/api/src/services/aiAgents/runLoop.troubleshoot.run.test.ts
/**
 * Wisp delegation W1 (#11084) - the device_troubleshooting run's FINISH, driven
 * through `executeAgentRun`: a grant that went inactive mid-run finishes the
 * run `failed` / `grant_inactive` (even with intents already raised), a clean
 * finish is `awaiting_approval` with a pending intent and `completed` without,
 * and none of them delivers a run-finished notification. A full-profile run is
 * the control for both decisions.
 *
 * Harness copied from `runLoop.research.test.ts` (same db mock, same leaf-module
 * mocks); the grant ceiling and the run-finished delivery are the seams here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  type AiAgentPolicy,
  type AiAgentPolicySnapshot,
  type AiAgentRunProfile,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000e2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000e3';
const RUN_ID = '00000000-0000-4000-8000-0000000000e6';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000e4';
const SITE_ID = '00000000-0000-4000-8000-0000000000e7';

interface Hooks {
  getAuth?: () => unknown;
  pre?: (tool: string, input: Record<string, unknown>) => Promise<{ allowed: boolean; error?: string }>;
  post?: (
    tool: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// db mock (same harness shape as runLoop.research.test.ts)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  lastRow: {} as Record<string, unknown>,
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

vi.mock('./actRevalidation', () => ({ revalidateActExecution: vi.fn() }));
vi.mock('./actVerify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actVerify')>();
  return { ...actual, verifyActExecution: vi.fn(), recordActVerifyFailureAlert: vi.fn(async () => undefined) };
});
vi.mock('./playbookActExecutor', () => ({ executeBuiltInPlaybookForRun: vi.fn() }));

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
vi.mock('../aiAgentSdkTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiAgentSdkTools')>()),
  createBreezeMcpServer,
}));

const createActionIntent = vi.hoisted(() =>
  vi.fn<(auth: unknown, input: Record<string, unknown>) => Promise<{ id: string; status: string; errorCode: string | null }>>());
vi.mock('../actionIntents/intentService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../actionIntents/intentService')>()),
  createActionIntent,
}));

const resolveRecipientUserIds = vi.hoisted(() =>
  vi.fn<(agent: unknown, orgId: string) => Promise<string[]>>(async () => []));
vi.mock('./recipients', () => ({ resolveRecipientUserIds }));

const createNotification = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<string | null>>(async () => 'notification-1'));
vi.mock('../userNotifications', () => ({ createNotification }));

// The seam under test: a troubleshoot finish must never reach it.
const deliverRunFinishedNotifications = vi.hoisted(() => vi.fn<(runId: string) => Promise<void>>(async () => undefined));
vi.mock('./runFinishedNotify', () => ({ deliverRunFinishedNotifications }));

const enqueueAgentNotifyRetry = vi.hoisted(() => vi.fn<(runId: string) => Promise<void>>(async () => undefined));
vi.mock('../../jobs/agentNotifyRetryWorker', () => ({ enqueueAgentNotifyRetry }));

const scheduleFixWatch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
vi.mock('../../jobs/fixWatchWorker', () => ({ scheduleFixWatch }));

const resolveModel = vi.hoisted(() => vi.fn());
vi.mock('../aiModels/resolveModel', () => ({ resolveModel }));
vi.mock('../aiModels/settleInvocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiModels/settleInvocation')>()),
  settleInvocation: vi.fn(async () => ({ costCents: 0, invocationIds: [], deferred: false })),
}));

vi.mock('../streamingSessionManager', () => ({ buildClaudeSdkChildEnv: vi.fn(() => ({ CI: 'true' })) }));

vi.mock('../aiCostTracker', () => ({}));
const reserveAiBudget = vi.hoisted(() => vi.fn());
const markAiBudgetReservationIndeterminate = vi.hoisted(() => vi.fn());
vi.mock('../aiBudgetReservations', () => ({ reserveAiBudget, markAiBudgetReservationIndeterminate }));

vi.mock('./runProgress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runProgress')>()),
  emitRunProgress: vi.fn(async () => undefined),
}));

const grantMocks = vi.hoisted(() => ({ resolveGrantCeiling: vi.fn() }));
vi.mock('../wisp/grantAuthority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wisp/grantAuthority')>();
  return { ...actual, resolveGrantCeiling: grantMocks.resolveGrantCeiling };
});

import { executeAgentRun } from './runLoop';
import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import { GrantInactiveError, type GrantCeiling } from '../wisp/grantAuthority';
import type { AgentRunOutcome } from './runLoop';

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

function snapshot(effective: AiAgentPolicy, kind: 'troubleshoot' | 'triage'): AiAgentPolicySnapshot {
  return {
    schemaVersion: 7,
    agentId: AGENT_ID,
    kind,
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-09-12T00:00:00Z').toISOString(),
  };
}

function ceiling(): GrantCeiling {
  return {
    grantId: 'g1', revisionId: 'r1', partnerId: PARTNER_ID, grantorUserId: 'u1', scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG_ID]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active',
  };
}

const hooks: Hooks = {};
const closeMock = vi.fn();
const GRANT_DENIAL = 'delegation grant is no longer active';

function resultMessage() {
  return {
    type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: '', total_cost_usd: 0.05,
    usage: { input_tokens: 900, output_tokens: 200 },
  };
}

type Call = { tool: string; input: Record<string, unknown>; before?: () => void };

/** Drives the real pre/post hooks with the scripted calls, then ends cleanly. */
function scriptQuery(calls: Call[] = []) {
  queryMock.mockImplementation(() => {
    const generator = (async function* () {
      for (const call of calls) {
        call.before?.();
        const verdict = await hooks.pre!(call.tool, call.input);
        if (verdict.allowed) {
          await hooks.post!(call.tool, call.input, '{"status":"recorded"}', false, 5);
        } else {
          await hooks.post!(call.tool, call.input, JSON.stringify({ error: verdict.error }), true, 0);
        }
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } };
      yield resultMessage();
    })();
    return Object.assign(generator, { close: closeMock, interrupt: vi.fn() });
  });
}

/** Calls the first intent-minting tool, then (after the 15 s ceiling memo) a call under a dead grant. */
function mintThenGrantDies(): Call[] {
  return [
    { tool: 'set_device_context', input: { deviceId: DEVICE_ID, summary: 'Outlook profile corrupt' } },
    {
      tool: 'get_device_details',
      input: { deviceId: DEVICE_ID },
      before: () => {
        vi.setSystemTime(new Date(Date.now() + 16_000));
        grantMocks.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g1', 'paused'));
      },
    },
  ];
}

function finalTransition(): { to: string; patch: Record<string, unknown> } | undefined {
  const calls = transitionRunStatus.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) return undefined;
  return { to: last[2] as string, patch: (last[3] ?? {}) as Record<string, unknown> };
}

function seedRun(profile: AiAgentRunProfile) {
  const troubleshoot = profile === 'device_troubleshooting';
  const kind = troubleshoot ? 'troubleshoot' : 'triage';
  const effective = policy({ toolAllowlist: troubleshoot ? [] : ['get_device_details', 'set_device_context'] });
  dbMockState.rowQueues.ai_agent_runs = [[{
    id: RUN_ID, agentId: AGENT_ID, orgId: ORG_ID, deviceId: DEVICE_ID, alertId: null, ticketId: null,
    anomalyIncidentId: null, scheduleId: null, correlationGroupId: null, status: 'queued', modeAtStart: 'shadow',
    triggerKind: 'manual', policySnapshot: snapshot(effective, kind), profile,
    triggerRef: {}, grantId: 'g1', grantRevisionId: 'r1',
  }]];
  dbMockState.rowQueues.ai_agents = [[{
    id: AGENT_ID, orgId: null, partnerId: PARTNER_ID, name: 'Device troubleshooting (built-in)', kind,
    recipients: { userIds: [], roleIds: [] },
  }]];
  dbMockState.rowQueues.organizations = [[{ id: ORG_ID, partnerId: PARTNER_ID }]];
  dbMockState.rowQueues.devices = [[{ id: DEVICE_ID, siteId: SITE_ID, hostname: 'WS-01', osType: 'windows' }]];
  resolveEffectiveAgentSystem.mockResolvedValue(snapshot(effective, kind));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-01-05T00:00:00Z') });
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
  dbMockState.ambientContext = undefined;
  transitionRunStatus.mockResolvedValue(true);
  let execCounter = 0;
  createAgentRunSession.mockResolvedValue('session-1');
  startToolExecution.mockImplementation(async () => `exec-${++execCounter}`);
  completeToolExecution.mockResolvedValue(undefined);
  reconcileHungExecutions.mockResolvedValue(0);
  closeAgentRunSession.mockResolvedValue(undefined);
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
  resolveRecipientUserIds.mockResolvedValue([]);
  let intentSeq = 0;
  createActionIntent.mockImplementation(async () => ({ id: `intent-${++intentSeq}`, status: 'pending_approval', errorCode: null }));
  grantMocks.resolveGrantCeiling.mockReset().mockResolvedValue(ceiling());
  getCachedAiKillStateSnapshot.mockReturnValue({ killed: false, epoch: 0 });
  createBreezeMcpServer.mockImplementation((getAuth, pre, post) => {
    hooks.getAuth = getAuth;
    hooks.pre = pre;
    hooks.post = post;
    return { type: 'sdk', name: 'breeze', instance: {} };
  });
  scriptQuery();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('device_troubleshooting finish (#11084)', () => {
  it('a grant that went inactive mid-run finishes failed / grant_inactive, even with an intent already raised', async () => {
    seedRun('device_troubleshooting');
    scriptQuery(mintThenGrantDies());
    await executeAgentRun(RUN_ID);

    expect(createActionIntent).toHaveBeenCalledTimes(1);
    const final = finalTransition()!;
    const outcome = final.patch.outcome as AgentRunOutcome;
    expect(outcome.deniedActions).toEqual([expect.objectContaining({ tool: 'get_device_details', reason: GRANT_DENIAL })]);
    expect(final.patch.intentIds).toEqual(['intent-1']);
    expect(final.to).toBe('failed');
    expect(final.patch.errorCode).toBe('grant_inactive');
    expect(deliverRunFinishedNotifications).not.toHaveBeenCalled();
  });

  it('a clean finish with a pending intent is awaiting_approval, and delivers no notification', async () => {
    seedRun('device_troubleshooting');
    scriptQuery([{ tool: 'set_device_context', input: { deviceId: DEVICE_ID, summary: 'Outlook profile corrupt' } }]);
    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.patch.intentIds).toEqual(['intent-1']);
    expect(final.to).toBe('awaiting_approval');
    expect(final.patch.errorCode).toBeUndefined();
    expect(deliverRunFinishedNotifications).not.toHaveBeenCalled();
  });

  it('a clean finish with no intent is completed, and delivers no notification', async () => {
    seedRun('device_troubleshooting');
    scriptQuery([{ tool: 'get_device_details', input: { deviceId: DEVICE_ID } }]);
    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    expect(final.patch.intentIds ?? []).toEqual([]);
    expect(final.to).toBe('completed');
    expect(final.patch.errorCode).toBeUndefined();
    expect(deliverRunFinishedNotifications).not.toHaveBeenCalled();
  });

  it('control: the same grant denial on a full-profile run is NOT grant_inactive, and that run still notifies', async () => {
    seedRun('full');
    scriptQuery(mintThenGrantDies());
    await executeAgentRun(RUN_ID);

    const final = finalTransition()!;
    const outcome = final.patch.outcome as AgentRunOutcome;
    // The denial is real on this profile too ...
    expect(outcome.deniedActions.map((d) => d.reason)).toContain(GRANT_DENIAL);
    // ... but only a troubleshoot run reads it as "stopped by the grant".
    expect(final.patch.errorCode).not.toBe('grant_inactive');
    expect(final.to).not.toBe('failed');
    expect(deliverRunFinishedNotifications).toHaveBeenCalledWith(RUN_ID);
  });
});
