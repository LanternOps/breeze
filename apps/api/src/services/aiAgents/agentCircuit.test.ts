// apps/api/src/services/aiAgents/agentCircuit.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AI_AGENT_LIMIT_DEFAULTS, type AgentRunVerdict, type AiAgentRunStatus } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const AGENT_ID = '00000000-0000-4000-8000-0000000000c2';
const RUN_ID = '00000000-0000-4000-8000-0000000000c3';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000c4';
const USER_ID = '00000000-0000-4000-8000-0000000000c5';

const state = vi.hoisted(() => ({
  executed: [] as SQL[],
  selectQueue: [] as unknown[][],
  insertReturningQueue: [] as unknown[][],
  updateReturningQueue: [] as unknown[][],
  insertValues: [] as Record<string, unknown>[],
  updateSets: [] as Record<string, unknown>[],
  updateWheres: [] as unknown[],
  selectCount: 0,
  insertCount: 0,
  updateCount: 0,
}));

function resetDbState(): void {
  state.executed = [];
  state.selectQueue = [];
  state.insertReturningQueue = [];
  state.updateReturningQueue = [];
  state.insertValues = [];
  state.updateSets = [];
  state.updateWheres = [];
  state.selectCount = 0;
  state.insertCount = 0;
  state.updateCount = 0;
}

vi.mock('../../db', () => {
  function selectBuilder() {
    state.selectCount += 1;
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            if (state.selectQueue.length === 0) throw new Error('no queued select rows');
            return state.selectQueue.shift();
          })
          .then(resolve, reject),
    };
    return builder;
  }

  function insertBuilder() {
    state.insertCount += 1;
    const builder: Record<string, unknown> = {
      values: vi.fn((v: Record<string, unknown>) => {
        state.insertValues.push(v);
        return builder;
      }),
      onConflictDoUpdate: vi.fn(() => builder),
      returning: vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(state.insertReturningQueue.shift() ?? []).then(resolve, reject),
      })),
    };
    return builder;
  }

  function updateBuilder() {
    state.updateCount += 1;
    const builder: Record<string, unknown> = {
      set: vi.fn((v: Record<string, unknown>) => {
        state.updateSets.push(v);
        return builder;
      }),
      where: vi.fn((w: unknown) => {
        state.updateWheres.push(w);
        return builder;
      }),
      returning: vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(state.updateReturningQueue.shift() ?? []).then(resolve, reject),
      })),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  }

  return {
    db: {
      execute: vi.fn(async (stmt: SQL) => {
        state.executed.push(stmt);
        return [];
      }),
      select: vi.fn(() => selectBuilder()),
      insert: vi.fn(() => insertBuilder()),
      update: vi.fn(() => updateBuilder()),
    },
    // Always report system scope: `inSystemDbContext`'s escape-then-system
    // branching is exercised elsewhere (runService.test.ts); this file is
    // about circuit logic, not context plumbing.
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

const resolveEffectiveAgentSystemMock = vi.fn();
vi.mock('./effectivePolicy', () => ({
  resolveEffectiveAgentSystem: (...args: unknown[]) => resolveEffectiveAgentSystemMock(...args),
}));

const resolveRecipientUserIdsMock = vi.fn();
vi.mock('./recipients', () => ({
  resolveRecipientUserIds: (...args: unknown[]) => resolveRecipientUserIdsMock(...args),
}));

const createNotificationMock = vi.fn();
vi.mock('../userNotifications', () => ({
  createNotification: (...args: unknown[]) => createNotificationMock(...args),
}));

const createAuditLogAsyncMock = vi.fn();
vi.mock('../auditService', () => ({
  createAuditLogAsync: (...args: unknown[]) => createAuditLogAsyncMock(...args),
}));

const publishEventMock = vi.fn();
vi.mock('../eventBus', () => ({
  EVENT_TYPES: { AI_AGENT_CIRCUIT_OPENED: 'ai.agent.circuit.opened' },
  publishEvent: (...args: unknown[]) => publishEventMock(...args),
}));

import {
  classifyTerminal,
  getCircuitState,
  isCircuitOpen,
  isTerminalRunStatus,
  recordRunTerminal,
  resetCircuit,
} from './agentCircuit';

const dialect = new PgDialect();

function agentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'patch',
    name: 'Patch Agent',
    orgId: null,
    partnerId: PARTNER_ID,
    recipients: { userIds: [USER_ID] },
    ...overrides,
  };
}

function circuitRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orgId: ORG_ID,
    agentId: AGENT_ID,
    partnerId: PARTNER_ID,
    consecutiveFailures: 1,
    state: 'closed',
    openedAt: null,
    openedReason: null,
    lastRunId: RUN_ID,
    lastTransitionAt: new Date('2026-08-28T00:00:00Z'),
    resetBy: null,
    resetAt: null,
    ...overrides,
  };
}

function resolvedPolicy(maxConsecutiveFailures: number) {
  return { effective: { limits: { maxConsecutiveFailures } } };
}

beforeEach(() => {
  resetDbState();
  resolveEffectiveAgentSystemMock.mockReset();
  resolveRecipientUserIdsMock.mockReset().mockResolvedValue([]);
  createNotificationMock.mockReset().mockResolvedValue('notif-id');
  createAuditLogAsyncMock.mockReset().mockResolvedValue(undefined);
  publishEventMock.mockReset().mockResolvedValue('event-id');
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// classifyTerminal — pure, exhaustive over every AiAgentRunStatus the
// AiAgentRunStatus union carries.
// ---------------------------------------------------------------------------
describe('classifyTerminal', () => {
  const NEEDS_ATTENTION: AgentRunVerdict = 'needs_attention';
  const REMEDIATED: AgentRunVerdict = 'remediated';

  it('increments on a completed run flagged needs_attention', () => {
    expect(classifyTerminal('completed', null, NEEDS_ATTENTION)).toBe('increment');
  });

  it('resets on a clean completed run (no verdict)', () => {
    expect(classifyTerminal('completed', null, null)).toBe('reset');
  });

  it('resets on a completed run with any non-needs_attention verdict', () => {
    expect(classifyTerminal('completed', null, REMEDIATED)).toBe('reset');
    expect(classifyTerminal('completed', null, 'partial')).toBe('reset');
    expect(classifyTerminal('completed', null, 'no_action')).toBe('reset');
  });

  it('resets on awaiting_approval regardless of errorCode/verdict', () => {
    expect(classifyTerminal('awaiting_approval', null, null)).toBe('reset');
  });

  it.each([
    'sdk_error', 'sdk_output_error',
    'wall_clock_exceeded', 'budget_exceeded', 'max_turns_exceeded',
    'llm_unavailable', 'ownership_mismatch', 'run_failed',
  ])('increments on failed with runner/ceiling code %s', (code) => {
    expect(classifyTerminal('failed', code, null)).toBe('increment');
  });

  it('is neutral on failed:stalled — infrastructure, not the agent', () => {
    expect(classifyTerminal('failed', 'stalled', null)).toBe('neutral');
  });

  it('is neutral on failed:enqueue_failed — infrastructure, not the agent', () => {
    expect(classifyTerminal('failed', 'enqueue_failed', null)).toBe('neutral');
  });

  it('is neutral on failed with an unrecognized errorCode (safe default)', () => {
    expect(classifyTerminal('failed', 'some_future_code', null)).toBe('neutral');
  });

  it('is neutral on failed with a null errorCode', () => {
    expect(classifyTerminal('failed', null, null)).toBe('neutral');
  });

  it.each(['cancelled', 'expired', 'skipped'] as const)('is neutral on %s', (status) => {
    expect(classifyTerminal(status, null, null)).toBe('neutral');
  });

  it('is neutral on the two non-terminal statuses (defensive default)', () => {
    expect(classifyTerminal('queued', null, null)).toBe('neutral');
    expect(classifyTerminal('running', null, null)).toBe('neutral');
  });
});

describe('classifyTerminal with run profile (P2-1)', () => {
  it('a verdict completion never resets the streak', () => {
    expect(classifyTerminal('completed', null, null, 'verdict')).toBe('neutral');
    expect(classifyTerminal('completed', null, 'needs_attention', 'verdict')).toBe('neutral');
    expect(classifyTerminal('failed', 'sdk_error', null, 'verdict')).toBe('increment');
    expect(classifyTerminal('completed', null, null, 'full')).toBe('reset');
  });
});

// Phase 2 wave P2-2 (scheduled sweeps) — a clean sweep must NOT reset an
// org's failure streak (design-review ruling): unlike `verdict`, a sweep's
// job is read-only reconnaissance, not remediation, so its success says
// nothing about the org's remediation health either way. `failed` is
// unaffected by profile in every case — the runner/ceiling allowlist is the
// only thing that decides `increment` vs `neutral` there.
describe('classifyTerminal with run profile (P2-2 sweep)', () => {
  it('a sweep completion never resets the streak, clean or needs_attention', () => {
    expect(classifyTerminal('completed', null, 'no_action', 'sweep')).toBe('neutral');
    expect(classifyTerminal('completed', null, 'needs_attention', 'sweep')).toBe('neutral');
  });

  it('awaiting_approval on a sweep run is neutral, not reset', () => {
    expect(classifyTerminal('awaiting_approval', null, null, 'sweep')).toBe('neutral');
  });

  it('a genuine failure still increments on a sweep run', () => {
    // 'sdk_error' is a real INCREMENT_FAILURE_ERROR_CODES entry (the brief's
    // placeholder 'runner_error' is not — see agentCircuit.ts's allowlist).
    expect(classifyTerminal('failed', 'sdk_error', null, 'sweep')).toBe('increment');
  });
});

// Phase 2 wave P2-3 (weekly org narrative) — same ruling as `sweep`, and for
// a stronger version of the same reason: a narrative run does not even read
// live data, it summarises a pre-collected week of it. Its clean completion
// therefore says nothing at all about the org's remediation health and must
// never reset the streak; a genuine runner/ceiling failure still increments.
//
// `classifyTerminal` compares `profile` as a STRING with no exhaustive
// `never` guard anywhere in the function, so nothing about adding
// 'narrative' to `AI_AGENT_RUN_PROFILES` would have failed to compile if the
// branch below were missing — the profile would silently have inherited
// `full`'s reset/increment behaviour. These rows ARE the guard.
describe('classifyTerminal with run profile (P2-3 narrative)', () => {
  it('a narrative completion never resets the streak, clean or needs_attention', () => {
    expect(classifyTerminal('completed', null, null, 'narrative')).toBe('neutral');
    expect(classifyTerminal('completed', null, 'no_action', 'narrative')).toBe('neutral');
    expect(classifyTerminal('completed', null, 'needs_attention', 'narrative')).toBe('neutral');
  });

  it('awaiting_approval on a narrative run is neutral, not reset', () => {
    expect(classifyTerminal('awaiting_approval', null, null, 'narrative')).toBe('neutral');
  });

  it('a genuine failure still increments on a narrative run', () => {
    expect(classifyTerminal('failed', 'sdk_error', null, 'narrative')).toBe('increment');
    expect(classifyTerminal('failed', 'budget_exceeded', null, 'narrative')).toBe('increment');
    expect(classifyTerminal('failed', 'max_turns_exceeded', null, 'narrative')).toBe('increment');
  });

  it('an off-allowlist failure is still neutral on a narrative run', () => {
    expect(classifyTerminal('failed', 'stalled', null, 'narrative')).toBe('neutral');
    expect(classifyTerminal('failed', null, null, 'narrative')).toBe('neutral');
  });

  it('cancelled/expired/skipped stay neutral on a narrative run', () => {
    expect(classifyTerminal('cancelled', null, null, 'narrative')).toBe('neutral');
    expect(classifyTerminal('expired', null, null, 'narrative')).toBe('neutral');
    expect(classifyTerminal('skipped', null, null, 'narrative')).toBe('neutral');
  });

  it('does not disturb the full profile it shares the string compare with', () => {
    expect(classifyTerminal('completed', null, null, 'full')).toBe('reset');
    expect(classifyTerminal('awaiting_approval', null, null, 'full')).toBe('reset');
    expect(classifyTerminal('completed', null, 'needs_attention', 'full')).toBe('increment');
  });
});

// Phase 2 wave P2-4 (ticket triage, #4191) — same ruling as `verdict`/
// `sweep`/`narrative`, and for the same-shaped reason as `narrative`: a
// triage run does not read any live data (its whole input is the
// system-assembled ticket context, `ticketContext.ts`) and its clean
// completion is a PROPOSAL a human still has to accept — it says nothing
// about whether the org's remediation is working, so it must never reset
// (or increment) the streak either way. A genuine runner/ceiling failure
// still increments, exactly as for every other profile.
//
// `classifyTerminal` compares `profile` as a STRING with no exhaustive
// `never` guard anywhere in the function, so nothing about adding 'triage'
// to `AI_AGENT_RUN_PROFILES` would have failed to compile if the branch
// below were missing — the profile would silently have inherited `full`'s
// reset/increment behaviour. These rows ARE the guard.
describe('classifyTerminal with run profile (P2-4 triage)', () => {
  it('a triage completion never resets the streak, clean or needs_attention', () => {
    expect(classifyTerminal('completed', null, null, 'triage')).toBe('neutral');
    expect(classifyTerminal('completed', null, 'no_action', 'triage')).toBe('neutral');
    expect(classifyTerminal('completed', null, 'needs_attention', 'triage')).toBe('neutral');
  });

  it('awaiting_approval on a triage run is neutral, not reset', () => {
    expect(classifyTerminal('awaiting_approval', null, null, 'triage')).toBe('neutral');
  });

  it('a genuine failure still increments on a triage run', () => {
    expect(classifyTerminal('failed', 'sdk_error', null, 'triage')).toBe('increment');
    expect(classifyTerminal('failed', 'budget_exceeded', null, 'triage')).toBe('increment');
    expect(classifyTerminal('failed', 'max_turns_exceeded', null, 'triage')).toBe('increment');
  });

  it('an off-allowlist failure is still neutral on a triage run', () => {
    expect(classifyTerminal('failed', 'stalled', null, 'triage')).toBe('neutral');
    expect(classifyTerminal('failed', null, null, 'triage')).toBe('neutral');
  });

  it('cancelled/expired/skipped stay neutral on a triage run', () => {
    expect(classifyTerminal('cancelled', null, null, 'triage')).toBe('neutral');
    expect(classifyTerminal('expired', null, null, 'triage')).toBe('neutral');
    expect(classifyTerminal('skipped', null, null, 'triage')).toBe('neutral');
  });

  it('does not disturb the full profile it shares the string compare with', () => {
    expect(classifyTerminal('completed', null, null, 'full')).toBe('reset');
    expect(classifyTerminal('awaiting_approval', null, null, 'full')).toBe('reset');
    expect(classifyTerminal('completed', null, 'needs_attention', 'full')).toBe('increment');
  });
});

describe('isTerminalRunStatus', () => {
  it('is false for queued/running only', () => {
    expect(isTerminalRunStatus('queued')).toBe(false);
    expect(isTerminalRunStatus('running')).toBe(false);
  });

  it.each(['completed', 'failed', 'cancelled', 'expired', 'skipped', 'awaiting_approval'] as AiAgentRunStatus[])(
    'is true for %s',
    (status) => {
      expect(isTerminalRunStatus(status)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// recordRunTerminal
// ---------------------------------------------------------------------------
describe('recordRunTerminal', () => {
  const run = { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, profile: 'full' as const };

  it('neutral classification touches no DB at all', async () => {
    await recordRunTerminal(run, 'failed', 'stalled', null);
    expect(state.executed).toHaveLength(0);
    expect(state.selectCount).toBe(0);
    expect(state.insertCount).toBe(0);
    expect(state.updateCount).toBe(0);
  });

  it('reset classification takes the lock and zeroes the counter without reading the agent/org', async () => {
    await recordRunTerminal(run, 'completed', null, null);

    expect(state.executed).toHaveLength(1);
    const lock = dialect.sqlToQuery(state.executed[0]!);
    expect(lock.sql).toContain('pg_advisory_xact_lock');
    expect(lock.params).toContain(`ai-circuit:${ORG_ID}:${AGENT_ID}`);

    expect(state.selectCount).toBe(0);
    expect(state.insertCount).toBe(0);
    expect(state.updateCount).toBe(1);
    expect(state.updateSets[0]).toMatchObject({ consecutiveFailures: 0, lastRunId: RUN_ID });
  });

  it('increment below threshold: upserts the counter, opens nothing, notifies nobody', async () => {
    state.selectQueue.push([agentRow()]); // aiAgents lookup
    state.selectQueue.push([{ partnerId: PARTNER_ID }]); // organizations lookup
    state.insertReturningQueue.push([circuitRow({ consecutiveFailures: 2, state: 'closed' })]);
    resolveEffectiveAgentSystemMock.mockResolvedValue(resolvedPolicy(3));

    await recordRunTerminal(run, 'failed', 'sdk_error', null);

    expect(state.updateCount).toBe(0); // no open-transition update attempted
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(createAuditLogAsyncMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('increment at threshold opens the circuit exactly once, then notifies + audits', async () => {
    state.selectQueue.push([agentRow()]);
    state.selectQueue.push([{ partnerId: PARTNER_ID }]);
    state.insertReturningQueue.push([circuitRow({ consecutiveFailures: 3, state: 'closed' })]);
    state.updateReturningQueue.push([circuitRow({ consecutiveFailures: 3, state: 'open', openedAt: new Date() })]);
    resolveEffectiveAgentSystemMock.mockResolvedValue(resolvedPolicy(3));
    resolveRecipientUserIdsMock.mockResolvedValue([USER_ID]);

    await recordRunTerminal(run, 'failed', 'sdk_error', null);

    expect(state.updateCount).toBe(1);
    expect(state.updateSets[0]).toMatchObject({ state: 'open' });
    // The CAS guard: the open-transition update targets state='closed'.
    const openWhere = dialect.sqlToQuery(state.updateWheres[0] as SQL).sql;
    expect(openWhere).toContain('=');

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      orgId: ORG_ID,
      dedupeKey: `circuit-open-${ORG_ID}-${AGENT_ID}-${RUN_ID}`,
      priority: 'high',
    }));
    expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      action: 'ai_agent.circuit_opened',
      resourceId: AGENT_ID,
      actorType: 'system',
    }));

    // #4205 — first-class registered event so webhooks/automations can react,
    // not just the notification + audit row.
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock).toHaveBeenCalledWith(
      'ai.agent.circuit.opened',
      ORG_ID,
      expect.objectContaining({
        agentId: AGENT_ID,
        orgId: ORG_ID,
        triggeringRunId: RUN_ID,
        consecutiveFailures: 3,
        threshold: 3,
      }),
      expect.any(String),
    );
  });

  it('opens exactly once: a second increment landing on an already-open row notifies nobody again', async () => {
    state.selectQueue.push([agentRow()]);
    state.selectQueue.push([{ partnerId: PARTNER_ID }]);
    // The upsert itself reports the row as ALREADY open (a prior transition
    // already flipped it) — recordRunTerminal must not attempt to reopen it
    // or fire a second notification.
    state.insertReturningQueue.push([circuitRow({ consecutiveFailures: 4, state: 'open' })]);

    await recordRunTerminal(run, 'failed', 'sdk_error', null);

    expect(state.updateCount).toBe(0);
    expect(resolveEffectiveAgentSystemMock).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(createAuditLogAsyncMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('opens exactly once: the CAS losing to a concurrent opener suppresses this notify', async () => {
    state.selectQueue.push([agentRow()]);
    state.selectQueue.push([{ partnerId: PARTNER_ID }]);
    state.insertReturningQueue.push([circuitRow({ consecutiveFailures: 3, state: 'closed' })]);
    // Simulate losing the open-transition CAS: the targeted UPDATE affects
    // zero rows because a concurrent call already flipped state to 'open'.
    state.updateReturningQueue.push([]);
    resolveEffectiveAgentSystemMock.mockResolvedValue(resolvedPolicy(3));

    await recordRunTerminal(run, 'failed', 'sdk_error', null);

    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(createAuditLogAsyncMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('falls back to the shared default threshold when no effective policy resolves', async () => {
    state.selectQueue.push([agentRow()]);
    state.selectQueue.push([{ partnerId: PARTNER_ID }]);
    state.insertReturningQueue.push([circuitRow({
      consecutiveFailures: AI_AGENT_LIMIT_DEFAULTS.maxConsecutiveFailures, state: 'closed',
    })]);
    state.updateReturningQueue.push([circuitRow({ state: 'open' })]);
    resolveEffectiveAgentSystemMock.mockResolvedValue(null);

    await recordRunTerminal(run, 'failed', 'sdk_error', null);

    expect(state.updateCount).toBe(1);
  });

  it('does nothing when the agent row no longer exists (deleted between run and transition)', async () => {
    state.selectQueue.push([]); // aiAgents lookup returns nothing

    await recordRunTerminal(run, 'failed', 'sdk_error', null);

    expect(state.insertCount).toBe(0);
    expect(state.updateCount).toBe(0);
  });

  it('a second open episode (a different triggering run) gets a DIFFERENT dedupeKey than the first', async () => {
    state.selectQueue.push([agentRow()]);
    state.selectQueue.push([{ partnerId: PARTNER_ID }]);
    state.insertReturningQueue.push([circuitRow({ consecutiveFailures: 3, state: 'closed' })]);
    state.updateReturningQueue.push([circuitRow({ consecutiveFailures: 3, state: 'open', openedAt: new Date() })]);
    resolveEffectiveAgentSystemMock.mockResolvedValue(resolvedPolicy(3));
    resolveRecipientUserIdsMock.mockResolvedValue([USER_ID]);

    await recordRunTerminal(run, 'failed', 'sdk_error', null);
    const firstDedupeKey = createNotificationMock.mock.calls[0]?.[0]?.dedupeKey as string;

    // A human resets the circuit with MFA, then it opens again later off a
    // SECOND triggering run — this must notify again, not go silent.
    resetDbState();
    createNotificationMock.mockClear();
    createAuditLogAsyncMock.mockClear();
    const secondRun = { id: '00000000-0000-4000-8000-0000000000c6', orgId: ORG_ID, agentId: AGENT_ID, profile: 'full' as const };
    state.selectQueue.push([agentRow()]);
    state.selectQueue.push([{ partnerId: PARTNER_ID }]);
    state.insertReturningQueue.push([circuitRow({ consecutiveFailures: 3, state: 'closed' })]);
    state.updateReturningQueue.push([circuitRow({ consecutiveFailures: 3, state: 'open', openedAt: new Date() })]);
    resolveEffectiveAgentSystemMock.mockResolvedValue(resolvedPolicy(3));
    resolveRecipientUserIdsMock.mockResolvedValue([USER_ID]);

    await recordRunTerminal(secondRun, 'failed', 'sdk_error', null);
    const secondDedupeKey = createNotificationMock.mock.calls[0]?.[0]?.dedupeKey as string;

    expect(firstDedupeKey).toBeTruthy();
    expect(secondDedupeKey).toBeTruthy();
    expect(secondDedupeKey).not.toBe(firstDedupeKey);
  });
});

// ---------------------------------------------------------------------------
// isCircuitOpen / getCircuitState / resetCircuit
// ---------------------------------------------------------------------------
describe('isCircuitOpen', () => {
  it('is false when no row exists', async () => {
    state.selectQueue.push([]);
    expect(await isCircuitOpen(ORG_ID, AGENT_ID)).toBe(false);
  });

  it('is true only when state is open', async () => {
    state.selectQueue.push([{ state: 'open' }]);
    expect(await isCircuitOpen(ORG_ID, AGENT_ID)).toBe(true);
  });

  it('is false when state is closed', async () => {
    state.selectQueue.push([{ state: 'closed' }]);
    expect(await isCircuitOpen(ORG_ID, AGENT_ID)).toBe(false);
  });
});

describe('getCircuitState', () => {
  it('returns a closed/zero default snapshot for a never-tripped pair', async () => {
    state.selectQueue.push([]);
    const snapshot = await getCircuitState(ORG_ID, AGENT_ID);
    expect(snapshot).toMatchObject({ orgId: ORG_ID, agentId: AGENT_ID, state: 'closed', consecutiveFailures: 0 });
  });

  it('projects a real row into ISO timestamps', async () => {
    state.selectQueue.push([circuitRow({ consecutiveFailures: 5, state: 'open', openedAt: new Date('2026-08-27T12:00:00Z') })]);
    const snapshot = await getCircuitState(ORG_ID, AGENT_ID);
    expect(snapshot.state).toBe('open');
    expect(snapshot.consecutiveFailures).toBe(5);
    expect(snapshot.openedAt).toBe('2026-08-27T12:00:00.000Z');
  });
});

describe('resetCircuit', () => {
  it('takes the lock and closes the circuit, zeroing the counter and stamping resetBy/resetAt', async () => {
    state.updateReturningQueue.push([circuitRow({
      state: 'closed', consecutiveFailures: 0, resetBy: USER_ID, resetAt: new Date('2026-08-28T01:00:00Z'),
    })]);

    const snapshot = await resetCircuit(ORG_ID, AGENT_ID, USER_ID);

    expect(state.executed).toHaveLength(1);
    const lock = dialect.sqlToQuery(state.executed[0]!);
    expect(lock.sql).toContain('pg_advisory_xact_lock');
    expect(state.updateSets[0]).toMatchObject({
      state: 'closed', consecutiveFailures: 0, openedAt: null, openedReason: null, resetBy: USER_ID,
    });
    expect(snapshot.state).toBe('closed');
    expect(snapshot.resetBy).toBe(USER_ID);
  });

  it('returns the closed/zero default when there was nothing to reset', async () => {
    state.updateReturningQueue.push([]);
    const snapshot = await resetCircuit(ORG_ID, AGENT_ID, USER_ID);
    expect(snapshot).toMatchObject({ state: 'closed', consecutiveFailures: 0, resetBy: null });
  });
});

// ---------------------------------------------------------------------------
// "Config edits (agentService update) must NOT touch circuit rows" — plan
// Task 2's own guardrail bullet. `resetCircuit` above is the ONLY writer of
// `state: 'closed'`; a config edit (mode/limits/recipients change) reaching
// `ai_agent_circuit_state` at all — even a well-meaning "clear the counter on
// save" — would let an operator silently reopen admission for an org whose
// agent is mid-incident without ever going through the MFA reset route. A
// source-scan proves this structurally rather than by exhaustively testing
// every field `updateAgent` accepts.
// ---------------------------------------------------------------------------
describe('config edits never touch circuit rows (wave-6 quorum: manual MFA reset only)', () => {
  it('agentService.ts (agent create/update/disable) never references aiAgentCircuitState or agentCircuit.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const agentServicePath = fileURLToPath(new URL('./agentService.ts', import.meta.url));
    const src = readFileSync(agentServicePath, 'utf8');
    expect(src).not.toMatch(/aiAgentCircuitState/);
    expect(src).not.toMatch(/from ['"]\.\/agentCircuit['"]/);
  });
});
